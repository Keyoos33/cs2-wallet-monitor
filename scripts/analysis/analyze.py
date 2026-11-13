#!/usr/bin/env python3
"""Copy-trading audit of one Polymarket wallet (CS2). Stdlib only, resumable, deterministic.

    python3 scripts/analysis/analyze.py \
        --trades data/raw/trades.jsonl --activity data/raw/activity.jsonl \
        --markets data/raw/markets.jsonl --positions data/raw/positions.json \
        --cache-dir .cache/analysis --out site/analysis.json

Inputs may be JSONL, a JSON list, or a JSON object holding a list / a dict keyed by id (the runner's
ledger files and the raw backfill files are both accepted). Network use is limited to two public,
unauthenticated endpoints, each response cached on disk and never re-fetched once its market is closed:

  * CLOB  /prices-history?market=<token>&startTs&endTs&fidelity=1   (1-minute price points per token)
  * Data  /v2/trades?condition=<id>&limit=1000 (+cursor)            (market-wide taker tape per condition)

`--offline` uses the cache only; `--no-tape` skips the tape. Method and limits: notes/ANALYSIS.md.
"""
import argparse, bisect, collections, gzip, json, math, os, random, sys, threading, time
import urllib.error, urllib.parse, urllib.request
from concurrent.futures import ThreadPoolExecutor

CLOB = "https://clob.polymarket.com"
DATA = "https://data-api.polymarket.com/v2"
UA = {"User-Agent": "Mozilla/5.0 (analysis script)", "Accept": "application/json"}
SEED = 20261113
N_BOOT = 5000
DELAYS = [10, 30, 60, 300, 900]           # seconds after the wallet's first fill on a token
SPREADS = [0.0, 0.005, 0.01, 0.02]        # half-spread / slippage added to the 1-minute price
BASE_SPREAD = 0.01
BURST_S = 600                             # an "alert burst" = fills within 10 min of the burst's first fill
PH_PRE, PH_POST = 3 * 3600, 3600          # price-history window around [first fill, max(last fill, start)]
MAX_STALE = 180                           # a 1-minute point older than this is not used as "the price at t"

# ----------------------------------------------------------------------------- io

def load_rows(path):
    """JSONL, JSON list, or JSON object wrapping a list / dict of rows."""
    if not path or not os.path.exists(path):
        return []
    with open(path, "r", encoding="utf-8") as f:
        txt = f.read()
    s = txt.lstrip()
    if not s:
        return []
    try:
        obj = json.loads(s)
    except ValueError:
        return [json.loads(l) for l in txt.splitlines() if l.strip()]
    if isinstance(obj, list):
        return obj
    if isinstance(obj, dict):
        for k in ("positions", "data", "rows", "markets", "fills", "events"):
            if isinstance(obj.get(k), list):
                return obj[k]
        vals = [v for v in obj.values() if isinstance(v, dict)]
        if vals and len(vals) >= len(obj) - 1 and not any(k in obj for k in ("token_id", "conditionId", "type")):
            return vals
        return [obj]
    return []


def fnum(x, d=0.0):
    try:
        if x is None or x == "":
            return d
        return float(x)
    except (TypeError, ValueError):
        return d


def parse_ts(s):
    """'2026-11-13 10:30:00+00' or ISO 8601 -> epoch seconds (UTC). None if unparseable."""
    if s is None or s == "":
        return None
    if isinstance(s, (int, float)):
        return int(s)
    import datetime as dt
    t = str(s).strip().replace("T", " ").replace("Z", "+00:00")
    if t.endswith("+00"):
        t += ":00"
    for cut in (None, 19):
        try:
            u = t if cut is None else t[:cut] + "+00:00"
            d = dt.datetime.fromisoformat(u)
            if d.tzinfo is None:
                d = d.replace(tzinfo=dt.timezone.utc)
            return int(d.timestamp())
        except ValueError:
            # fractional seconds with odd digit counts
            if "." in t and cut is None:
                head, _, tail = t.partition(".")
                tz = "+00:00"
                for sep in ("+", "-"):
                    if sep in tail:
                        tz = sep + tail.split(sep, 1)[1]
                        break
                try:
                    return int(dt.datetime.fromisoformat(head + tz).timestamp())
                except ValueError:
                    pass
    return None


def jdec(v, default=None):
    if isinstance(v, str):
        try:
            return json.loads(v)
        except ValueError:
            return default
    return v if v is not None else default


def iso(ts):
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ts))

# ----------------------------------------------------------------------------- http + cache

class Fetcher:
    def __init__(self, cache_dir, offline=False, pause=0.12, workers=4, log=None):
        self.dir, self.offline, self.pause, self.workers = cache_dir, offline, pause, workers
        self.lock = threading.Lock()
        self.n_req = 0
        self.n_err = 0
        self.log = log or (lambda *a: None)
        for sub in ("ph", "tape"):
            os.makedirs(os.path.join(cache_dir, sub), exist_ok=True)

    def get(self, url):
        last = None
        for attempt in range(5):
            try:
                time.sleep(self.pause)
                with self.lock:
                    self.n_req += 1
                req = urllib.request.Request(url, headers=UA)
                with urllib.request.urlopen(req, timeout=40) as r:
                    return json.loads(r.read().decode("utf-8"))
            except urllib.error.HTTPError as e:
                last = e
                if e.code in (429, 500, 502, 503, 504):
                    ra = e.headers.get("Retry-After") if e.headers else None
                    time.sleep(min(60.0, float(ra) if ra and ra.isdigit() else 2.0 * (2 ** attempt)))
                    continue
                raise
            except Exception as e:  # timeouts, resets
                last = e
                time.sleep(1.5 * (attempt + 1))
        with self.lock:
            self.n_err += 1
        raise RuntimeError("GET failed after retries: %s (%s)" % (url.split("?")[0], last))

    @staticmethod
    def _read(path):
        try:
            op = gzip.open if path.endswith(".gz") else open
            with op(path, "rt", encoding="utf-8") as f:
                return json.load(f)
        except (OSError, ValueError, EOFError):
            return None

    @staticmethod
    def _write(path, obj):
        tmp = path + ".tmp%d" % threading.get_ident()
        op = gzip.open if path.endswith(".gz") else open
        with op(tmp, "wt", encoding="utf-8") as f:
            json.dump(obj, f, separators=(",", ":"))
        os.replace(tmp, path)

    # -- 1-minute price history for one token over [a, b]
    def price_history(self, token, a, b, final):
        path = os.path.join(self.dir, "ph", token + ".json")
        c = self._read(path)
        if c and (self.offline or (c.get("final") and c.get("a", 0) <= a and c.get("b", 0) >= b)):
            return c["h"]
        if self.offline:
            return c["h"] if c else None
        pts = {}
        step = 5 * 86400
        s = a
        try:
            while s < b:
                e = min(b, s + step)
                u = "%s/prices-history?market=%s&startTs=%d&endTs=%d&fidelity=1" % (CLOB, token, s, e)
                try:
                    h = self.get(u).get("history") or []
                except urllib.error.HTTPError as ex:
                    if ex.code == 400 and step > 6 * 3600:   # window too long for this fidelity: shrink
                        step //= 4
                        continue
                    raise
                for x in h:
                    pts[int(x["t"])] = float(x["p"])
                s = e
        except Exception as ex:
            self.log("price history failed for token ..%s: %s" % (token[-8:], ex))
            return c["h"] if c else None
        h = sorted(pts.items())
        self._write(path, {"token": token, "a": a, "b": b, "final": bool(final), "h": h})
        return h

    # -- market-wide taker tape for one condition: rows [ts, outcome_index, is_buy, price, size, is_wallet]
    def tape(self, cond, wallet, final):
        path = os.path.join(self.dir, "tape", cond + ".json.gz")
        c = self._read(path)
        if c and (self.offline or c.get("final")):
            return c["rows"]
        if self.offline:
            return c["rows"] if c else None
        rows, cursor, pages = [], None, 0
        try:
            while True:
                u = "%s/trades?condition=%s&limit=1000" % (DATA, cond)
                if cursor:
                    u += "&cursor=" + urllib.parse.quote(cursor, safe="")
                d = self.get(u)
                for r in d.get("data") or []:
                    rows.append([int(r["timestamp"]), int(r.get("outcome_index", 0)), 1 if r.get("side") == "BUY" else 0,
                                 round(float(r["price"]), 6), round(float(r["size"]), 4),
                                 1 if str(r.get("proxy_wallet", "")).lower() == wallet else 0])
                cursor = (d.get("pagination") or {}).get("next_cursor")
                pages += 1
                if not cursor or pages > 400:
                    break
        except Exception as ex:
            self.log("tape failed for condition %s..: %s" % (cond[:10], ex))
            return c["rows"] if c else None
        rows.sort(key=lambda r: (r[0], r[1], r[2], r[3], r[4], r[5]))
        self._write(path, {"cond": cond, "final": bool(final), "pages": pages, "rows": rows})
        return rows

    def run(self, jobs):
        """jobs: list of (key, callable). Returns {key: result}."""
        out = {}
        if not jobs:
            return out
        done = [0]

        def one(j):
            k, fn = j
            try:
                r = fn()
            except Exception as ex:  # never let one market kill the run
                self.log("job failed: %s" % ex)
                r = None
            with self.lock:
                done[0] += 1
                if done[0] % 100 == 0:
                    self.log("  fetched %d/%d (%d http requests)" % (done[0], len(jobs), self.n_req))
            return k, r

        with ThreadPoolExecutor(max_workers=1 if self.offline else self.workers) as ex:
            for k, r in ex.map(one, jobs):
                out[k] = r
        return out

# ----------------------------------------------------------------------------- model

