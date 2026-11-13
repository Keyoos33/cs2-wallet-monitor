// Construction de `site/data.json` (schéma DashboardData, src/core/types.ts). Code pur.

import { phaseOf } from "./ledger.ts";
import { computeStats, r2, r4 } from "./stats.ts";
import type {
  AlertRecord, BetDescription, DashAlert, DashboardData, DashFill, DashMatch, DashPosition,
  Fill, Heartbeat, LedgerEvent, MarketEntry, MarketMeta, Position,
} from "./types.ts";

export interface DashboardInput {
  now: number;
  wallet: string;
  tz: string;
  initialWindowS: number;
  buckets: number[];
  alertLogMax: number;
  fills: Fill[];
  events: LedgerEvent[];
  positions: Position[];
  markets: Map<string, MarketEntry>;
  alerts: AlertRecord[];
  health: Heartbeat | null;
  /** Traducteur (src/core/translate.ts), injecté pour garder ce module indépendant. */
  describe: (meta: MarketMeta, outcomeIndex: number) => BetDescription;
}

const r3 = (x: number): number => Math.round(x * 1000) / 1000;

/** Métadonnées minimales quand Gamma n'a jamais répondu pour ce marché : rien n'est interprété. */
export function stubMeta(p: { condition_id: string; slug: string; event_slug: string; outcome: string; outcome_index: number }, title = ""): MarketMeta {
  const outcomes: string[] = [];
  outcomes[p.outcome_index === 1 ? 1 : 0] = p.outcome;
  for (let i = 0; i < Math.max(2, outcomes.length); i++) outcomes[i] = outcomes[i] ?? "";
  return {
    conditionId: p.condition_id, question: title || p.slug, slug: p.slug, eventSlug: p.event_slug, eventTitle: title,
    seriesSlug: null, sportsMarketType: null, line: null, outcomes, tokenIds: [], groupItemTitle: null, gameStartTime: null, negRisk: false,
  };
}

/** Traduction sûre : une exception du traducteur ne doit jamais faire tomber le moniteur. */
export function safeDescribe(describe: DashboardInput["describe"], meta: MarketMeta, oi: number, outcome: string): BetDescription {
  try {
    const d = describe(meta, oi);
    if (d && typeof d.betFr === "string") return d;
  } catch { /* repli ci-dessous */ }
  return {
    match: meta.eventTitle || meta.question || meta.slug, format: null, tournament: "", marketTypeKey: "unknown", marketTypeFr: "Type non reconnu",
    betFr: `${meta.question || meta.slug} → ${outcome}`, winConditionFr: "", exact: false,
  };
}

