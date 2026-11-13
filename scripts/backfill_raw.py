#!/usr/bin/env python3
"""Raw backfill of one Polymarket wallet (Data API v2 + Gamma). Stdlib only.

Outputs (in --out, default ../data/raw relative to this script):
  trades.jsonl    every /v2/trades row (taker_only=false), oldest first, plus `_taker` (bool)
  activity.jsonl  every /v2/activity row, all types incl. DEPOSIT/WITHDRAWAL/TIP, oldest first
  positions.json  {"_meta": {...}, "positions": [...]}  OPEN (superset) + CLOSED
  markets.jsonl   one Gamma market object per distinct condition_id, plus `_event`
  MANIFEST.md     row counts, time range, cross-checks, gaps

Idempotent: every run rewrites each file atomically from (kept rows + refetched window);
running twice with the same cutoff yields byte-identical feed files.
Incremental: if trades.jsonl / activity.jsonl exist, only the window
[max(timestamp) - --overlap, cutoff] is refetched and replaces the stored rows of that window
(rows are ordered by chain position, so window replacement is exact; no dedup key needed).
Use --full to re-walk the whole history (about 30 requests for this wallet).
Resumable: an interrupted feed walk leaves `.<name>.part` (pages + next cursor) and the next run
adopts its cutoff and continues from that cursor; part files are deleted when the walk completes.
markets.jsonl is checkpointed every few batches and final (closed + resolved) markets are never
refetched.

See docs/API_NOTES.md for the API facts this relies on.
"""
import argparse
import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter, defaultdict

DATA = "https://data-api.polymarket.com/v2"
GAMMA = "https://gamma-api.polymarket.com"
DEFAULT_USER = "0xc9bfc7986767173b4f1c3fc9b2c6b255fc7381c0"
ALL_TYPES = ("TRADE,SPLIT,MERGE,REDEEM,CONVERSION,MIGRATION,REWARD,YIELD,MAKER_REBATE,TAKER_REBATE,"
             "REFERRAL_REWARD,DEPOSIT,WITHDRAWAL,DIRECTIONAL_SPLIT,DIRECTIONAL_MERGE,"
             "THRESHOLD_COMPOSE,THRESHOLD_DECOMPOSE,TIP")
EVENT_KEYS = ("id", "slug", "ticker", "title", "seriesSlug", "startTime", "startDate", "endDate",
              "eventDate", "closed", "closedTime", "live", "ended", "score", "period", "gameId",
              "eventMetadata", "negRisk")
REQUESTS = Counter()


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, file=sys.stderr, flush=True)


def http_get(url, params=None, tries=7):
    """GET JSON. Returns (status, body). Retries 429/5xx/network errors with backoff."""
    if params:
        url += ("&" if "?" in url else "?") + urllib.parse.urlencode(params, doseq=True)
    host = urllib.parse.urlsplit(url).netloc
    delay = 1.0
    for attempt in range(tries):
        REQUESTS[host] += 1
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "raw-backfill/1.0",
                                                       "Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", "replace")[:400]
            if e.code == 429 or e.code >= 500:
                wait = float(e.headers.get("Retry-After") or delay)
                log(f"HTTP {e.code} from {host}, retry in {wait:.1f}s")
                time.sleep(wait)
                delay = min(delay * 2, 60)
                continue
            return e.code, body
        except (urllib.error.URLError, TimeoutError, ConnectionError, json.JSONDecodeError) as e:
            log(f"network error {e!r}, retry in {delay:.1f}s")
            time.sleep(delay)
            delay = min(delay * 2, 60)
    raise RuntimeError(f"giving up on {url}")


def atomic_write(path, text):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(text)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def dumps(o):
    return json.dumps(o, ensure_ascii=False, separators=(",", ":"))