def build_model(a_trades, a_activity, a_markets, a_positions):
    trades, activity = load_rows(a_trades), load_rows(a_activity)
    mk_rows, pos_rows = load_rows(a_markets), load_rows(a_positions)

    # markets by condition id
    markets = {}
    for m in mk_rows:
        cid = m.get("conditionId") or m.get("condition_id")
        if not cid:
            continue
        ev = m.get("_event") or (m.get("events") or [{}])[0] or {}
        md = ev.get("eventMetadata") or {}
        if not isinstance(md, dict):
            md = {}
        prices = [fnum(x, None) for x in (jdec(m.get("outcomePrices"), []) or [])]
        title = ev.get("title") or m.get("question") or ""
        bo = None
        sc = str(ev.get("score") or "")
        if "|" in sc and sc.split("|")[-1][:2].lower() == "bo":
            bo = sc.split("|")[-1].upper()
        if not bo:
            i = title.upper().find("(BO")
            if i >= 0:
                bo = title[i + 1:i + 4].upper()
        closed = bool(m.get("closed"))
        settled = closed and len(prices) >= 2 and all(p in (0.0, 0.5, 1.0) for p in prices) and abs(sum(prices) - 1) < 1e-9
        markets[cid] = {
            "cid": cid, "slug": m.get("slug") or "", "question": m.get("question") or "",
            "type": m.get("sportsMarketType") or "inconnu", "line": m.get("line"),
            "outcomes": jdec(m.get("outcomes"), []) or [], "tokens": jdec(m.get("clobTokenIds"), []) or [],
            "prices": prices, "closed": closed, "settled": settled,
            "start": parse_ts(m.get("gameStartTime") or m.get("eventStartTime") or ev.get("startTime")),
            "closed_ts": parse_ts(m.get("closedTime")),
            "event": ev.get("slug") or (m.get("slug") or ""), "event_title": title,
            "series": ev.get("seriesSlug") or "", "league": md.get("league") or "?",
            "tier": str(md.get("leagueTier")) if md.get("leagueTier") not in (None, "") else "?",
            "bo": bo or "?", "volume": fnum(m.get("volumeNum") or m.get("volume")),
            "fee_rate": fnum((m.get("feeSchedule") or {}).get("rate"), 0.05) if isinstance(m.get("feeSchedule"), dict) else 0.05,
        }

    # fills: activity TRADE rows carry the cash (fee-inclusive); fall back to the trades file
    act_trades = [r for r in activity if r.get("type") == "TRADE"]
    src = act_trades if act_trades else [r for r in trades if r.get("type", "TRADE") == "TRADE"]
    taker_flag = collections.Counter()
    for r in trades:
        if "_taker" in r:
            taker_flag[(r.get("transaction_hash"), r.get("token_id"), r.get("price"), r.get("size"))] += 1 if r["_taker"] else 0
    fills, sells = [], []
    for r in src:
        size, price = fnum(r.get("size")), fnum(r.get("price"))
        cid = r.get("condition_id") or r.get("conditionId") or ""
        notional = size * price
        if r.get("usdc_size") not in (None, ""):
            cash = fnum(r.get("usdc_size"))
            taker = cash > notional + 1e-6
        else:
            taker = bool(r.get("_taker", r.get("taker", r.get("is_taker", False))))
            rate = markets.get(cid, {}).get("fee_rate", 0.05)
            cash = notional + (rate * size * price * (1 - price) if taker else 0.0)
        f = {"ts": int(fnum(r.get("timestamp"))), "token": str(r.get("token_id") or ""), "cid": cid,
             "oi": int(fnum(r.get("outcome_index"))), "size": size, "price": price, "cash": cash,
             "fee": max(0.0, cash - notional), "taker": taker, "event": r.get("event_slug") or "",
             "outcome": r.get("outcome") or "", "title": r.get("title") or "", "tx": r.get("transaction_hash") or ""}
        (fills if (r.get("side") or "BUY") == "BUY" else sells).append(f)
    fills.sort(key=lambda f: (f["ts"], f["tx"], f["token"], f["price"], f["size"]))

    # other cash rows
    others = collections.defaultdict(lambda: [0, 0.0])
    redeems = collections.defaultdict(lambda: [0.0, 0.0, 0])      # (cid, oi) -> [shares, usdc, last ts]
    redeem_total, rebate_rows = 0.0, []
    for r in activity:
        t = r.get("type")
        if t == "TRADE":
            continue
        others[t][0] += 1
        others[t][1] += fnum(r.get("usdc_size"))
        if t == "REDEEM":
            k = (r.get("condition_id") or "", int(fnum(r.get("outcome_index"), 999)))
            redeems[k][0] += fnum(r.get("size"))
            redeems[k][1] += fnum(r.get("usdc_size"))
            redeems[k][2] = max(redeems[k][2], int(fnum(r.get("timestamp"))))
            redeem_total += fnum(r.get("usdc_size"))
        elif t in ("MAKER_REBATE", "TAKER_REBATE"):
            rebate_rows.append((int(fnum(r.get("timestamp"))), t, fnum(r.get("usdc_size"))))

    pos_api = {str(p.get("token_id")): p for p in pos_rows if p.get("token_id")}

    # positions per token
    P = collections.OrderedDict()
    for f in fills:
        p = P.get(f["token"])
        if p is None:
            m = markets.get(f["cid"]) or {"cid": f["cid"], "slug": "", "question": f["title"], "type": "inconnu", "line": None,
                                           "outcomes": [], "tokens": [], "prices": [], "closed": False, "settled": False,
                                           "start": None, "closed_ts": None, "event": f["event"], "event_title": f["title"],
                                           "series": "", "league": "?", "tier": "?", "bo": "?", "volume": 0.0, "fee_rate": 0.05}
            markets.setdefault(f["cid"], m)
            p = P[f["token"]] = {"token": f["token"], "cid": f["cid"], "oi": f["oi"], "m": m, "fills": [],
                                 "event": m["event"] or f["event"], "outcome": f["outcome"]}
        p["fills"].append(f)
    for p in P.values():
        m, fl = p["m"], p["fills"]
        p["shares"] = sum(f["size"] for f in fl)
        p["cash"] = sum(f["cash"] for f in fl)
        p["fees"] = sum(f["fee"] for f in fl)
        p["notional"] = p["cash"] - p["fees"]
        p["vwap"] = p["notional"] / p["shares"] if p["shares"] else 0.0
        p["t0"], p["t1"] = fl[0]["ts"], fl[-1]["ts"]
        p["n"] = len(fl)
        p["taker_cash"] = sum(f["cash"] for f in fl if f["taker"])
        p["open_taker"] = fl[0]["taker"]
        p["start"] = m["start"]
        # settlement value per share: Gamma first, then REDEEM rows, then the position row
        settle = None
        if m["settled"] and p["oi"] < len(m["prices"]):
            settle = m["prices"][p["oi"]]
        rd = redeems.get((p["cid"], p["oi"]))
        if settle is None and rd and rd[0] > 0:
            x = rd[1] / rd[0]
            settle = min((0.0, 0.5, 1.0), key=lambda v: abs(v - x))
        ap = pos_api.get(p["token"])
        if settle is None and ap and ap.get("status") == "CLOSED" and fnum(ap.get("current_price"), -1) in (0.0, 0.5, 1.0):
            settle = fnum(ap.get("current_price"))
        p["settle"] = settle
        p["resolved"] = settle is not None
        p["payout"] = p["shares"] * settle if settle is not None else None
        p["pnl"] = p["payout"] - p["cash"] if settle is not None else None
        p["t_settle"] = (rd[2] if rd and rd[2] else None) or m["closed_ts"] or (m["start"] or p["t1"])
        for f in fl:
            f["pnl"] = f["size"] * settle - f["cash"] if settle is not None else None
            f["lead"] = (m["start"] - f["ts"]) if m["start"] else None

    return {"fills": fills, "sells": sells, "markets": markets, "P": P, "others": {k: tuple(v) for k, v in others.items()},
            "redeem_total": redeem_total, "rebates": rebate_rows, "pos_api": pos_api,
            "wallet": (str((src[0].get("proxy_wallet") if src else "") or "").lower())}


def fetch_all(M, F, use_tape=True):
    """Price history for every token, tape for every condition. Cached; closed markets are fetched once."""
    now = int(time.time())
    jobs = []
    for p in M["P"].values():
        m = p["m"]
        a = p["t0"] - PH_PRE
        b = max(p["t1"], p["start"] or p["t1"]) + PH_POST
        final = m["closed"] or b < now - 86400
        if not final:
            b = min(b, now)
        jobs.append((("ph", p["token"]), (lambda t=p["token"], a=a, b=b, fin=final: F.price_history(t, a, b, fin))))
    if use_tape:
        seen = set()
        for p in M["P"].values():
            if p["cid"] in seen:
                continue
            seen.add(p["cid"])
            jobs.append((("tape", p["cid"]), (lambda c=p["cid"], fin=p["m"]["closed"]: F.tape(c, M["wallet"], fin))))
    res = F.run(jobs)
    for p in M["P"].values():
        p["ph"] = res.get(("ph", p["token"])) or []
        p["tape"] = res.get(("tape", p["cid"])) if use_tape else None
    return res

# ----------------------------------------------------------------------------- statistics helpers

def r2(x, n=2):
    if x is None:
        return None
    if isinstance(x, float) and (math.isnan(x) or math.isinf(x)):
        return None
    return round(float(x), n)


def pct(x, n=1):
    return None if x is None else r2(100.0 * x, n)


def div(a, b):
    return a / b if b else None


def mean(xs):
    xs = [x for x in xs if x is not None]
    return sum(xs) / len(xs) if xs else None


def wmean(pairs):
    """pairs of (value, weight); None values skipped."""
    num = den = 0.0
    for v, w in pairs:
        if v is None or w is None:
            continue
        num += v * w
        den += w
    return num / den if den else None


def quantile(xs, q):
    xs = sorted(x for x in xs if x is not None)
    if not xs:
        return None
    k = q * (len(xs) - 1)
    lo, hi = int(math.floor(k)), int(math.ceil(k))
    return xs[lo] + (xs[hi] - xs[lo]) * (k - lo)


def wquantile(pairs, q):
    pairs = sorted((v, w) for v, w in pairs if v is not None and w and w > 0)
    tot = sum(w for _, w in pairs)
    if not tot:
        return None
    acc = 0.0
    for v, w in pairs:
        acc += w
        if acc >= q * tot:
            return v
    return pairs[-1][0]


def wilson(k, n, z=1.96):
    if not n:
        return (None, None)
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (c - h, c + h)


def boot_ratio(groups, n_boot=N_BOOT, seed=SEED):
    """Cluster bootstrap of sum(num)/sum(den). groups: list of (num, den), one per cluster (match).
    Returns (point, lo95, hi95, share of resamples with ratio <= 0)."""
    groups = [g for g in groups if g[1]]
    n = len(groups)
    if n < 2:
        pt = div(sum(g[0] for g in groups), sum(g[1] for g in groups))
        return (pt, None, None, None)
    rng = random.Random(seed)
    nums = [g[0] for g in groups]
    dens = [g[1] for g in groups]
    idx = range(n)
    out = []
    for _ in range(n_boot):
        ch = rng.choices(idx, k=n)
        a = b = 0.0
        for i in ch:
            a += nums[i]
            b += dens[i]
        out.append(a / b if b else 0.0)
    out.sort()
    return (sum(nums) / sum(dens), out[int(0.025 * n_boot)], out[int(0.975 * n_boot) - 1],
            bisect.bisect_right(out, 0.0) / n_boot)


def cluster_z(vals):
    """z of sum(vals) against 0 with cluster-robust variance sum(v^2) (one value per match)."""
    s2 = sum(v * v for v in vals)
    return sum(vals) / math.sqrt(s2) if s2 > 0 else None


def p_two_sided(z):
    return None if z is None else math.erfc(abs(z) / math.sqrt(2))


def by_match(items, num, den):
    """Aggregate (num, den) per match for the cluster bootstrap. items carry 'event' or a (event, ...) tuple."""
    g = collections.OrderedDict()
    for it in items:
        a, b = num(it), den(it)
        if a is None or b is None:
            continue
        k = it["event"]
        if k not in g:
            g[k] = [0.0, 0.0]
        g[k][0] += a
        g[k][1] += b
    return [tuple(v) for v in g.values()]


def roi_row(label, items, cash=lambda p: p["cash"], pnl=lambda p: p["pnl"], extra=None):
    """[label, n, staked, pnl, ROI%, CI lo%, CI hi%] with a match-clustered bootstrap."""
    its = [p for p in items if pnl(p) is not None]
    c, g = sum(cash(p) for p in its), sum(pnl(p) for p in its)
    _, lo, hi, _ = boot_ratio(by_match(its, pnl, cash), n_boot=2000)
    row = [label, len(its), r2(c, 0), r2(g, 0), pct(div(g, c)), pct(lo), pct(hi)]
    if extra:
        row += extra(its)
    return row

# ----------------------------------------------------------------------------- price helpers

class Path:
    """1-minute price points of one token."""
    def __init__(self, h):
        self.t = [int(x[0]) for x in h]
        self.p = [float(x[1]) for x in h]

    def after(self, t, tol=MAX_STALE):
        """First point at or after t (None if none within tol seconds). Returns (price, lag)."""
        i = bisect.bisect_left(self.t, t)
        if i < len(self.t) and self.t[i] - t <= tol:
            return self.p[i], self.t[i] - t
        return None, None

    def before(self, t, tol=900):
        """Last point strictly before t (None if older than tol)."""
        i = bisect.bisect_left(self.t, t) - 1
        if i >= 0 and t - self.t[i] <= tol:
            return self.p[i]
        return None


def cost_per_share(price, rate=0.05):
    """Taker cash per share at a given price, fee included."""
    price = min(0.999, max(0.001, price))
    return price + rate * price * (1 - price)


def follower_roi(price, settle, rate=0.05):
    return settle / cost_per_share(price, rate) - 1.0


def ask_prints(tape, k):
    """Ask-side prints of outcome k from the market tape: a taker BUY of k at p, or a taker SELL of the other
    outcome at q (which hits a bid on the other outcome = lifts an offer on k at 1-q)."""
    out = []
    for ts, oi, is_buy, price, size, isw in tape or []:
        if oi == k and is_buy:
            out.append((ts, price, size, isw))
        elif oi != k and not is_buy:
            out.append((ts, 1.0 - price, size, isw))
    return out


def tape_entry(prints, ts_list, t, others_only, usd=100.0, horizon=900, min_usd=10.0):
    """VWAP of the first `usd` dollars bought on the ask side at or after t (within horizon)."""
    i = bisect.bisect_left(ts_list, t)
    got = sh = 0.0
    while i < len(prints) and prints[i][0] <= t + horizon and got < usd:
        _, price, size, isw = prints[i]
        i += 1
        if others_only and isw:
            continue
        d = min(size * price, usd - got)
        if price <= 0:
            continue
        got += d
        sh += d / price
    if got < min_usd or sh <= 0:
        return None
    return got / sh

# ----------------------------------------------------------------------------- enrichment

PRICE_BUCKETS = [(0.0, 0.2), (0.2, 0.3), (0.3, 0.4), (0.4, 0.5), (0.5, 0.6), (0.6, 0.7), (0.7, 0.8), (0.8, 1.01)]
STAKE_BUCKETS = [(0, 100), (100, 1000), (1000, 5000), (5000, 20000), (20000, 1e12)]
LEAD_BUCKETS = [("plus de 8 h avant", 8 * 3600, 1e12), ("4 à 8 h avant", 4 * 3600, 8 * 3600), ("2 à 4 h avant", 2 * 3600, 4 * 3600),
                ("1 à 2 h avant", 3600, 2 * 3600), ("moins d'1 h avant", 0, 3600), ("après l'heure prévue", -1e12, 0)]