export function buildDashboardData(inp: DashboardInput): DashboardData {
  const bets = new Map<string, BetDescription>();
  const betOf = (p: Position): BetDescription => {
    let b = bets.get(p.token_id);
    if (!b) {
      const meta = inp.markets.get(p.condition_id)?.meta ?? stubMeta(p);
      b = safeDescribe(inp.describe, meta, p.outcome_index, p.outcome);
      bets.set(p.token_id, b);
    }
    return b;
  };
  const phaseOfFill = (f: Fill): "PRE" | "LIVE" | null => f.phase ?? phaseOf(f.timestamp, inp.markets.get(f.condition_id));

  const { stats, by, eq } = computeStats(inp.positions, inp.fills, inp.events, betOf, phaseOfFill, { tz: inp.tz, buckets: inp.buckets });

  const sorted = [...inp.positions].sort((a, b) => (b.lastTs - a.lastTs) || (a.token_id < b.token_id ? -1 : 1));
  const matchIdx = new Map<string, number>();
  const matches: DashMatch[] = [];
  const pos: DashPosition[] = [];

  for (const p of sorted) {
    const entry = inp.markets.get(p.condition_id);
    const bet = betOf(p);
    let mi = matchIdx.get(p.event_slug);
    if (mi === undefined) {
      mi = matches.length;
      matchIdx.set(p.event_slug, mi);
      matches.push({
        slug: p.event_slug, title: entry?.meta.eventTitle ?? "", match: bet.match, fmt: bet.format, tour: bet.tournament,
        start: null, cs2: p.cs2 ? 1 : 0, p: [], cash: 0, pnl: 0, open: 0,
      });
    }
    const m = matches[mi];
    const start = entry?.meta.gameStartTime ? Date.parse(entry.meta.gameStartTime) / 1000 : NaN;
    if (!Number.isNaN(start)) m.start = m.start === null ? start : Math.min(m.start, start);
    if (!m.title && entry?.meta.eventTitle) { m.title = entry.meta.eventTitle; m.match = bet.match; m.fmt = bet.format; m.tour = bet.tournament; }
    m.p.push(pos.length);
    m.cash += p.cash;
    if (p.status === "open") m.open++; else m.pnl += p.pnl;

    let init = 0;
    const f: DashFill[] = [];
    for (const i of p.fills) {
      const x = inp.fills[i];
      if (!x) continue;
      const ph = phaseOfFill(x);
      const later = x.timestamp > p.firstTs + inp.initialWindowS;
      if (x.side === "BUY" && !later) init += x.usdc_size;
      const flags = (x.taker ? 1 : 0) | (ph === "LIVE" ? 2 : 0) | (ph === null ? 4 : 0) | (x.side === "SELL" ? 8 : 0)
        | (later ? 16 : 0) | (x.src === "backfill" ? 32 : 0) | (x.src === "reconcile" ? 64 : 0);
      f.push([x.timestamp, r4(x.size), r4(x.price), r3(x.usdc_size), r3(x.fee), flags, x.transaction_hash, x.lag_s === null ? null : Math.round(x.lag_s)]);
    }
    const closed = p.status !== "open";
    const dp: DashPosition = {
      id: p.token_id, m: mi, q: entry?.meta.question ?? "", slug: p.slug, out: p.outcome,
      tk: bet.marketTypeKey, tf: bet.marketTypeFr, bet: bet.betFr, win: bet.winConditionFr, ex: bet.exact ? 1 : 0,
      st: p.status, sh: r4(p.bought), held: r4(p.held), cash: r2(p.cash), fee: r2(p.fees),
      px: p.avgPrice === null ? null : r4(p.avgPrice),
      odds: p.avgPrice && p.avgPrice > 0 ? r2(1 / p.avgPrice) : null,
      init: r2(init), add: r2(p.cash - init), nf: p.nFills, t0: p.firstTs, t1: p.lastTs,
      tr: p.resolvedTs, set: p.settle, pay: r2(p.payout), sold: r2(p.proceeds),
      pnl: closed || p.sold > 0 ? r2(p.pnl) : null,
      roi: closed && p.roi !== null ? r4(p.roi) : null,
      mk: !closed && entry && !entry.resolved && typeof entry.prices?.[p.outcome_index] === "number" ? r4(entry.prices[p.outcome_index]) : null,
      f,
    };
    if (p.warn) dp.warn = p.warn;
    pos.push(dp);
  }
  for (const m of matches) { m.cash = r2(m.cash); m.pnl = r2(m.pnl); }

  // Matchs du plus récent au plus ancien (début prévu, à défaut dernier fill) ; on réindexe les positions.
  const key = (m: DashMatch): number => m.start ?? Math.max(...m.p.map((i) => pos[i].t1));
  const order = matches.map((m, i) => ({ m, i })).sort((a, b) => (key(b.m) - key(a.m)) || (a.m.slug < b.m.slug ? -1 : 1));
  const remap = new Map<number, number>();
  order.forEach((o, n) => remap.set(o.i, n));
  for (const p of pos) p.m = remap.get(p.m) ?? p.m;

  const alerts: DashAlert[] = inp.alerts.slice(-inp.alertLogMax).reverse().map((a) => ({
    id: a.id, k: a.kind, tok: a.token_id, ts: a.sent_ts,
    tf: a.kind === "RESULT" ? (a.last_fill_ts ?? a.sent_ts) : (a.fill_ts ?? a.sent_ts), td: a.detected_ts ?? a.created_ts, n: a.fills.length, usd: r2(a.usdc),
    ld: Math.round(a.lat_detect_s), ls: Math.round(a.lat_send_s), ok: a.status === "ok" ? 1 : 0, test: a.is_test ? 1 : 0,
    title: a.title, text: a.text,
    ask: a.book?.bestAsk ?? null, avail: a.book ? r2(a.book.usdAvail) : null,
  }));

  return {
    v: 1, gen: inp.now, wallet: inp.wallet, tz: inp.tz,
    cfg: { initial_window_s: inp.initialWindowS, buckets: inp.buckets },
    health: inp.health, stats, by, eq,
    matches: order.map((o) => o.m), pos, alerts,
  };
}