def read_jsonl(path):
    if not os.path.exists(path):
        return []
    with open(path, encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


def write_jsonl(path, rows):
    atomic_write(path, "".join(dumps(r) + "\n" for r in rows))


def walk(out_dir, name, path, params, sleep):
    """Cursor-walk a v2 endpoint; returns rows in served order. Resumes from `.<name>.part`."""
    sig = hashlib.sha1(dumps([path, sorted(params.items())]).encode()).hexdigest()
    part = os.path.join(out_dir, f".{name}.part")
    rows, cursor, pages = [], None, 0
    if os.path.exists(part):
        try:
            lines = read_jsonl(part)
        except ValueError:
            lines = []
        if lines and lines[0].get("sig") == sig:
            for pg in lines[1:]:
                rows += pg["rows"]
                cursor = pg["next_cursor"]
                pages += 1
            if pages and cursor is None:      # walk had finished; just reuse it
                os.remove(part)
                return rows
            log(f"{name}: resuming after {pages} pages / {len(rows)} rows")
        else:
            os.remove(part)
    if not os.path.exists(part):
        atomic_write(part, dumps({"sig": sig, "params": params}) + "\n")
    while True:
        p = dict(params)
        if cursor:
            p["cursor"] = cursor
        status, body = http_get(DATA + path, p)
        if status != 200:
            if cursor and status == 400:       # stale/invalid cursor: restart this walk
                log(f"{name}: cursor rejected ({body}); restarting walk")
                os.remove(part)
                return walk(out_dir, name, path, params, sleep)
            raise RuntimeError(f"{path} -> HTTP {status}: {body}")
        page = body["data"]
        cursor = body["pagination"]["next_cursor"]
        rows += page
        pages += 1
        with open(part, "a", encoding="utf-8") as f:
            f.write(dumps({"next_cursor": cursor, "rows": page}) + "\n")
        if not cursor:
            break
        time.sleep(sleep)
    os.remove(part)
    log(f"{name}: {len(rows)} rows in {pages} pages")
    return rows


def fill_key(r):
    return (r["transaction_hash"], r["token_id"], r["side"], r["price"], r["size"])


def backfill_feed(args, name, path, extra, cutoff):
    """Returns all rows oldest-first after merging the refetched window into the stored file."""
    target = os.path.join(args.out, name + ".jsonl")
    old = [] if args.full else read_jsonl(target)
    start = 1                                   # start=1 == full history (0/omitted == 3 years)
    if old:
        start = max(1, max(r["timestamp"] for r in old) - args.overlap)
    params = {"user": args.user, "limit": 1000, "start": start, "end": cutoff, **extra}
    new = walk(args.out, name, path, params, args.sleep)[::-1]      # served newest-first
    kept = [r for r in old if r["timestamp"] < start]
    return kept, new, start


def do_trades(args, cutoff):
    kept, new, start = backfill_feed(args, "trades", "/trades", {"taker_only": "false"}, cutoff)
    # taker_only=true (the API default) returns only the rows where the wallet was the taker
    takers = walk(args.out, "trades_taker", "/trades",
                  {"user": args.user, "limit": 1000, "start": start, "end": cutoff,
                   "taker_only": "true"}, args.sleep)
    tk = Counter(fill_key(r) for r in takers)
    for r in new:
        k = fill_key(r)
        r["_taker"] = tk[k] > 0
        if tk[k] > 0:
            tk[k] -= 1
    unmatched = sum(tk.values())
    rows = kept + new
    write_jsonl(os.path.join(args.out, "trades.jsonl"), rows)
    return rows, {"window_start": start, "refetched": len(new), "kept": len(kept),
                  "taker_rows_unmatched": unmatched}


def do_activity(args, cutoff):
    kept, new, start = backfill_feed(args, "activity", "/activity",
                                     {"type": ALL_TYPES, "exclude_deposits_withdrawals": "false"},
                                     cutoff)
    rows = kept + new
    write_jsonl(os.path.join(args.out, "activity.jsonl"), rows)
    return rows, {"window_start": start, "refetched": len(new), "kept": len(kept)}


def do_positions(args):
    by_token = {}
    counts = {}
    for status, extra in (("OPEN", {"include_archived": "true", "filter_amount": 0}),
                          ("CLOSED", {})):
        rows = walk(args.out, "positions_" + status.lower(), "/positions",
                    {"user": args.user, "limit": 1000, "status": status, **extra}, args.sleep)
        counts[status] = len(rows)
        for r in rows:                          # CLOSED walked last, so it wins a race
            by_token[r["token_id"]] = r
    positions = sorted(by_token.values(),
                       key=lambda r: (r.get("first_entry_at", 0), r["token_id"]))
    meta = {"user": args.user, "fetched_at": int(time.time()),
            "requested": {"OPEN": "status=OPEN&include_archived=true&filter_amount=0",
                          "CLOSED": "status=CLOSED"},
            "rows_per_request": counts,
            "status_counts": dict(Counter(r["status"] for r in positions))}
    atomic_write(os.path.join(args.out, "positions.json"),
                 json.dumps({"_meta": meta, "positions": positions}, ensure_ascii=False, indent=1))
    return positions, meta


def market_final(m):
    return bool(m.get("closed")) and m.get("umaResolutionStatus") == "resolved"


def do_markets(args, condition_ids):
    target = os.path.join(args.out, "markets.jsonl")
    have = {} if args.full else {m["conditionId"].lower(): m for m in read_jsonl(target)}
    todo = [c for c in condition_ids if c not in have or not market_final(have[c])]
    log(f"markets: {len(condition_ids)} conditions, {len(todo)} to (re)fetch")
    fetched = {}
    # Gamma /markets hides closed markets unless closed=true, and closed=true hides open ones;
    # ids must be repeated params (comma lists return nothing); default limit is 20.
    for closed in ("true", "false"):
        pending = [c for c in todo if c not in fetched]
        for i in range(0, len(pending), args.batch):
            chunk = pending[i:i + args.batch]
            status, body = http_get(GAMMA + "/markets", {"condition_ids": chunk, "closed": closed,
                                                         "limit": len(chunk) * 2})
            if status != 200:
                raise RuntimeError(f"gamma /markets -> HTTP {status}: {body}")
            for m in body:
                fetched[m["conditionId"].lower()] = m
            time.sleep(args.sleep)
            # checkpoint so an interrupted run keeps what it already has
            if (i // args.batch) % 5 == 4:
                _write_markets(target, {**have, **fetched})
    have.update(fetched)
    _write_markets(target, have)
    missing = [c for c in condition_ids if c not in have]
    return [have[c] for c in condition_ids if c in have], missing


def _write_markets(target, by_cond):
    rows = []
    for m in by_cond.values():
        ev = (m.get("events") or [{}])[0]
        m["_event"] = {k: ev.get(k) for k in EVENT_KEYS}
        rows.append(m)
    rows.sort(key=lambda m: (m["_event"].get("startTime") or m.get("gameStartTime") or "",
                             m.get("slug") or "", m["conditionId"]))
    write_jsonl(target, rows)


def iso(ts):
    return time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime(ts)) + "Z" if ts else "n/a"


def is_cs2(row, series_by_cond):
    s = series_by_cond.get((row.get("condition_id") or "").lower())
    if s is not None:
        return s == "counter-strike"
    return (row.get("event_slug") or row.get("slug") or "").startswith("cs2-")


def manifest(args, cutoff, trades, tinfo, activity, ainfo, positions, pmeta, markets, missing):
    L = []
    w = L.append
    series = {m["conditionId"].lower(): (m["_event"].get("seriesSlug") or "") for m in markets}
    at = [a for a in activity if a["type"] == "TRADE"]
    types = Counter(a["type"] for a in activity)
    w("# Raw backfill manifest\n")
    w(f"- wallet: `{args.user}`")
    w(f"- generated: {iso(int(time.time()))} by `scripts/backfill_raw.py`"
      f" ({'--full' if args.full else 'incremental'})")
    w(f"- feed cutoff (`end=`): {cutoff} = {iso(cutoff)} (run start minus {args.settle}s; rows with a"
      " later block timestamp are deliberately not in trades.jsonl / activity.jsonl)")
    w(f"- HTTP requests this run: {dict(REQUESTS)}\n")
    w("## Files\n")
    w("| file | rows | first timestamp | last timestamp | notes |")
    w("|-|-|-|-|-|")
    tts = [t["timestamp"] for t in trades] or [0]
    ats = [a["timestamp"] for a in activity] or [0]
    w(f"| trades.jsonl | {len(trades)} | {iso(min(tts))} | {iso(max(tts))} | `/v2/trades?taker_only=false&start=1`;"
      f" `_taker` true on {sum(1 for t in trades if t.get('_taker'))} rows, false (maker) on"
      f" {sum(1 for t in trades if not t.get('_taker'))}; sides {dict(Counter(t['side'] for t in trades))} |")
    w(f"| activity.jsonl | {len(activity)} | {iso(min(ats))} | {iso(max(ats))} | all 18 types requested,"
      " `exclude_deposits_withdrawals=false` |")
    w(f"| positions.json | {len(positions)} | | | {pmeta['status_counts']}; snapshot at {iso(pmeta['fetched_at'])} (live, not pinned to the cutoff) |")
    w(f"| markets.jsonl | {len(markets)} | | | one Gamma market per condition_id; closed={sum(1 for m in markets if m.get('closed'))},"
      f" open={sum(1 for m in markets if not m.get('closed'))} |\n")
    w("Rows in the two feed files are oldest-first in the API's own order (chain position reversed).\n")
    w("## Activity types\n")
    w("| type | rows | sum usdc_size |")
    w("|-|-|-|")
    for t, n in types.most_common():
        w(f"| {t} | {n} | {sum(a['usdc_size'] for a in activity if a['type'] == t):.2f} |")
    w("")
    w("## Cross-checks\n")
    k = lambda r: (r["transaction_hash"], r["token_id"], r["side"], r["price"], r["size"], r["timestamp"])
    ct, ca = Counter(k(r) for r in trades), Counter(k(r) for r in at)
    w(f"- activity TRADE rows: **{len(at)}**; trades.jsonl rows: **{len(trades)}**;"
      f" in trades but not activity: {sum((ct - ca).values())}; in activity but not trades: {sum((ca - ct).values())}"
      " (multiset compare on tx, token, side, price, size, timestamp).")
    dup = sum(v - 1 for v in Counter(fill_key(r) for r in trades).values() if v > 1)
    multi = Counter(Counter(r["transaction_hash"] for r in trades).values())
    w(f"- rows per transaction_hash in trades.jsonl: {dict(sorted(multi.items()))};"
      f" collisions on (transaction_hash, token_id, side, price, size): {dup}.")
    if tinfo["taker_rows_unmatched"]:
        w(f"- WARNING: {tinfo['taker_rows_unmatched']} taker_only=true rows had no match in the taker_only=false walk.")
    fee = sum(a["usdc_size"] - a["size"] * a["price"] for a in at)
    w(f"- activity TRADE: sum size*price = {sum(a['size'] * a['price'] for a in at):.2f},"
      f" sum usdc_size = {sum(a['usdc_size'] for a in at):.2f}, difference (taker fees) = {fee:.2f};"
      f" positions sum entry_fees_usdc = {sum(p['entry_fees_usdc'] for p in positions):.2f}.")
    cs_t = [a for a in at if is_cs2(a, series)]
    vol = sum(a["size"] * a["price"] for a in at) or 1
    w(f"- CS2 share (Gamma `seriesSlug == counter-strike`, slug prefix `cs2-` as fallback):"
      f" {len(cs_t)}/{len(at)} trade rows ({100 * len(cs_t) / max(len(at), 1):.2f}%),"
      f" {100 * sum(a['size'] * a['price'] for a in cs_t) / vol:.2f}% of notional;"
      f" non-`cs2-` event slugs traded: {sorted({a['event_slug'] for a in at if not a['event_slug'].startswith('cs2-')})[:20]}.")
    # positions vs BUY rows
    buys = defaultdict(lambda: [0.0, 0.0, 0.0, 0])
    for a in at:
        if a["side"] == "BUY":
            b = buys[a["token_id"]]
            b[0] += a["size"]; b[1] += a["size"] * a["price"]; b[2] += a["usdc_size"]; b[3] += 1
    redeem = defaultdict(float)
    for a in activity:
        if a["type"] == "REDEEM":
            redeem[(a["condition_id"], a["outcome_index"])] += a["usdc_size"]
    settled = [p for p in positions if p.get("last_event_at", 0) <= cutoff]
    op = [p for p in settled if p["status"] != "CLOSED"]
    cl = [p for p in settled if p["status"] == "CLOSED"]
    bad_size = sum(1 for p in settled if abs(p["total_size"] - buys[p["token_id"]][0]) > 0.01)
    bad_open = sum(1 for p in op if abs(p["entry_cost_usdc"] - buys[p["token_id"]][1]) > 0.01)
    bad_fee = sum(1 for p in settled if abs(p["entry_fees_usdc"] - (buys[p["token_id"]][2] - buys[p["token_id"]][1])) > 0.01)
    zero_closed = sum(1 for p in cl if p["entry_cost_usdc"] == 0)
    w(f"- positions vs BUY rows ({len(settled)} positions with last_event_at <= cutoff; {len(positions) - len(settled)} skipped as still moving):"
      f" total_size != sum BUY size on {bad_size}; entry_fees_usdc != sum(usdc_size - size*price) on {bad_fee};"
      f" OPEN entry_cost_usdc != sum size*price on {bad_open}/{len(op)};"
      f" CLOSED rows serving entry_cost_usdc == 0: {zero_closed}/{len(cl)}.")
    res = []
    for p in cl:
        pay = redeem.get((p["condition_id"], p["outcome_index"]))
        if pay is not None:
            res.append(p["realized_pnl"] - (pay - buys[p["token_id"]][2]))
    if res:
        w(f"- CLOSED realized_pnl vs (REDEEM usdc_size - sum BUY usdc_size incl. fees) on {len(res)} positions with a labelled redeem:"
          f" |diff| <= 0.01 on {sum(1 for d in res if abs(d) <= 0.01)}, max diff {max(res):.4f}, min {min(res):.4f}, sum {sum(res):.2f}."
          f" {len(cl) - len(res)} closed positions have no REDEEM row carrying their outcome_index.")
    w("\n### Three sample CS2 markets: sum of BUY rows vs the position row\n")
    cs_pos = [p for p in settled if is_cs2(p, series) and buys[p["token_id"]][3]]
    cost = lambda p: buys[p["token_id"]][1]
    picks = []
    for label, cand in (("largest OPEN", [p for p in cs_pos if p["status"] != "CLOSED"]),
                        ("largest CLOSED winner", [p for p in cs_pos if p["status"] == "CLOSED" and p["realized_pnl"] > 0]),
                        ("largest CLOSED loser", [p for p in cs_pos if p["status"] == "CLOSED" and p["realized_pnl"] < 0])):
        if cand:
            picks.append((label, max(cand, key=cost)))
    w("| sample | market slug / outcome | BUY rows | sum size | sum size*price | sum usdc_size | pos total_size | pos entry_cost_usdc | pos avg_price*total_size | pos entry_fees_usdc | pos total_cost_usdc | discrepancy |")
    w("|-|-|-|-|-|-|-|-|-|-|-|-|")
    for label, p in picks:
        b = buys[p["token_id"]]
        approx = p["avg_price"] * p["total_size"]
        if p["status"] == "CLOSED":
            note = (f"entry_cost_usdc is served as {p['entry_cost_usdc']} on CLOSED rows (API behaviour), so it is short by {b[1] - p['entry_cost_usdc']:.2f};"
                    f" avg_price*total_size differs from sum size*price by {approx - b[1]:.2f};"
                    f" fees differ by {p['entry_fees_usdc'] - (b[2] - b[1]):.4f}")
        else:
            note = (f"entry_cost - sum size*price = {p['entry_cost_usdc'] - b[1]:.4f};"
                    f" total_cost - sum usdc_size = {p['total_cost_usdc'] - b[2]:.4f}")
        w(f"| {label} | `{p['slug']}` / {p['outcome']} | {b[3]} | {b[0]:.4f} | {b[1]:.4f} | {b[2]:.4f} | {p['total_size']} |"
          f" {p['entry_cost_usdc']} | {approx:.4f} | {p['entry_fees_usdc']} | {p['total_cost_usdc']} | {note} |")
    w("")
    w("## Gaps and caveats\n")
    first_dep = min([a["timestamp"] for a in activity if a["type"] == "DEPOSIT"] or [0])
    w(f"- History depth: first activity row {iso(min(ats))} (first DEPOSIT {iso(first_dep)}), first trade {iso(min(tts))}."
      " Walks ended with `next_cursor: null`, so nothing older exists for this wallet in the API.")
    w(f"- Feed rows newer than the cutoff are missing by design; rerun to extend. Incremental runs only re-read"
      f" the last {args.overlap}s before the newest stored row, so a row indexed later than that would need `--full`.")
    if missing:
        w(f"- Gamma returned no market for {len(missing)} condition ids: {missing}")
    else:
        w("- Gamma returned a market for every condition_id seen in trades, activity and positions.")
    noid = sum(1 for a in activity if a["type"] == "REDEEM" and not a["token_id"])
    n999 = sum(1 for a in activity if a["type"] == "REDEEM" and a["outcome_index"] == 999)
    w(f"- {noid} REDEEM rows have an empty `token_id` and {n999} of them `outcome_index: 999` (as served by the API).")
    ptok = {p["token_id"] for p in positions}
    ttok = {t["token_id"] for t in trades}
    w(f"- distinct tokens traded: {len(ttok)}; tokens traded without a position row: {len(ttok - ptok)};"
      f" position rows without a trade: {len(ptok - ttok)}.")
    w("- positions.json is a live snapshot taken after the feed walks; it is not an as-of-cutoff view.")
    atomic_write(os.path.join(args.out, "MANIFEST.md"), "\n".join(L) + "\n")


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--user", default=DEFAULT_USER)
    ap.add_argument("--out", default=os.path.join(here, "..", "data", "raw"))
    ap.add_argument("--full", action="store_true", help="ignore stored files and re-walk everything")
    ap.add_argument("--overlap", type=int, default=86400, help="seconds re-read before newest stored row")
    ap.add_argument("--settle", type=int, default=60, help="feed cutoff = now - settle seconds")
    ap.add_argument("--cutoff", type=int, default=0, help="explicit feed cutoff (epoch s); overrides --settle")
    ap.add_argument("--sleep", type=float, default=0.3, help="pause between requests")
    ap.add_argument("--batch", type=int, default=40, help="condition ids per Gamma request (URL limit ~100)")
    ap.add_argument("--skip-markets", action="store_true")
    args = ap.parse_args()
    args.user = args.user.lower()
    args.out = os.path.abspath(args.out)
    os.makedirs(args.out, exist_ok=True)
    cutoff = args.cutoff or int(time.time()) - args.settle
    if not args.cutoff:          # an interrupted walk pins the cutoff so its cursor can be resumed
        for name in ("trades", "trades_taker", "activity"):
            part = os.path.join(args.out, f".{name}.part")
            try:
                with open(part, encoding="utf-8") as f:
                    cutoff = int(json.loads(f.readline())["params"]["end"])
                log(f"found {part}: resuming with its cutoff {cutoff}")
                break
            except (OSError, ValueError, KeyError, TypeError):
                continue

    trades, tinfo = do_trades(args, cutoff)
    activity, ainfo = do_activity(args, cutoff)
    positions, pmeta = do_positions(args)
    seen, conds = set(), []
    for r in trades + activity + positions:
        c = (r.get("condition_id") or "").lower()
        if c and c not in seen:
            seen.add(c)
            conds.append(c)
    if args.skip_markets:
        markets = read_jsonl(os.path.join(args.out, "markets.jsonl"))
        missing = [c for c in conds if c not in {m["conditionId"].lower() for m in markets}]
    else:
        markets, missing = do_markets(args, conds)
    manifest(args, cutoff, trades, tinfo, activity, ainfo, positions, pmeta, markets, missing)
    log(f"done: trades={len(trades)} activity={len(activity)} positions={len(positions)}"
        f" markets={len(markets)} missing_markets={len(missing)} requests={dict(REQUESTS)}")


if __name__ == "__main__":
    main()