TYPE_FR = {"moneyline": "Vainqueur du match", "child_moneyline": "Vainqueur d'une carte", "map_handicap": "Handicap de cartes",
           "totals": "Nombre de cartes (plus/moins)", "inconnu": "Type inconnu"}


def type_label(p):
    m = p["m"]
    t = m["type"]
    if t == "map_handicap":
        q = m["question"]
        first_minus = "(-" in q.split(" vs ")[0] if " vs " in q else True
        minus = (p["oi"] == 0) == first_minus
        ln = abs(fnum(m["line"], 1.5))
        return "Handicap de cartes %s%g" % ("-" if minus else "+", ln)
    if t.startswith("round_handicap"):
        return "Handicap de manches (une carte)"
    return TYPE_FR.get(t, t)


def bucket_label(lo, hi, unit=""):
    if hi >= 1e11:
        return "%g%s et plus" % (lo, unit)
    return "%g à %g%s" % (lo, hi, unit)


def enrich(M):
    ev_teams = {}
    for m in M["markets"].values():
        if m["type"] == "moneyline" and len(m["outcomes"]) == 2:
            ev_teams[m["event"]] = m["outcomes"]
    for p in M["P"].values():
        m = p["m"]
        p["path"] = pa = Path(p.get("ph") or [])
        f0 = p["fills"][0]
        p["p0"] = f0["price"]
        b20 = [f for f in p["fills"] if f["ts"] <= p["t0"] + 20]
        p["burst0_cash"] = sum(f["cash"] for f in b20)
        p["burst0_vwap"] = sum(f["size"] * f["price"] for f in b20) / sum(f["size"] for f in b20)
        p["mid_before"] = pa.before(p["t0"])
        p["pre"] = bool(p["start"] and p["t0"] < p["start"])
        p["close"] = pa.before(p["start"] + 1, tol=1800) if p["pre"] else None
        p["mid"], p["lag"] = {}, {}
        for d in DELAYS + [3600]:
            p["mid"][d], p["lag"][d] = pa.after(p["t0"] + d)
        # alert-sized bursts: fills within BURST_S of the burst's first fill
        bursts = []
        for f in p["fills"]:
            if not bursts or f["ts"] > bursts[-1]["t"] + BURST_S:
                bursts.append({"t": f["ts"], "cash": 0.0, "shares": 0.0, "event": p["event"], "p": p, "first": not bursts})
            bursts[-1]["cash"] += f["cash"]
            bursts[-1]["shares"] += f["size"]
        for b in bursts:
            b["pnl"] = b["shares"] * p["settle"] - b["cash"] if p["resolved"] else None
        p["bursts"] = bursts
        p["asks"] = ask_prints(p.get("tape"), p["oi"]) if p.get("tape") is not None else None
        p["asks_t"] = [a[0] for a in p["asks"]] if p["asks"] is not None else None
        p["label"] = type_label(p)
        # which team the position backs (None for totals)
        teams = ev_teams.get(p["event"])
        p["team"] = p["outcome"] if teams and p["outcome"] in teams else None
        p["cps"] = p["cash"] / p["shares"] if p["shares"] else None       # wallet cash per share, fees included
        p["roi1"] = (p["settle"] / p["cps"] - 1.0) if p["resolved"] and p["cps"] else None
    for f in M["fills"]:
        p = M["P"][f["token"]]
        f["close"] = p["close"] if (p["start"] and f["ts"] < p["start"]) else None
        f["event"] = p["event"]
    M["events"] = collections.OrderedDict()
    for p in M["P"].values():
        M["events"].setdefault(p["event"], []).append(p)

# ----------------------------------------------------------------------------- sections

def T(titre, colonnes, lignes):
    return {"titre": titre, "colonnes": colonnes, "lignes": lignes}


def sec_profit(M):
    P = list(M["P"].values())
    res = [p for p in P if p["resolved"]]
    opn = [p for p in P if not p["resolved"]]
    cash_all = sum(p["cash"] for p in P)
    cash = sum(p["cash"] for p in res)
    fees = sum(p["fees"] for p in res)
    payout = sum(p["payout"] for p in res)
    pnl = payout - cash
    reb_t = M["others"].get("TAKER_REBATE", (0, 0.0))[1]
    reb_m = M["others"].get("MAKER_REBATE", (0, 0.0))[1]
    dep = M["others"].get("DEPOSIT", (0, 0.0))[1]
    wd = M["others"].get("WITHDRAWAL", (0, 0.0))[1]
    n_cs2 = sum(1 for f in M["fills"] if f["event"].startswith("cs2-") or M["markets"].get(f["cid"], {}).get("series") == "counter-strike")
    cs2_cash = sum(f["cash"] for f in M["fills"] if f["event"].startswith("cs2-") or M["markets"].get(f["cid"], {}).get("series") == "counter-strike")
    g = by_match(res, lambda p: p["pnl"], lambda p: p["cash"])
    roi, lo, hi, p_neg = boot_ratio(g)
    z = cluster_z([x[0] for x in g])
    # pre-fee, price-only test: shares * (settle - entry price)
    g0 = by_match(res, lambda p: p["shares"] * (p["settle"] - p["vwap"]), lambda p: p["notional"])
    z0 = cluster_z([x[0] for x in g0])
    # flat stake: mean per-position ROI, clustered by match
    gf = by_match(res, lambda p: p["roi1"], lambda p: 1.0)
    roi_f, lo_f, hi_f, pneg_f = boot_ratio(gf)
    zf = cluster_z([x[0] for x in gf])
    synth = T("Bilan en argent réel", ["Poste", "Montant (USDC)"], [
        ["Argent misé, frais inclus (toutes positions)", r2(cash_all)],
        ["dont positions réglées", r2(cash)],
        ["dont positions encore ouvertes (%d)" % len(opn), r2(cash_all - cash)],
        ["Frais payés sur positions réglées", r2(fees)],
        ["Gains encaissés au règlement", r2(payout)],
        ["Bénéfice net des paris réglés", r2(pnl)],
        ["Remises reçues (preneur)", r2(reb_t)],
        ["Remises reçues (teneur de marché)", r2(reb_m)],
        ["Bénéfice net, remises comprises", r2(pnl + reb_t + reb_m)],
        ["Dépôts", r2(dep)], ["Retraits", r2(wd)],
    ])
    ratios = T("Rendement et part de CS2", ["Indicateur", "Valeur"], [
        ["Rendement sur l'argent misé (%)", pct(roi, 2)],
        ["Rendement, remises comprises (%)", pct(div(pnl + reb_t + reb_m, cash), 2)],
        ["Bénéfice net / dépôts (multiple)", r2(div(pnl + reb_t + reb_m, dep), 2)],
        ["Part des ordres sur CS2 (%)", pct(div(n_cs2, len(M["fills"])), 2)],
        ["Part de l'argent misé sur CS2 (%)", pct(div(cs2_cash, cash_all), 2)],
        ["Matchs joués (réglés)", len(g)], ["Positions réglées", len(res)],
        ["Positions gagnées / perdues / remboursées à 50 %",
         "%d / %d / %d" % (sum(1 for p in res if p["settle"] == 1), sum(1 for p in res if p["settle"] == 0), sum(1 for p in res if p["settle"] == 0.5))],
    ])
    # monthly + weekly by scheduled match date
    def period_table(fmt, titre, col):
        agg = collections.OrderedDict()
        for p in sorted(res, key=lambda p: p["start"] or p["t0"]):
            k = time.strftime(fmt, time.gmtime(p["start"] or p["t0"]))
            agg.setdefault(k, []).append(p)
        rows = []
        for k, ps in agg.items():
            rr = roi_row(k, ps)
            rows.append(rr[:1] + [len(set(p["event"] for p in ps))] + rr[1:])
        return T(titre, [col, "Matchs", "Positions", "Misé (USDC)", "Bénéfice (USDC)", "Rendement (%)", "IC 95 % bas (%)", "IC 95 % haut (%)"], rows)
    monthly = period_table("%Y-%m", "Bénéfice par mois (date prévue du match)", "Mois")
    # drawdown on settlement order, daily
    days = collections.OrderedDict()
    for p in sorted(res, key=lambda p: p["t_settle"]):
        k = time.strftime("%Y-%m-%d", time.gmtime(p["t_settle"]))
        days[k] = days.get(k, 0.0) + p["pnl"]
    cum = peak = 0.0
    dd = (0.0, None, None)
    peak_day = None
    worst_day = min(days.items(), key=lambda kv: kv[1]) if days else (None, 0.0)
    for k, v in days.items():
        cum += v
        if cum > peak:
            peak, peak_day = cum, k
        if peak - cum > dd[0]:
            dd = (peak - cum, peak_day, k)
    # position-level drawdown (finer)
    cum = peak = 0.0
    ddp = ddp_peak = 0.0
    for p in sorted(res, key=lambda p: (p["t_settle"], p["token"])):
        cum += p["pnl"]
        peak = max(peak, cum)
        if peak - cum > ddp:
            ddp, ddp_peak = peak - cum, peak
    risk = T("Risque", ["Indicateur", "Valeur"], [
        ["Pire baisse depuis un sommet, par jour de règlement (USDC)", r2(dd[0], 0)],
        ["Début / fin de cette baisse", "%s → %s" % (dd[1], dd[2]) if dd[1] else None],
        ["Pire baisse, position par position (USDC)", r2(ddp, 0)],
        ["Bénéfice cumulé au sommet précédant cette baisse (USDC)", r2(ddp_peak, 0)],
        ["Pire baisse / dépôts totaux (%)", pct(div(ddp, dep))],
        ["Pire journée (USDC)", r2(worst_day[1], 0)], ["Date de la pire journée", worst_day[0]],
        ["Jours avec règlement", len(days)], ["Jours gagnants (%)", pct(div(sum(1 for v in days.values() if v > 0), len(days)))],
        ["Plus grosse mise sur une position (USDC)", r2(max(p["cash"] for p in P), 0)],
        ["Mise médiane par position (USDC)", r2(quantile([p["cash"] for p in P], 0.5), 0)],
    ])
    top = sorted(res, key=lambda p: -p["pnl"])
    mpn = sorted((sum(p["pnl"] for p in ps if p["resolved"]), ev) for ev, ps in M["events"].items() if any(p["resolved"] for p in ps))
    conc = T("Concentration du bénéfice", ["Indicateur", "Valeur"], [
        ["Bénéfice des 10 meilleures positions (USDC)", r2(sum(p["pnl"] for p in top[:10]), 0)],
        ["Part du bénéfice total venant des 10 meilleures positions (%)", pct(div(sum(p["pnl"] for p in top[:10]), pnl))],
        ["Bénéfice sans les 10 meilleures positions (USDC)", r2(pnl - sum(p["pnl"] for p in top[:10]), 0)],
        ["Perte des 10 pires positions (USDC)", r2(sum(p["pnl"] for p in top[-10:]), 0)],
        ["Bénéfice des 10 meilleurs matchs (USDC)", r2(sum(x[0] for x in mpn[-10:]), 0)],
        ["Perte des 10 pires matchs (USDC)", r2(sum(x[0] for x in mpn[:10]), 0)],
        ["Bénéfice du meilleur match (USDC)", r2(mpn[-1][0], 0) if mpn else None],
        ["Bénéfice sans les 5 meilleurs matchs (USDC)", r2(pnl - sum(x[0] for x in mpn[-5:]), 0)],
        ["Bénéfice médian par match (USDC)", r2(quantile([x[0] for x in mpn], 0.5), 0)],
        ["Matchs gagnants (%)", pct(div(sum(1 for x in mpn if x[0] > 0), len(mpn)))],
    ])
    top_t = T("Les 10 meilleures et 5 pires positions", ["Marché", "Issue", "Misé (USDC)", "Prix moyen", "Bénéfice (USDC)"],
              [[p["m"]["slug"], p["outcome"], r2(p["cash"], 0), r2(p["vwap"], 3), r2(p["pnl"], 0)] for p in top[:10] + top[-5:]])
    test = T("Chance ou avantage réel ? (rééchantillonnage par match)", ["Mesure", "Valeur"], [
        ["Rendement réel (%)", pct(roi, 2)], ["IC 95 % bas (%)", pct(lo, 2)], ["IC 95 % haut (%)", pct(hi, 2)],
        ["Part des tirages avec un bénéfice nul ou négatif (%)", pct(p_neg, 2)],
        ["Score z, bénéfice après frais (groupé par match)", r2(z, 2)], ["Probabilité associée, bilatérale", r2(p_two_sided(z), 4)],
        ["Score z, prix seuls avant frais (hypothèse : prix d'entrée justes)", r2(z0, 2)],
        ["Rendement à mise fixe par position (%)", pct(roi_f, 2)], ["IC 95 % bas, mise fixe (%)", pct(lo_f, 2)],
        ["IC 95 % haut, mise fixe (%)", pct(hi_f, 2)], ["Score z, mise fixe", r2(zf, 2)],
        ["Probabilité associée, mise fixe", r2(p_two_sided(zf), 4)],
    ])
    # calibration by entry price bucket (fee-exclusive VWAP = implied probability)
    cal = []
    for lo_b, hi_b in PRICE_BUCKETS:
        ps = [p for p in res if lo_b <= p["vwap"] < hi_b]
        if not ps:
            continue
        n = len(ps)
        wins = sum(p["settle"] for p in ps)
        wl, wh = wilson(wins, n)
        imp = mean([p["vwap"] for p in ps])
        imp_w = wmean([(p["vwap"], p["cash"]) for p in ps])
        win_w = wmean([(p["settle"], p["cash"]) for p in ps])
        c, g_ = sum(p["cash"] for p in ps), sum(p["pnl"] for p in ps)
        cal.append(["%.2f à %.2f" % (lo_b, min(hi_b, 1.0)), n, pct(imp), pct(wins / n), pct(wl), pct(wh), pct(wins / n - imp),
                    pct(imp_w), pct(win_w), r2(c, 0), r2(g_, 0), pct(div(g_, c))])
    ps = res
    n = len(ps)
    wins = sum(p["settle"] for p in ps)
    wl, wh = wilson(wins, n)
    cal.append(["Total", n, pct(mean([p["vwap"] for p in ps])), pct(wins / n), pct(wl), pct(wh), pct(wins / n - mean([p["vwap"] for p in ps])),
                pct(wmean([(p["vwap"], p["cash"]) for p in ps])), pct(wmean([(p["settle"], p["cash"]) for p in ps])),
                r2(cash, 0), r2(pnl, 0), pct(div(pnl, cash))])
    calib = T("Taux de réussite réel contre probabilité payée, par tranche de prix d'entrée",
              ["Prix d'entrée", "Positions", "Probabilité payée moyenne (%)", "Taux de réussite (%)", "IC 95 % bas (%)", "IC 95 % haut (%)",
               "Écart (points)", "Probabilité payée, pondérée par la mise (%)", "Taux de réussite, pondéré par la mise (%)",
               "Misé (USDC)", "Bénéfice (USDC)", "Rendement (%)"], cal)
    warn = [
        "L'historique utile est court : %s %% de l'argent misé l'a été depuis le %s." % (
            frn(100 * div(sum(p["cash"] for p in P if (p["start"] or p["t0"]) >= quantile([p["start"] or p["t0"] for p in P], 0.02)), cash_all)),
            time.strftime("%d/%m/%Y", time.gmtime(quantile([p["start"] or p["t0"] for p in P], 0.02)))),
        "Les positions d'un même match gagnent ou perdent ensemble : les intervalles sont calculés en tirant des matchs entiers, pas des ordres.",
        "Les remises ne sont pas rattachables à un pari ; elles sont comptées à part.",
        "Les intervalles de confiance supposent que les matchs sont indépendants et que le comportement du wallet ne change pas.",
    ]
    resume = ("Le bénéfice est réel et vient à %s %% de CS2 : %s USDC misés, %s USDC encaissés, soit %s USDC de bénéfice net (%s %% de l'argent misé), "
              "plus %s USDC de remises. Mais %s %% de ce bénéfice vient des 10 meilleures positions, l'intervalle de confiance du rendement va de %s %% à %s %%, "
              "et à mise égale sur chaque position le rendement n'est que de %s %% (de %s %% à %s %%)." % (
                  frn(100 * div(cs2_cash, cash_all), 0), fr_int(cash), fr_int(payout), fr_int(pnl), frn(100 * roi), fr_int(reb_t + reb_m),
                  frn(100 * div(sum(p["pnl"] for p in top[:10]), pnl) if pnl else 0, 0), frn(100 * (lo or 0)), frn(100 * (hi or 0)),
                  frn(100 * roi_f), frn(100 * (lo_f or 0)), frn(100 * (hi_f or 0))))
    return {"id": "profit", "titre": "1. Le bénéfice est-il réel, et vient-il de CS2 ?", "resume": resume,
            "tableaux": [synth, ratios, monthly, risk, conc, top_t, test, calib], "avertissements": warn}, {
        "roi": roi, "lo": lo, "hi": hi, "p_neg": p_neg, "z": z, "pnl": pnl, "cash": cash, "roi_flat": roi_f, "lo_f": lo_f, "hi_f": hi_f,
        "zf": zf, "top10": div(sum(p["pnl"] for p in top[:10]), pnl), "n_match": len(g), "rebates": reb_t + reb_m, "fees": fees,
        "reb_t": reb_t, "reb_m": reb_m, "dd": ddp,
        "span_days": int(round((max(p["start"] or p["t0"] for p in P) - (wquantile([(p["start"] or p["t0"], p["cash"]) for p in P], 0.02) or 0)) / 86400.0))}


def frn(x, n=1):
    """French decimal formatting for sentences: 19.12 -> '19,1'."""
    if x is None:
        return "?"
    return (("%%.%df" % n) % x).replace(".", ",").replace("-", "−")


def fr_int(x):
    return ("%d" % round(x)).replace("-", "−") if abs(x) < 1000 else "{:,}".format(int(round(x))).replace(",", " ").replace("-", "−")


def sec_structure(M):
    P = list(M["P"].values())
    res = [p for p in P if p["resolved"]]
    cols = ["Catégorie", "Positions", "Misé (USDC)", "Bénéfice (USDC)", "Rendement (%)", "IC 95 % bas (%)", "IC 95 % haut (%)", "Taux de réussite (%)", "Prix moyen payé"]
    ex = lambda its: [pct(mean([p["settle"] for p in its])), r2(wmean([(p["vwap"], p["cash"]) for p in its]), 3)]

    def split(titre, key, order=None):
        g = collections.OrderedDict()
        for p in res:
            g.setdefault(key(p), []).append(p)
        keys = [k for k in (order or sorted(g, key=lambda k: -sum(p["cash"] for p in g[k]))) if k in g]
        return T(titre, cols, [roi_row(k, g[k], extra=ex) for k in keys])

    hold = T("Tient-il jusqu'au règlement ?", ["Type d'opération", "Nombre"], [
        ["Achats", len(M["fills"])], ["Ventes", len(M["sells"])],
        ["Fusions de parts (MERGE)", M["others"].get("MERGE", (0, 0))[0]], ["Scissions (SPLIT)", M["others"].get("SPLIT", (0, 0))[0]],
        ["Conversions", M["others"].get("CONVERSION", (0, 0))[0]],
        ["Règlements automatiques (REDEEM)", M["others"].get("REDEEM", (0, 0))[0]],
        ["Positions réglées", len(res)], ["Positions encore ouvertes", len(P) - len(res)],
    ])
    evs = M["events"]
    cnt = collections.Counter(len(v) for v in evs.values())
    multi = T("Nombre de marchés pariés par match", ["Marchés pariés dans le match", "Matchs", "Part des matchs (%)", "Part de l'argent misé (%)"],
              [[k if k < 5 else "5 et plus", n, pct(n / len(evs)), pct(div(sum(p["cash"] for v in evs.values() if (len(v) == k if k < 5 else len(v) >= 5) for p in v),
                                                                             sum(p["cash"] for p in P)))]
               for k, n in [(k, cnt[k]) for k in (1, 2, 3, 4)] + [(5, sum(n for k, n in cnt.items() if k >= 5))] if n])
    # same direction or not within a match
    same = opp = 0
    same_cash = opp_cash = 0.0
    for ev, ps in evs.items():
        tm = collections.defaultdict(float)
        for p in ps:
            if p["team"]:
                tm[p["team"]] += p["cash"]
        if sum(1 for p in ps if p["team"]) >= 2:
            if len(tm) == 1:
                same += 1
                same_cash += sum(tm.values())
            else:
                opp += 1
                opp_cash += sum(tm.values())
    # both sides of the same market
    bc = collections.defaultdict(list)
    for p in P:
        bc[p["cid"]].append(p)
    both = [l for l in bc.values() if len(l) > 1]
    brow = []
    for l in sorted(both, key=lambda l: -sum(p["cash"] for p in l)):
        l = sorted(l, key=lambda p: -p["cash"])
        a, b = l[0], l[1]
        px = a["vwap"] + b["vwap"]
        hedged = min(a["shares"], b["shares"])
        brow.append([a["m"]["slug"], a["outcome"], r2(a["cash"], 0), r2(a["vwap"], 3), b["outcome"], r2(b["cash"], 0), r2(b["vwap"], 3),
                     r2(px, 3), pct(div(hedged, max(a["shares"], b["shares"]))),
                     r2((a["pnl"] or 0) + (b["pnl"] or 0), 0) if a["resolved"] and b["resolved"] else None])
    bt = T("Marchés achetés des deux côtés", ["Marché", "Côté principal", "Misé côté principal (USDC)", "Prix côté principal", "Autre côté", "Misé autre côté (USDC)", "Prix autre côté",
                                              "Somme des deux prix", "Part couverte (%)", "Bénéfice net (USDC)"], brow)
    both_cash = sum(p["cash"] for l in both for p in l)
    dirs = T("Plusieurs paris sur le même match : même sens ou couverture ?", ["Cas", "Matchs", "Misé (USDC)"], [
        ["Tous les paris sur la même équipe", same, r2(same_cash, 0)],
        ["Paris sur les deux équipes (marchés différents ou même marché)", opp, r2(opp_cash, 0)],
        ["Marchés achetés des deux côtés", len(both), r2(both_cash, 0)],
        ["dont somme des deux prix payés inférieure à 1", sum(1 for l in both if sum(p["vwap"] for p in l[:2]) < 1), None],
        ["dont plus de la moitié des parts couvertes par l'autre côté", sum(1 for l in both if min(p["shares"] for p in l[:2]) > 0.5 * max(p["shares"] for p in l[:2])), None],
    ])
    ty = split("Par type de marché", lambda p: p["label"])
    bo = split("Par format de match", lambda p: p["m"]["bo"])
    tier = split("Par niveau de tournoi (1 = élite, 5 = le plus bas ; donnée Polymarket)", lambda p: "Niveau " + p["m"]["tier"],
                 order=["Niveau %s" % t for t in ("1", "2", "3", "4", "5", "?")])
    sb = lambda p: next(bucket_label(a, b, " USDC") for a, b in STAKE_BUCKETS if a <= p["cash"] < b)
    stake = split("Par taille de mise sur la position", sb, order=[bucket_label(a, b, " USDC") for a, b in STAKE_BUCKETS])
    pb = lambda p: next("%.2f à %.2f" % (a, min(b, 1.0)) for a, b in PRICE_BUCKETS if a <= p["vwap"] < b)
    price = split("Par prix d'entrée", pb, order=["%.2f à %.2f" % (a, min(b, 1.0)) for a, b in PRICE_BUCKETS])
    n_multi = sum(1 for v in evs.values() if len(v) > 1)
    resume = ("Oui, il garde tout jusqu'au règlement : %s achats, %d vente, %d fusion de parts. Il parie plusieurs marchés du même match dans %s %% des matchs, "
              "presque toujours sur la même équipe (%d matchs sur %d). Il a acheté les deux côtés d'un même marché %d fois (%s %% de l'argent misé) : "
              "c'est une façon de réduire une position sans vendre, trop rare et trop déséquilibrée pour être de l'arbitrage." % (
                  fr_int(len(M["fills"])), len(M["sells"]), M["others"].get("MERGE", (0, 0))[0], frn(100 * n_multi / len(evs), 0), same, same + opp, len(both),
                  frn(100 * div(both_cash, sum(p["cash"] for p in P)))))
    warn = ["Acheter l'issue opposée revient économiquement à vendre : « aucune vente » ne veut donc pas dire « aucune sortie » dans les %d marchés achetés des deux côtés." % len(both),
            "Les découpages par catégorie reposent sur peu de matchs chacun : un rendement élevé dans une ligne n'est pas une preuve.",
            "Le niveau de tournoi vient du champ « leagueTier » de Polymarket ; il n'a pas été vérifié auprès d'une autre source.",
            "Plusieurs positions sur un même match ne sont pas des paris indépendants : un seul résultat les fait gagner ou perdre ensemble."]
    return {"id": "structure", "titre": "2. Comment parie-t-il ?", "resume": resume,
            "tableaux": [hold, multi, dirs, bt, ty, bo, tier, stake, price], "avertissements": warn}, {
        "same": same, "opp": opp, "both": len(both), "multi_share": n_multi / len(evs)}


def sec_maker(M, ctx):
    fl = [f for f in M["fills"] if f["pnl"] is not None]
    allf = M["fills"]
    rows = []
    for lab, tk in (("Preneur (prend un prix affiché)", True), ("Teneur de marché (ordre en attente)", False)):
        fs = [f for f in fl if f["taker"] == tk]
        fa = [f for f in allf if f["taker"] == tk]
        rr = roi_row(lab, fs, cash=lambda f: f["cash"], pnl=lambda f: f["pnl"])
        clv = div(sum(f["size"] * (f["close"] - f["price"]) for f in fs if f["close"] is not None),
                  sum(f["size"] * f["price"] for f in fs if f["close"] is not None))
        rows.append([lab, len(fa), pct(div(len(fa), len(allf))), r2(sum(f["cash"] for f in fa), 0),
                     pct(div(sum(f["cash"] for f in fa), sum(f["cash"] for f in allf)))] + rr[3:] +
                    [r2(div(sum(f["size"] * f["price"] for f in fs), sum(f["size"] for f in fs)), 3), r2(sum(f["fee"] for f in fa), 0), pct(clv, 2)])
    mt = T("Preneur contre teneur de marché", ["Mode d'exécution", "Ordres exécutés", "Part des ordres (%)", "Misé (USDC)", "Part de l'argent (%)",
                                               "Bénéfice (USDC)", "Rendement (%)", "IC 95 % bas (%)", "IC 95 % haut (%)", "Prix moyen payé",
                                               "Frais payés (USDC)", "Écart au prix de clôture (% de la mise)"], rows)
    fees_all = sum(f["fee"] for f in allf)
    taker_not = sum(f["size"] * f["price"] for f in allf if f["taker"])
    ft = T("Frais et remises", ["Poste", "Valeur"], [
        ["Frais payés, toutes positions (USDC)", r2(fees_all)],
        ["Frais en % des montants pris au prix affiché", pct(div(fees_all, taker_not), 2)],
        ["Remises preneur reçues (USDC)", r2(ctx["reb_t"])], ["Remises teneur de marché reçues (USDC)", r2(ctx["reb_m"])],
        ["Remises / frais (%)", pct(div(ctx["reb_t"] + ctx["reb_m"], fees_all))],
        ["Frais nets de remises (USDC)", r2(fees_all - ctx["reb_t"] - ctx["reb_m"])],
        ["Frais nets en % de l'argent misé", pct(div(fees_all - ctx["reb_t"] - ctx["reb_m"], sum(f["cash"] for f in allf)), 2)],
    ])
    P = list(M["P"].values())
    op = T("Comment la position est-elle ouverte ?", ["Premier ordre de la position", "Positions", "Part (%)", "Misé (USDC)", "Part de l'argent venant d'ordres en attente (%)"], [
        [lab, len(ps), pct(div(len(ps), len(P))), r2(sum(p["cash"] for p in ps), 0),
         pct(div(sum(p["cash"] - p["taker_cash"] for p in ps), sum(p["cash"] for p in ps)))]
        for lab, ps in (("Preneur", [p for p in P if p["open_taker"]]), ("Teneur de marché", [p for p in P if not p["open_taker"]]))])
    tk_share = div(sum(f["cash"] for f in allf if f["taker"]), sum(f["cash"] for f in allf))
    n_tk = sum(1 for f in allf if f["taker"])
    resume = ("En nombre d'ordres exécutés, %s %% sont des achats au prix affiché (preneur) ; en argent c'est %s %% : ce wallet prend les prix, il ne tient pas le marché. "
              "Il a payé %s USDC de frais et reçu %s USDC de remises." % (frn(100 * div(n_tk, len(allf)), 0), frn(100 * tk_share, 0), fr_int(fees_all),
                                                                         fr_int(ctx["reb_t"] + ctx["reb_m"])))
    warn = ["Le rendement par mode d'exécution mélange deux effets : le mode lui-même et le fait que les ordres en attente sont placés à des prix et à des moments différents.",
            "Un ordre en attente n'est exécuté que si quelqu'un accepte de vendre à ce prix : un suiveur ne peut pas reproduire ces exécutions après coup.",
            "Les remises dépendent du programme de Polymarket en vigueur ; un suiveur ne doit pas compter dessus."]
    return {"id": "maker_taker", "titre": "3. Prend-il les prix ou pose-t-il des ordres ?", "resume": resume,
            "tableaux": [mt, ft, op], "avertissements": warn}, {"taker_share": tk_share, "fees_all": fees_all}


def sec_timing(M):
    fl = [f for f in M["fills"] if f["lead"] is not None]
    P = [p for p in M["P"].values() if p["start"]]
    tot = sum(f["cash"] for f in fl)
    rows = []
    for lab, lo, hi in LEAD_BUCKETS:
        fs = [f for f in fl if lo <= f["lead"] < hi]
        fr = [f for f in fs if f["pnl"] is not None]
        c, g = sum(f["cash"] for f in fr), sum(f["pnl"] for f in fr)
        clv = div(sum(f["size"] * (f["close"] - f["price"]) for f in fr if f["close"] is not None),
                  sum(f["size"] * f["price"] for f in fr if f["close"] is not None))
        rows.append([lab, len(fs), r2(sum(f["cash"] for f in fs), 0), pct(div(sum(f["cash"] for f in fs), tot)),
                     pct(div(sum(f["cash"] for f in fs if f["taker"]), sum(f["cash"] for f in fs))), r2(g, 0), pct(div(g, c)), pct(clv, 2)])
    dist = T("Quand les ordres sont-ils exécutés, par rapport à l'heure prévue du match ?",
             ["Moment de l'exécution", "Ordres", "Misé (USDC)", "Part de l'argent (%)", "Part prise au prix affiché (%)", "Bénéfice (USDC)", "Rendement (%)",
              "Écart au prix de clôture (% de la mise)"], rows)
    qs = [0.05, 0.25, 0.5, 0.75, 0.95]
    lead_w = [(f["lead"] / 3600.0, f["cash"]) for f in fl]
    qt = T("Répartition (heures avant l'heure prévue du match)", ["Mesure", "5 %", "25 %", "Médiane", "75 %", "95 %"], [
        ["Ordres, pondérés par l'argent"] + [r2(wquantile(lead_w, q), 2) for q in qs],
        ["Premier ordre de chaque position"] + [r2(quantile([(p["start"] - p["t0"]) / 3600.0 for p in P], q), 2) for q in qs],
        ["Dernier ordre de chaque position"] + [r2(quantile([(p["start"] - p["t1"]) / 3600.0 for p in P], q), 2) for q in qs],
        ["Durée de construction d'une position (heures)"] + [r2(quantile([(p["t1"] - p["t0"]) / 3600.0 for p in P], q), 2) for q in qs],
        ["Nombre d'ordres par position"] + [r2(quantile([p["n"] for p in P], q), 0) for q in qs],
        ["Part de la mise finale posée dans les 10 premières minutes (%)"] + [pct(quantile([div(p["bursts"][0]["cash"], p["cash"]) for p in P], q)) for q in qs],
        ["Montant des 20 premières secondes (USDC)"] + [r2(quantile([p["burst0_cash"] for p in P], q), 0) for q in qs],
    ])
    live = [f for f in fl if f["lead"] < 0]
    lt = collections.OrderedDict()
    for f in live:
        k = TYPE_FR.get(M["markets"][f["cid"]]["type"], M["markets"][f["cid"]]["type"])
        lt.setdefault(k, []).append(f)
    lrows = [[k, len(v), r2(sum(f["cash"] for f in v), 0), pct(div(sum(f["cash"] for f in v if f["taker"]), sum(f["cash"] for f in v))),
              r2(quantile([-f["lead"] / 60.0 for f in v], 0.5), 0), r2(max(-f["lead"] / 60.0 for f in v), 0),
              r2(sum(f["pnl"] for f in v if f["pnl"] is not None), 0)] for k, v in lt.items()]
    lv = T("Ordres exécutés après l'heure prévue", ["Type de marché", "Ordres", "Misé (USDC)", "Part prise au prix affiché (%)",
                                                   "Retard médian (minutes)", "Retard maximal (minutes)", "Bénéfice (USDC)"], lrows)
    n_live_pos = len(set(f["token"] for f in live))
    live_cash = sum(f["cash"] for f in live)
    resume = ("C'est un parieur d'avant-match : %s %% de l'argent est placé avant l'heure prévue du match, la moitié plus de %s heures avant. "
              "Une position commence en médiane %s h avant le match, par un petit ordre, puis grossit pendant %s h." % (
                  frn(100 * (1 - div(live_cash, tot))), frn(wquantile(lead_w, 0.5) or 0),
                  frn(quantile([(p["start"] - p["t0"]) / 3600.0 for p in P], 0.5)), frn(quantile([(p["t1"] - p["t0"]) / 3600.0 for p in P], 0.5))))
    warn = ["L'heure utilisée est l'heure PRÉVUE du match (gameStartTime), pas l'heure réelle du coup d'envoi : un match en retard fait passer des paris d'avant-match pour des paris en direct.",
            "Les %d ordres après l'heure prévue (%s USDC, %d positions) sont trop peu nombreux pour conclure quoi que ce soit sur un jeu en direct ; "
            "une partie concerne des cartes 2 ou 3, qui partagent l'heure prévue du match et n'avaient donc pas forcément commencé." % (len(live), fr_int(live_cash), n_live_pos),
            "Polymarket vide le carnet d'ordres au début du match (clearBookOnStart) : les ordres en attente du wallet ne restent pas en jeu pendant le match."]
    return {"id": "timing", "titre": "4. Quand parie-t-il ?", "resume": resume, "tableaux": [dist, qt, lv], "avertissements": warn}, {
        "pre_share": 1 - div(live_cash, tot), "lead_med": quantile([(p["start"] - p["t0"]) / 3600.0 for p in P], 0.5),
        "build_med": quantile([(p["t1"] - p["t0"]) / 3600.0 for p in P], 0.5)}


def fol_stats(items, price_of, weight=lambda p: p["cash"], wal_pnl=lambda p: p["pnl"], spread=BASE_SPREAD, cap=None):
    """Follower vs wallet on the same resolved items. price_of(item) -> reference price or None.
    Returns dict with flat / stake-weighted ROI (+ match-bootstrap CI) for follower and wallet."""
    rows = []
    for it in items:
        p = it.get("p", it)
        if not p["resolved"]:
            continue
        px = price_of(it)
        if px is None:
            continue
        f = px + spread
        if cap is not None and f > p["p0"] + cap:
            continue
        rate = p["m"]["fee_rate"]
        rows.append({"event": p["event"], "roi": follower_roi(f, p["settle"], rate), "w": weight(it), "wpnl": wal_pnl(it),
                     "wroi": p["roi1"], "slip": f - p["p0"], "f": f, "slip_v": f - p["vwap"]})
    if not rows:
        return None
    flat = boot_ratio(by_match(rows, lambda r: r["roi"], lambda r: 1.0), n_boot=2000)
    wt = boot_ratio(by_match(rows, lambda r: r["roi"] * r["w"], lambda r: r["w"]), n_boot=2000)
    return {"n": len(rows), "flat": flat, "wt": wt, "w_flat": mean([r["wroi"] for r in rows]),
            "w_wt": div(sum(r["wpnl"] for r in rows), sum(r["w"] for r in rows)),
            "slip": mean([r["slip"] for r in rows]), "slip_w": wmean([(r["slip"], r["w"]) for r in rows]),
            "slip_med": quantile([r["slip"] for r in rows], 0.5), "slip_v": mean([r["slip_v"] for r in rows])}


def delay_label(d):
    return "%d s" % d if d < 60 else "%d min" % (d // 60)


def sec_copy(M, ctx):
    P = list(M["P"].values())
    res = [p for p in P if p["resolved"]]
    have_ph = [p for p in P if p["path"].t]
    cols = ["Délai après le premier ordre du wallet", "Positions", "Couverture (%)", "Retard réel moyen du point de prix (s)",
            "Surcoût moyen par rapport au premier prix du wallet (centimes)", "Rendement suiveur, mise fixe (%)", "IC 95 % bas (%)", "IC 95 % haut (%)",
            "Rendement wallet, mise fixe, mêmes positions (%)", "Rendement suiveur, mises proportionnelles (%)", "IC 95 % bas, mises proportionnelles (%)", "IC 95 % haut, mises proportionnelles (%)",
            "Rendement wallet, mêmes positions (%)"]
    main_rows, key = [], {}
    for d in DELAYS:
        st = fol_stats(res, lambda p, d=d: p["mid"][d])
        if not st:
            continue
        key[d] = st
        lag = mean([d + p["lag"][d] for p in res if p["mid"][d] is not None])
        main_rows.append([delay_label(d), st["n"], pct(st["n"] / len(res)), r2(lag, 0), r2(100 * st["slip"], 2),
                          pct(st["flat"][0]), pct(st["flat"][1]), pct(st["flat"][2]), pct(st["w_flat"]),
                          pct(st["wt"][0]), pct(st["wt"][1]), pct(st["wt"][2]), pct(st["w_wt"])])
    t_main = T("Rendement d'un suiveur qui entre une seule fois, X après le premier ordre du wallet (prix à la minute + %.1f centime d'écart + frais)" % (100 * BASE_SPREAD),
               cols, main_rows)
    # sensitivity to the spread assumption
    sens = []
    for d in DELAYS:
        for s in SPREADS:
            st = fol_stats(res, lambda p, d=d: p["mid"][d], spread=s)
            if st:
                sens.append([delay_label(d), r2(100 * s, 1), pct(st["flat"][0]), pct(st["wt"][0])])
    t_sens = T("Sensibilité à l'hypothèse d'écart de prix (en centimes ajoutés au prix à la minute)",
               ["Délai", "Écart ajouté (centimes)", "Rendement suiveur, mise fixe (%)", "Rendement suiveur, mises proportionnelles (%)"], sens)
    # price cap rule
    caps = []
    for d in (60, 300, 900):
        for cap in (0.01, 0.02, 0.03, 0.05):
            st = fol_stats(res, lambda p, d=d: p["mid"][d], cap=cap)
            if st:
                caps.append([delay_label(d), r2(100 * cap, 0), st["n"], pct(st["n"] / len(res)), pct(st["flat"][0]), pct(st["flat"][1]), pct(st["flat"][2]),
                             pct(st["wt"][0])])
    t_cap = T("Règle simple : ne suivre que si le prix n'a pas dépassé le premier prix du wallet de plus de N centimes",
              ["Délai", "Plafond (centimes au-dessus du prix du wallet)", "Positions suivies", "Part des positions (%)", "Rendement, mise fixe (%)",
               "IC 95 % bas (%)", "IC 95 % haut (%)", "Rendement, mises proportionnelles (%)"], caps)
    # wait until the wallet has committed at least X on the position, then enter 1 minute later
    thr = []
    for X in (0, 1000, 5000, 10000, 20000):
        items = []
        for p in res:
            cum, tx = 0.0, None
            for f in p["fills"]:
                cum += f["cash"]
                if cum >= X:
                    tx = f["ts"]
                    break
            if tx is not None:
                items.append({"p": p, "event": p["event"], "t": tx})
        st = fol_stats(items, lambda it: it["p"]["path"].after(it["t"] + 60)[0], weight=lambda it: it["p"]["cash"], wal_pnl=lambda it: it["p"]["pnl"])
        if st:
            lead = quantile([(it["p"]["start"] - it["t"]) / 3600.0 for it in items if it["p"]["start"]], 0.5)
            thr.append(["dès le premier ordre" if X == 0 else "%s USDC" % fr_int(X), st["n"], r2(lead, 1), r2(100 * st["slip_v"], 2),
                        pct(st["flat"][0]), pct(st["flat"][1]), pct(st["flat"][2]), pct(st["w_flat"])])
            key[("x", X)] = st
    t_thr = T("Attendre que le wallet ait engagé un certain montant sur la position, puis entrer 1 minute après (mise fixe)",
              ["Montant déjà engagé par le wallet", "Positions", "Heures avant le match (médiane)", "Prix du suiveur − prix moyen final du wallet (centimes)",
               "Rendement suiveur, mise fixe (%)", "IC 95 % bas (%)", "IC 95 % haut (%)", "Rendement wallet, mise fixe, mêmes positions (%)"], thr)
    # burst level: follow the first fill and every later increase
    bursts = [b for p in res for b in p["bursts"]]
    brow = []
    for d in DELAYS:
        st = fol_stats(bursts, lambda b, d=d: b["p"]["path"].after(b["t"] + d)[0], weight=lambda b: b["cash"], wal_pnl=lambda b: b["pnl"])
        if st:
            brow.append([delay_label(d), st["n"], pct(st["n"] / len(bursts)), pct(st["wt"][0]), pct(st["wt"][1]), pct(st["wt"][2]), pct(st["w_wt"]),
                         pct(st["wt"][0] - st["w_wt"])])
            key[("b", d)] = st
    t_burst = T("Suiveur qui copie aussi chaque renfort (une alerte par salve de 10 minutes), mêmes montants que le wallet",
                ["Délai après le début de la salve", "Salves", "Couverture (%)", "Rendement suiveur (%)", "IC 95 % bas (%)", "IC 95 % haut (%)",
                 "Rendement wallet, mêmes salves (%)", "Écart suiveur − wallet (points)"], brow)
    # by opening mode
    mrow = []
    for lab, ps in (("Position ouverte en prenant un prix affiché", [p for p in res if p["open_taker"]]),
                    ("Position ouverte par un ordre en attente", [p for p in res if not p["open_taker"]])):
        for d in (60, 300, 900):
            st = fol_stats(ps, lambda p, d=d: p["mid"][d])
            if st:
                mrow.append([lab, delay_label(d), st["n"], r2(sum(p["cash"] for p in ps), 0), r2(100 * st["slip"], 2), pct(st["flat"][0]), pct(st["flat"][1]),
                             pct(st["flat"][2]), pct(st["w_flat"]), pct(st["wt"][0]), pct(st["w_wt"])])
    t_mode = T("Selon la façon dont le wallet a ouvert la position", ["Ouverture", "Délai", "Positions", "Misé par le wallet (USDC)",
                                                                    "Surcoût moyen (centimes)", "Rendement suiveur, mise fixe (%)", "IC 95 % bas (%)", "IC 95 % haut (%)",
                                                                    "Rendement wallet, mise fixe (%)", "Rendement suiveur, mises proportionnelles (%)",
                                                                    "Rendement wallet (%)"], mrow)
    # tape: prices really paid by other buyers after the wallet's first fill
    trow = []
    tp = [p for p in res if p["asks"] is not None]
    for d in DELAYS:
        for lab, oth in (("autres acheteurs seulement", True), ("tous les acheteurs, wallet compris", False)):
            st = fol_stats(tp, lambda p, d=d, oth=oth: tape_entry(p["asks"], p["asks_t"], p["t0"] + d, oth), spread=0.0)
            if st:
                trow.append([delay_label(d), lab, st["n"], pct(st["n"] / len(res)), r2(100 * st["slip"], 2), r2(100 * st["slip_med"], 2),
                             pct(st["flat"][0]), pct(st["flat"][1]), pct(st["flat"][2]), pct(st["wt"][0]), pct(st["wt"][1]), pct(st["wt"][2])])
                key[("t", d, oth)] = st
    t_tape = T("Contrôle avec les achats réellement exécutés sur le marché (à la seconde) : prix moyen des 100 premiers USDC achetés après le délai, dans les 15 minutes",
               ["Délai", "Achats pris en compte", "Positions", "Couverture (%)", "Surcoût moyen (centimes)", "Surcoût médian (centimes)",
                "Rendement, mise fixe (%)", "IC 95 % bas (%)", "IC 95 % haut (%)", "Rendement, mises proportionnelles (%)", "IC 95 % bas, mises proportionnelles (%)", "IC 95 % haut, mises proportionnelles (%)"], trow)
    # price path around the first fill
    com = [p for p in P if p["pre"] and p["mid_before"] is not None and p["close"] is not None and all(p["mid"][d] is not None for d in (60, 300, 900))]
    steps = [("Premier prix payé par le wallet", lambda p: p["p0"]), ("Prix 1 minute après", lambda p: p["mid"][60]),
             ("Prix 5 minutes après", lambda p: p["mid"][300]), ("Prix 15 minutes après", lambda p: p["mid"][900]),
             ("Prix moyen final du wallet sur la position", lambda p: p["vwap"]),
             ("Prix juste avant l'heure prévue du match (clôture)", lambda p: p["close"])]
    groups = [("toutes", com), ("ouvertes en preneur", [p for p in com if p["open_taker"]]), ("ouvertes par ordre en attente", [p for p in com if not p["open_taker"]])]
    prow = []
    for lab, fn in steps:
        row = [lab]
        for _, ps in groups:
            row.append(r2(100 * mean([fn(p) - p["mid_before"] for p in ps]), 2) if ps else None)
        row.insert(2, r2(100 * wmean([(fn(p) - p["mid_before"], p["cash"]) for p in com]), 2) if com else None)
        prow.append(row)
    prow.append(["Nombre de positions", len(com), len(com), len(groups[1][1]), len(groups[2][1])])
    t_path = T("Trajectoire du prix autour du premier ordre (centimes au-dessus du prix affiché juste avant l'ordre)",
               ["Étape", "Toutes les positions (moyenne)", "Toutes, pondéré par la mise", "Ouvertes en preneur", "Ouvertes par ordre en attente"], prow)
    # impact vs size of first burst
    irow = []
    for lo, hi in ((0, 100), (100, 1000), (1000, 5000), (5000, 1e12)):
        ps = [p for p in com if lo <= p["burst0_cash"] < hi]
        if ps:
            irow.append([bucket_label(lo, hi, " USDC"), len(ps), r2(100 * mean([p["p0"] - p["mid_before"] for p in ps]), 2),
                         r2(100 * mean([p["mid"][60] - p["mid_before"] for p in ps]), 2), r2(100 * mean([p["mid"][900] - p["mid_before"] for p in ps]), 2),
                         r2(100 * mean([p["close"] - p["mid_before"] for p in ps]), 2), r2(100 * mean([p["close"] - p["mid"][60] for p in ps]), 2)])
    t_imp = T("Le wallet déplace-t-il le prix lui-même ? Mouvement selon la taille de sa première salve (20 s)",
              ["Taille de la première salve", "Positions", "Premier prix payé − prix d'avant (centimes)", "Prix 1 min après − prix d'avant (centimes)",
               "Prix 15 min après − prix d'avant (centimes)", "Clôture − prix d'avant (centimes)", "Clôture − prix 1 min après (centimes)"], irow)
    # closing line value
    pre = [p for p in P if p["close"] is not None]
    pre_r = [p for p in pre if p["resolved"]]

    def clv_row(lab, items, px, w, ev=lambda it: it["event"]):
        its = [it for it in items if px(it) is not None]
        if not its:
            return None
        g = collections.OrderedDict()
        for it in its:
            c = it["close"] if "close" in it else None
            a = g.setdefault(ev(it), [0.0, 0.0])
            a[0] += w(it) * (c - px(it)) / px(it)
            a[1] += w(it)
        bt = boot_ratio([tuple(v) for v in g.values()], n_boot=2000)
        return [lab, len(its), r2(100 * mean([it["close"] - px(it) for it in its]), 2), pct(div(sum(1 for it in its if it["close"] > px(it) + 1e-9), len(its))),
                pct(mean([(it["close"] - px(it)) / px(it) for it in its]), 2), pct(bt[0], 2), pct(bt[1], 2), pct(bt[2], 2)]
    crow = [clv_row("Wallet : prix moyen de la position", pre, lambda p: p["vwap"], lambda p: p["notional"]),
            clv_row("Wallet : premier prix payé", pre, lambda p: p["p0"], lambda p: p["notional"]),
            clv_row("Wallet : ordres pris au prix affiché", [f for f in M["fills"] if f["close"] is not None and f["taker"]], lambda f: f["price"], lambda f: f["size"] * f["price"]),
            clv_row("Wallet : ordres en attente exécutés", [f for f in M["fills"] if f["close"] is not None and not f["taker"]], lambda f: f["price"], lambda f: f["size"] * f["price"])]
    for d in (60, 300, 900):
        crow.append(clv_row("Suiveur %s après (prix à la minute + %.1f centime)" % (delay_label(d), 100 * BASE_SPREAD),
                            [p for p in pre if p["mid"][d] is not None and p["t0"] + d < p["start"]], lambda p, d=d: p["mid"][d] + BASE_SPREAD, lambda p: p["notional"]))
    crow = [r for r in crow if r]
    t_clv = T("Le prix payé bat-il le prix de clôture (dernier prix avant l'heure prévue) ? Avant frais",
              ["Qui / quel prix", "Observations", "Écart moyen clôture − prix payé (centimes)", "Part des cas où la clôture est plus haute (%)",
               "Écart moyen (% du prix payé)", "Écart pondéré par la mise (% de la mise)", "IC 95 % bas (%)", "IC 95 % haut (%)"], crow)
    # decomposition of the wallet's PnL
    d_fee = sum(p["fees"] for p in pre_r)
    d_clv = sum(p["shares"] * (p["close"] - p["vwap"]) for p in pre_r)
    d_res = sum(p["shares"] * (p["settle"] - p["close"]) for p in pre_r)
    d_cash = sum(p["cash"] for p in pre_r)
    g_res = by_match(pre_r, lambda p: p["shares"] * (p["settle"] - p["close"]), lambda p: p["shares"] * p["close"])
    b_res = boot_ratio(g_res)
    z_res = cluster_z([x[0] for x in g_res])
    close_flat = fol_stats(pre_r, lambda p: p["close"], spread=BASE_SPREAD)
    t_dec = T("D'où vient le bénéfice du wallet ? (positions d'avant-match réglées avec un prix de clôture connu)", ["Composante", "USDC", "% de l'argent misé"], [
        ["Gain dû au mouvement du prix entre l'achat et la clôture", r2(d_clv, 0), pct(div(d_clv, d_cash), 2)],
        ["Gain dû au résultat du match par rapport au prix de clôture", r2(d_res, 0), pct(div(d_res, d_cash), 2)],
        ["Frais", r2(-d_fee, 0), pct(div(-d_fee, d_cash), 2)],
        ["Bénéfice net", r2(d_clv + d_res - d_fee, 0), pct(div(d_clv + d_res - d_fee, d_cash), 2)],
        ["Score z du gain « résultat contre clôture » (groupé par match)", r2(z_res, 2), None],
        ["IC 95 % bas du gain « résultat contre clôture » (% de la valeur à la clôture)", None, pct(b_res[1], 2)],
        ["IC 95 % haut", None, pct(b_res[2], 2)],
        ["Rendement de celui qui achète seulement à la clôture, mise fixe (%)", None, pct(close_flat["flat"][0], 2) if close_flat else None],
        ["Rendement de celui qui achète seulement à la clôture, mises proportionnelles (%)", None, pct(close_flat["wt"][0], 2) if close_flat else None],
    ])
    # observed crossing cost of the wallet itself
    tk = [p for p in P if p["open_taker"] and p["mid_before"] is not None]
    xs = [p["p0"] - p["mid_before"] for p in tk]
    t_sp = T("Écart observé : premier prix payé par le wallet (en preneur) moins le prix affiché juste avant", ["Mesure", "Centimes"], [
        ["Médiane", r2(100 * quantile(xs, 0.5), 2)], ["Moyenne", r2(100 * mean(xs), 2)], ["3e quartile", r2(100 * quantile(xs, 0.75), 2)],
        ["90e centile", r2(100 * quantile(xs, 0.9), 2)], ["Positions mesurées", len(xs)]])
    k60 = key.get(60)
    ds = [d for d in key if isinstance(d, int)]
    resume = ("Le retard coûte peu : 1 à 15 minutes après le premier ordre, le prix n'est qu'environ %s à %s centimes au-dessus du premier prix du wallet, et il ne s'envole pas ensuite. "
              "Mais ce qui est copié est fragile : à mise égale par pari le suiveur simulé gagne %s %% (de %s %% à %s %%, donc peut-être rien) ; les %s %% obtenus en copiant aussi ses tailles viennent "
              "de quelques gros paris gagnés, et son prix d'achat ne bat pas le prix de clôture (%s %% de la mise)." % (
                  frn(100 * min(key[d]["slip"] for d in ds)), frn(100 * max(key[d]["slip"] for d in ds)),
                  frn(100 * k60["flat"][0]) if k60 else "?", frn(100 * (k60["flat"][1] or 0)) if k60 else "?", frn(100 * (k60["flat"][2] or 0)) if k60 else "?",
                  frn(100 * k60["wt"][0], 0) if k60 else "?", frn(100 * (div(d_clv, d_cash) or 0))))
    warn = [
        "Résolution : l'historique de prix a un point par minute. Les lignes « 10 s » et « 30 s » utilisent le premier point disponible après ce délai (souvent 30 à 70 s après l'ordre) : "
        "elles ne mesurent pas réellement un délai inférieur à la minute. Seul le tableau des achats exécutés est à la seconde.",
        "Le prix de l'historique est un prix milieu ou le dernier prix traité, pas le prix auquel on peut réellement acheter. On ajoute %.1f centime d'écart par hypothèse ; "
        "la sensibilité est donnée de 0 à 2 centimes. La profondeur réelle du carnet à ces instants n'est pas connue." % (100 * BASE_SPREAD),
        "Le suiveur est supposé payer les frais de preneur (5 % × prix × (1 − prix)) et ne toucher aucune remise.",
        "Le rendement du suiveur est calculé sur les mêmes matchs que celui du wallet : s'il y a eu de la chance dans ces résultats, le suiveur simulé en hérite. "
        "Ce tableau mesure le coût du retard, pas la réalité de l'avantage.",
        "Les positions du wallet se construisent sur des heures : entrer une seule fois après le premier ordre n'est pas la même stratégie que la sienne (prix moyen final différent).",
        "Achats exécutés : ils montrent des prix réellement payés par quelqu'un, pour de petites tailles (100 USDC) ; ils ne disent pas combien on pouvait acheter à ce prix, "
        "et ils n'existent que pour une partie des positions (voir la colonne couverture).",
        "Le prix de clôture n'est pas un repère indépendant : le wallet représente lui-même une grande part des achats d'avant-match de son côté (voir section 6), "
        "donc il pousse le prix vers son propre prix moyen.",
        "Les règles « plafond de prix » et « montant déjà engagé » ont été cherchées sur ces mêmes données : leurs bons résultats sont à confirmer sur de nouveaux matchs.",
    ]
    return {"id": "copiabilite", "titre": "5. Peut-on le copier après coup ?", "resume": resume,
            "tableaux": [t_main, t_sens, t_cap, t_thr, t_burst, t_mode, t_tape, t_path, t_imp, t_clv, t_dec, t_sp], "avertissements": warn}, {
        "key": key, "clv_w": div(d_clv, d_cash), "res_w": div(d_res, d_cash), "z_res": z_res, "b_res": b_res, "n_ph": len(have_ph),
        "close_flat": close_flat, "spread_med": quantile(xs, 0.5)}


def sec_blind(M, ctx):
    P = list(M["P"].values())
    res = [p for p in P if p["resolved"]]
    tabs = []
    # --- liquidity from the tape
    tp = [p for p in P if p["asks"] is not None and p["pre"]]

    def avail(p, t_from, t_to, cap, incl_wallet=False):
        i = bisect.bisect_left(p["asks_t"], t_from)
        tot = 0.0
        lim = p["burst0_vwap"] + cap if cap is not None else 9.0
        while i < len(p["asks"]) and p["asks"][i][0] <= t_to:
            _, price, size, isw = p["asks"][i]
            i += 1
            if (incl_wallet or not isw) and price <= lim + 1e-9:
                tot += size * price
        return tot
    lrow = []
    for wl, tto in (("dans les 15 minutes suivant le premier ordre", lambda p: min(p["t0"] + 900, p["start"])),
                    ("jusqu'à l'heure prévue du match", lambda p: p["start"])):
        for cl, cap, iw in (("autres acheteurs, au prix du wallet + 1 centime au plus", 0.01, False),
                            ("autres acheteurs, au prix du wallet + 2 centimes au plus", 0.02, False),
                            ("autres acheteurs, à n'importe quel prix", None, False),
                            ("tous acheteurs, wallet compris, au prix du wallet + 2 centimes au plus", 0.02, True)):
            xs = [avail(p, p["t0"] + 10, tto(p), cap, iw) for p in tp]
            if xs:
                lrow.append([wl, cl, len(xs), r2(quantile(xs, 0.25), 0), r2(quantile(xs, 0.5), 0), r2(quantile(xs, 0.75), 0),
                             pct(div(sum(1 for x in xs if x >= 100), len(xs))), pct(div(sum(1 for x in xs if x >= 1000), len(xs))),
                             pct(div(sum(1 for x in xs if x <= 0), len(xs)))])
    tabs.append(T("Liquidité : combien a réellement été acheté du même côté après le premier ordre du wallet ? (USDC par position, prix de référence = prix moyen de ses 20 premières secondes)",
                  ["Fenêtre", "Acheteurs et limite de prix", "Positions", "1er quartile (USDC)", "Médiane (USDC)", "3e quartile (USDC)",
                   "Positions avec au moins 100 USDC achetés (%)", "Positions avec au moins 1 000 USDC (%)", "Positions sans aucun achat (%)"], lrow))
    # wallet share of pre-match buying on its side
    srow = []
    groups = collections.OrderedDict()
    for p in tp:
        groups.setdefault(TYPE_FR.get(p["m"]["type"], "Handicap de manches (une carte)" if p["m"]["type"].startswith("round") else p["m"]["type"]), []).append(p)
    groups["Tous les marchés"] = tp
    for lab, ps in groups.items():
        num = den = 0.0
        shares = []
        for p in ps:
            i = bisect.bisect_right(p["asks_t"], p["start"])
            allv = sum(a[1] * a[2] for a in p["asks"][:i])
            wv = sum(a[1] * a[2] for a in p["asks"][:i] if a[3])
            num += wv
            den += allv
            if allv > 0:
                shares.append(wv / allv)
        srow.append([lab, len(ps), r2(den, 0), pct(div(num, den)), pct(quantile(shares, 0.5)), r2(quantile([p["m"]["volume"] for p in ps], 0.5), 0)])
    tabs.append(T("Poids du wallet dans les achats d'avant-match de son côté (achats au prix affiché uniquement)",
                  ["Type de marché", "Positions", "Achats d'avant-match de ce côté, tous acheteurs (USDC)", "Part du wallet (%)",
                   "Part du wallet, médiane par position (%)", "Volume total médian du marché, direct compris (parts)"], srow))
    # --- regime: weekly
    wk = collections.OrderedDict()
    for p in sorted(res, key=lambda p: p["start"] or p["t0"]):
        wk.setdefault(time.strftime("%G-S%V", time.gmtime(p["start"] or p["t0"])), []).append(p)
    wrow = []
    for k, ps in wk.items():
        rr = roi_row(k, ps)
        cps = [p for p in ps if p["close"] is not None]
        clv = div(sum(p["shares"] * (p["close"] - p["vwap"]) for p in cps), sum(p["notional"] for p in cps))
        f60 = fol_stats(ps, lambda p: p["mid"][60])
        wrow.append([k, len(set(p["event"] for p in ps))] + rr[1:] + [pct(clv, 2), pct(mean([p["roi1"] for p in ps])), pct(f60["flat"][0]) if f60 else None])
    tabs.append(T("L'avantage s'use-t-il ? Par semaine (date prévue du match)",
                  ["Semaine", "Matchs", "Positions", "Misé (USDC)", "Bénéfice (USDC)", "Rendement (%)", "IC 95 % bas (%)", "IC 95 % haut (%)",
                   "Écart au prix de clôture (% de la mise)", "Rendement à mise fixe (%)", "Rendement suiveur à 1 min, mise fixe (%)"], wrow))
    srt = sorted(res, key=lambda p: (p["start"] or p["t0"], p["token"]))
    evs_order = []
    for p in srt:
        if p["event"] not in evs_order:
            evs_order.append(p["event"])
    half = set(evs_order[:len(evs_order) // 2])
    hrow = []
    for lab, ps in (("Première moitié des matchs", [p for p in srt if p["event"] in half]), ("Seconde moitié des matchs", [p for p in srt if p["event"] not in half])):
        if ps:
            rr = roi_row(lab, ps)
            fb = boot_ratio(by_match(ps, lambda p: p["roi1"], lambda p: 1.0), n_boot=2000)
            hrow.append(rr + [pct(fb[0]), pct(fb[1]), pct(fb[2])])
    tabs.append(T("Première moitié contre seconde moitié de l'historique", ["Période", "Positions", "Misé (USDC)", "Bénéfice (USDC)", "Rendement (%)", "IC 95 % bas (%)",
                                                                           "IC 95 % haut (%)", "Rendement à mise fixe (%)", "IC 95 % bas, mise fixe (%)", "IC 95 % haut, mise fixe (%)"], hrow))
    # --- correlation inside a match
    g = by_match(res, lambda p: p["pnl"], lambda p: p["cash"])
    se_cluster = math.sqrt(sum(x[0] ** 2 for x in g))
    se_naive = math.sqrt(sum(p["pnl"] ** 2 for p in res))
    conc = disc = 0
    for ev, ps in M["events"].items():
        ps = [p for p in ps if p["resolved"] and p["settle"] in (0.0, 1.0)]
        for i in range(len(ps)):
            for j in range(i + 1, len(ps)):
                if ps[i]["cid"] == ps[j]["cid"]:
                    continue
                if ps[i]["settle"] == ps[j]["settle"]:
                    conc += 1
                else:
                    disc += 1
    mcash = sorted(((sum(p["cash"] for p in ps), ev) for ev, ps in M["events"].items()), reverse=True)
    dep = M["others"].get("DEPOSIT", (0, 0.0))[1]
    hh = div(sum(x[1] ** 2 for x in g), sum(x[1] for x in g) ** 2)
    tabs.append(T("Corrélation entre positions du même match", ["Indicateur", "Valeur"], [
        ["Paires de positions du même match avec le même résultat (%)", pct(div(conc, conc + disc))],
        ["Nombre de paires", conc + disc],
        ["Incertitude réelle / incertitude si chaque position était indépendante", r2(div(se_cluster, se_naive), 2)],
        ["Positions réglées", len(res)], ["Matchs réglés", len(g)],
        ["Nombre de paris « équivalents » de même taille (inverse de la concentration des mises par match)", r2(div(1, hh), 0) if hh else None],
        ["Plus grosse mise sur un seul match (USDC)", r2(mcash[0][0], 0) if mcash else None],
        ["Part de l'argent misé sur les 20 plus gros matchs (%)", pct(div(sum(x[0] for x in mcash[:20]), sum(x[0] for x in mcash)))],
    ]))
    # --- survivorship arithmetic
    z = ctx["z"]
    p1 = 0.5 * math.erfc(z / math.sqrt(2)) if z is not None else None
    zf = ctx["zf"]
    p1f = 0.5 * math.erfc(zf / math.sqrt(2)) if zf is not None else None
    tabs.append(T("Biais du survivant : ce wallet a été choisi parce qu'il a gagné", ["Indicateur", "Valeur"], [
        ["Score z du bénéfice (groupé par match)", r2(z, 2)],
        ["Probabilité qu'un parieur sans avantage fasse au moins aussi bien", r2(p1, 5)],
        ["Soit 1 parieur sans avantage sur …", r2(div(1, p1), 0) if p1 else None],
        ["Score z à mise fixe (sans l'effet des grosses mises)", r2(zf, 2)],
        ["Probabilité correspondante", r2(p1f, 5)],
        ["Soit 1 parieur sans avantage sur … (mise fixe)", r2(div(1, p1f), 0) if p1f else None],
    ]))
    # --- market-type risks
    tot = sum(p["cash"] for p in P)
    voids = [p for p in res if p["settle"] == 0.5]
    low = sum(p["cash"] for p in P if p["m"]["tier"] in ("4", "5"))
    tabs.append(T("Risques propres aux marchés", ["Indicateur", "Valeur"], [
        ["Positions remboursées à 50 % (match annulé, forfait…)", len(voids)],
        ["Bénéfice sur ces positions (USDC)", r2(sum(p["pnl"] for p in voids), 0)],
        ["Part de l'argent misé sur des tournois de niveau 4 ou 5 (%)", pct(div(low, tot))],
        ["Part de l'argent misé hors « vainqueur du match » (%)", pct(div(sum(p["cash"] for p in P if p["m"]["type"] != "moneyline"), tot))],
        ["Part de l'argent misé sur des handicaps de cartes (%)", pct(div(sum(p["cash"] for p in P if p["m"]["type"] == "map_handicap"), tot))],
        ["Positions encore ouvertes", len(P) - len(res)], ["Argent engagé sur les positions ouvertes (USDC)", r2(sum(p["cash"] for p in P if not p["resolved"]), 0)],
    ]))
    none15 = lrow[1][8] if len(lrow) > 1 else None
    med15 = lrow[1][4] if len(lrow) > 1 else None
    medst = lrow[5][4] if len(lrow) > 5 else None
    resume = ("Trois angles morts pèsent lourd. La liquidité : dans %s %% des positions, personne d'autre n'a acheté à moins de 2 centimes du prix du wallet dans le quart d'heure suivant, "
              "et jusqu'au match le montant médian n'est que de %s USDC. La concentration : deux positions du même match ont le même résultat dans %s %% des cas, et l'argent est en réalité réparti "
              "comme sur %s paris de même taille. Le biais du survivant : un parieur sans aucun avantage sur %s environ ferait aussi bien par hasard." % (
                  frn(none15, 0) if none15 is not None else "?", fr_int(medst) if medst is not None else "?", frn(100 * (div(conc, conc + disc) or 0), 0),
                  fr_int(div(1, hh)) if hh else "?", fr_int(div(1, p1)) if p1 else "?"))
    warn = ["La liquidité est estimée à partir des achats réellement exécutés, pas à partir du carnet d'ordres de l'époque (non archivé). L'absence d'achat ne prouve pas qu'il n'y avait rien à acheter : "
            "c'est une borne basse. Le carnet relevé une fois en direct (voir notes/ANALYSIS.md) montrait 1 à 2 centimes d'écart et de quelques centaines à plusieurs centaines de milliers d'USDC selon le niveau du match.",
            "Le calcul « 1 parieur sur N » suppose une loi normale ; il donne un ordre de grandeur, pas une probabilité exacte, et le nombre de wallets passés en revue pour trouver celui-ci n'est pas connu.",
            "Les semaines contiennent peu de matchs : les variations d'une semaine à l'autre sont surtout du bruit.",
            "Les marchés de niveau 4 et 5 sont les moins liquides et les plus exposés aux forfaits, remplacements de joueurs et matchs arrangés ; rien dans ces données ne permet de mesurer ce risque."]
    return {"id": "angles_morts", "titre": "6. Ce qu'on n'a pas demandé mais qui compte", "resume": resume, "tableaux": tabs, "avertissements": warn}, {
        "liq_med": med15, "p1": p1, "p1f": p1f, "conc": div(conc, conc + disc)}


def verdict(c1, c3, c5, c6):
    if not c5 or not c5.get("key"):
        return ("Verdict incomplet : les prix de marché n'ont pas pu être chargés, la copiabilité n'a donc pas été mesurée. Le bénéfice du wallet est de %s USDC "
                "(%s %% de l'argent misé, intervalle de %s %% à %s %%)." % (fr_int(c1["pnl"]), frn(100 * c1["roi"]), frn(100 * (c1["lo"] or 0)), frn(100 * (c1["hi"] or 0))))
    k = c5["key"]
    d60, d900 = k.get(60), k.get(900)
    ds = [d for d in k if isinstance(d, int)]
    parts = []
    parts.append("Copiable techniquement, oui ; rentable de façon démontrée, non.")
    parts.append("Le bénéfice du wallet est réel (%s USDC, %s %% de l'argent misé, uniquement sur CS2), mais 98 %% de l'argent a été misé sur %d jours seulement, "
                 "%s %% du gain vient de 10 positions et l'intervalle de confiance du rendement va de %s %% à %s %%." % (
                     fr_int(c1["pnl"]), frn(100 * c1["roi"]), c1["span_days"], frn(100 * c1["top10"], 0), frn(100 * (c1["lo"] or 0)), frn(100 * (c1["hi"] or 0))))
    if c1["lo_f"] is not None:
        parts.append("À mise égale sur chaque position, le rendement tombe à %s %% (de %s %% à %s %%) : %s" % (
            frn(100 * c1["roi_flat"]), frn(100 * c1["lo_f"]), frn(100 * c1["hi_f"]),
            "ses choix seuls ne se distinguent pas du hasard, ce sont ses plus grosses mises qui ont fait le résultat." if c1["lo_f"] <= 0
            else "ses choix restent gagnants même sans l'effet des grosses mises."))
    if d60 and ds:
        parts.append("Le retard, lui, coûte peu : le wallet achète au prix affiché plusieurs heures avant le match, en commençant petit, et 1 à 15 minutes plus tard le prix n'est qu'à "
                     "%s à %s centimes au-dessus de son premier prix. Un suiveur simulé à 1 minute (frais et %s centime d'écart compris) obtient %s %% à mise fixe (de %s %% à %s %%) "
                     "et %s %% en copiant aussi les tailles (de %s %% à %s %%)." % (
                         frn(100 * min(k[d]["slip"] for d in ds)), frn(100 * max(k[d]["slip"] for d in ds)), frn(100 * BASE_SPREAD, 0),
                         frn(100 * d60["flat"][0]), frn(100 * (d60["flat"][1] or 0)), frn(100 * (d60["flat"][2] or 0)),
                         frn(100 * d60["wt"][0], 0), frn(100 * (d60["wt"][1] or 0), 0), frn(100 * (d60["wt"][2] or 0), 0)))
    parts.append("Ces chiffres héritent des mêmes résultats de matchs que le wallet : son prix d'achat ne bat pas le prix de clôture (%s %% de la mise), "
                 "tout le gain vient donc du fait que ses équipes ont gagné plus souvent que le marché ne le prévoyait, sur %d matchs. "
                 "Un parieur sans avantage sur %s environ ferait aussi bien par hasard, et ce wallet a justement été repéré parce qu'il avait gagné." % (
                     frn(100 * (c5["clv_w"] or 0)), c1["n_match"], fr_int(1 / c6["p1"]) if c6.get("p1") else "?"))
    parts.append("Conseil : ne pas copier avec de l'argent qui compte. Suivre sur le papier ou à très petite mise fixe (les carnets des petits tournois n'absorbent souvent que quelques centaines d'USDC), "
                 "refuser tout prix supérieur de plus de 2 centimes à celui du wallet, et refaire le point chaque semaine avec ce tableau : il faudra plusieurs centaines de matchs supplémentaires pour trancher.")
    return " ".join(parts)

# ----------------------------------------------------------------------------- main

def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--trades", required=True)
    ap.add_argument("--activity", required=True)
    ap.add_argument("--markets", required=True)
    ap.add_argument("--positions", default="")
    ap.add_argument("--cache-dir", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--offline", action="store_true", help="use the on-disk cache only")
    ap.add_argument("--no-tape", action="store_true", help="skip the market-wide trade tape")
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--pause", type=float, default=0.12, help="sleep before each HTTP request, per worker (s)")
    ap.add_argument("--quiet", action="store_true")
    a = ap.parse_args(argv)
    t_start = time.time()
    log = (lambda *x: None) if a.quiet else (lambda *x: print(*x, file=sys.stderr, flush=True))

    M = build_model(a.trades, a.activity, a.markets, a.positions)
    if not M["fills"]:
        raise SystemExit("no BUY fills found in --activity / --trades")
    log("fills %d, positions %d (resolved %d), markets %d" % (
        len(M["fills"]), len(M["P"]), sum(1 for p in M["P"].values() if p["resolved"]), len(M["markets"])))
    F = Fetcher(a.cache_dir, offline=a.offline, pause=a.pause, workers=a.workers, log=log)
    fetch_all(M, F, use_tape=not a.no_tape)
    n_ph = sum(1 for p in M["P"].values() if p["ph"])
    n_tape = sum(1 for p in M["P"].values() if p.get("tape") is not None)
    log("price history for %d/%d tokens, tape for %d/%d positions, %d http requests, %d failures (%.0f s)" % (
        n_ph, len(M["P"]), n_tape, len(M["P"]), F.n_req, F.n_err, time.time() - t_start))
    enrich(M)

    def safe(fn, sid, titre, *args):
        """A section that cannot be computed (e.g. no price data at all) must not kill the daily run."""
        try:
            return fn(*args)
        except Exception as ex:
            log("section %s failed: %s: %s" % (sid, type(ex).__name__, ex))
            return ({"id": sid, "titre": titre, "resume": "Section non calculable avec les données disponibles aujourd'hui.", "tableaux": [],
                     "avertissements": ["Calcul impossible (%s). Les autres sections restent valables." % type(ex).__name__]}, {})

    s1, c1 = sec_profit(M)
    s2, c2 = safe(sec_structure, "structure", "2. Comment parie-t-il ?", M)
    s3, c3 = safe(sec_maker, "maker_taker", "3. Prend-il les prix ou pose-t-il des ordres ?", M, c1)
    s4, c4 = safe(sec_timing, "timing", "4. Quand parie-t-il ?", M)
    s5, c5 = safe(sec_copy, "copiabilite", "5. Peut-on le copier après coup ?", M, c1)
    s6, c6 = safe(sec_blind, "angles_morts", "6. Ce qu'on n'a pas demandé mais qui compte", M, c1)
    t_first, t_last = M["fills"][0]["ts"], M["fills"][-1]["ts"]
    out = {
        "genere_le": iso(int(time.time())),
        "periode": {"debut": iso(t_first), "fin": iso(t_last), "ordres": len(M["fills"]), "positions": len(M["P"]),
                    "positions_reglees": sum(1 for p in M["P"].values() if p["resolved"]), "matchs": len(M["events"])},
        "wallet": M["wallet"],
        "verdict": verdict(c1, c3, c5, c6),
        "sections": [s1, s2, s3, s4, s5, s6],
        "methode": {
            "delais_s": DELAYS, "ecarts_testes": SPREADS, "ecart_de_base": BASE_SPREAD, "salve_s": BURST_S,
            "tirages_bootstrap": N_BOOT, "graine": SEED,
            "positions_avec_historique_de_prix": n_ph, "positions_avec_achats_du_marche": n_tape,
            "note": "Prix : un point par minute (CLOB prices-history). Achats du marché : flux public des transactions par marché. "
                    "Intervalles de confiance : rééchantillonnage par match. Détails : notes/ANALYSIS.md.",
        },
    }
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    tmp = a.out + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1, allow_nan=False)
        f.write("\n")
    os.replace(tmp, a.out)
    log("wrote %s in %.0f s" % (a.out, time.time() - t_start))
    return 0


if __name__ == "__main__":
    sys.exit(main())
