// Statistiques globales, ventilations et courbe de PnL. Code pur.
//
// Conventions :
//  - « mise » = cash sorti, frais inclus (Σ usdc_size des achats) ;
//  - PnL et ROI ne portent que sur les positions CLOSES (gagnées, perdues, remboursées, vendues) ;
//  - les rebates sont comptés à part ;
//  - PRE/LIVE et maker/taker sont des attributs de FILL : la mise et le PnL d'une position sont répartis
//    entre les classes au prorata du cash de ses achats ; n / w / lo / v comptent les positions « touchées ».

import type { BetDescription, DashBreakdownRow, DashStats, Fill, LedgerEvent, Position } from "./types.ts";

export const r2 = (x: number): number => Math.round(x * 100) / 100;
export const r4 = (x: number): number => Math.round(x * 1e4) / 1e4;

interface Acc { k: string; l: string; n: number; st: number; pnl: number; w: number; lo: number; v: number }

function bump(m: Map<string, Acc>, k: string, l: string, p: Position, share: number): void {
  let a = m.get(k);
  if (!a) { a = { k, l, n: 0, st: 0, pnl: 0, w: 0, lo: 0, v: 0 }; m.set(k, a); }
  a.n++;
  a.st += p.cash * share;
  a.pnl += p.pnl * share;
  if (p.status === "won") a.w++;
  else if (p.status === "lost") a.lo++;
  else if (p.status === "void") a.v++;
}

function rows(m: Map<string, Acc>, order?: (a: Acc, b: Acc) => number): DashBreakdownRow[] {
  return [...m.values()].sort(order ?? ((a, b) => b.st - a.st)).map((a) => ({
    k: a.k, l: a.l, n: a.n, st: r2(a.st), pnl: r2(a.pnl), roi: a.st > 0 ? r4(a.pnl / a.st) : null, w: a.w, lo: a.lo, v: a.v,
  }));
}

/** Libellé d'une tranche de mise : bornes [100, 500] → "< 100 $", "100–500 $", "≥ 500 $". */
export function bucketOf(cash: number, bounds: number[]): { k: string; l: string; idx: number } {
  const fmt = (n: number): string => (n >= 1000 ? `${n / 1000}k` : String(n));
  for (let i = 0; i < bounds.length; i++) {
    if (cash < bounds[i]) {
      return i === 0
        ? { k: `lt${bounds[0]}`, l: `< ${fmt(bounds[0])} $`, idx: 0 }
        : { k: `${bounds[i - 1]}-${bounds[i]}`, l: `${fmt(bounds[i - 1])}–${fmt(bounds[i])} $`, idx: i };
    }
  }
  const last = bounds[bounds.length - 1] ?? 0;
  return { k: `ge${last}`, l: `≥ ${fmt(last)} $`, idx: bounds.length };
}

/** "2026-11" dans le fuseau donné. */
export function monthOf(tsSec: number, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit" }).formatToParts(new Date(tsSec * 1000));
  const y = parts.find((p) => p.type === "year")?.value ?? "0000";
  const m = parts.find((p) => p.type === "month")?.value ?? "00";
  return `${y}-${m}`;
}

const MONTHS_FR = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];

export interface StatsResult {
  stats: DashStats;
  by: { type: DashBreakdownRow[]; phase: DashBreakdownRow[]; role: DashBreakdownRow[]; bucket: DashBreakdownRow[]; month: DashBreakdownRow[] };
  eq: [number, number, number][];
}

export function computeStats(
  positions: Position[],
  fills: Fill[],
  events: LedgerEvent[],
  betOf: (p: Position) => BetDescription,
  phaseOfFill: (f: Fill) => "PRE" | "LIVE" | null,
  opts: { tz: string; buckets: number[] },
): StatsResult {
  const s: DashStats = {
    n_pos: positions.length, n_open: 0, n_closed: 0, n_fills: fills.length, n_matches: 0,
    won: 0, lost: 0, void: 0, sold: 0,
    staked: 0, staked_closed: 0, staked_open: 0, fees: 0, pnl: 0, roi: null, win_rate: null,
    rebates_taker: 0, rebates_maker: 0, pnl_with_rebates: 0, deposits: 0, withdrawals: 0,
    first_ts: null, last_ts: null,
  };
  const byType = new Map<string, Acc>(), byPhase = new Map<string, Acc>(), byRole = new Map<string, Acc>();
  const byBucket = new Map<string, Acc>(), byMonth = new Map<string, Acc>();
  const bucketIdx = new Map<string, number>();
  const matches = new Set<string>();

  for (const p of positions) {
    matches.add(p.event_slug);
    s.staked += p.cash;
    s.fees += p.fees;
    s.first_ts = s.first_ts === null ? p.firstTs : Math.min(s.first_ts, p.firstTs);
    s.last_ts = s.last_ts === null ? p.lastTs : Math.max(s.last_ts, p.lastTs);
    if (p.status === "open") { s.n_open++; s.staked_open += p.cash; continue; }
    s.n_closed++;
    s.staked_closed += p.cash;
    s.pnl += p.pnl;
    if (p.status === "won") s.won++;
    else if (p.status === "lost") s.lost++;
    else if (p.status === "void") s.void++;
    else s.sold++;

    const bet = betOf(p);
    bump(byType, bet.marketTypeKey, bet.marketTypeFr, p, 1);
    const b = bucketOf(p.cash, opts.buckets);
    bucketIdx.set(b.k, b.idx);
    bump(byBucket, b.k, b.l, p, 1);
    const mo = monthOf(p.resolvedTs ?? p.lastTs, opts.tz);
    bump(byMonth, mo, `${MONTHS_FR[Number(mo.slice(5)) - 1] ?? mo} ${mo.slice(0, 4)}`, p, 1);

    // Prorata du cash des achats par classe de fill.
    const ph: Record<string, number> = {}, ro: Record<string, number> = {};
    let tot = 0;
    for (const i of p.fills) {
      const f = fills[i];
      if (!f || f.side !== "BUY") continue;
      const phase = phaseOfFill(f) ?? "?";
      ph[phase] = (ph[phase] ?? 0) + f.usdc_size;
      const role = f.taker ? "taker" : "maker";
      ro[role] = (ro[role] ?? 0) + f.usdc_size;
      tot += f.usdc_size;
    }
    const PH: Record<string, string> = { PRE: "Pré-match", LIVE: "Live", "?": "Phase inconnue" };
    const RO: Record<string, string> = { taker: "Taker (au marché)", maker: "Maker (ordre limite)" };
    for (const [k, c] of Object.entries(ph)) bump(byPhase, k, PH[k] ?? k, p, tot > 0 ? c / tot : 0);
    for (const [k, c] of Object.entries(ro)) bump(byRole, k, RO[k] ?? k, p, tot > 0 ? c / tot : 0);
  }
  s.n_matches = matches.size;

  // Rebates et mouvements de cash, à part.
  const rebates: [number, number][] = [];
  for (const e of events) {
    if (e.type === "TAKER_REBATE") { s.rebates_taker += e.usdc_size; rebates.push([e.timestamp, e.usdc_size]); }
    else if (e.type === "MAKER_REBATE") { s.rebates_maker += e.usdc_size; rebates.push([e.timestamp, e.usdc_size]); }
    else if (e.type === "DEPOSIT") s.deposits += e.usdc_size;
    else if (e.type === "WITHDRAWAL") s.withdrawals += e.usdc_size;
  }
  rebates.sort((a, b) => a[0] - b[0]);

  // Courbe : un point par position close, dans l'ordre des clôtures.
  const closed = positions.filter((p) => p.status !== "open").sort((a, b) => ((a.resolvedTs ?? a.lastTs) - (b.resolvedTs ?? b.lastTs)) || (a.token_id < b.token_id ? -1 : 1));
  const eq: [number, number, number][] = [];
  let cum = 0, reb = 0, ri = 0;
  for (const p of closed) {
    const ts = p.resolvedTs ?? p.lastTs;
    while (ri < rebates.length && rebates[ri][0] <= ts) reb += rebates[ri++][1];
    cum += p.pnl;
    const last = eq[eq.length - 1];
    if (last && last[0] === ts) { last[1] = r2(cum); last[2] = r2(cum + reb); }
    else eq.push([ts, r2(cum), r2(cum + reb)]);
  }

  s.roi = s.staked_closed > 0 ? r4(s.pnl / s.staked_closed) : null;
  s.win_rate = s.won + s.lost > 0 ? r4(s.won / (s.won + s.lost)) : null;
  s.pnl_with_rebates = r2(s.pnl + s.rebates_taker + s.rebates_maker);
  for (const k of ["staked", "staked_closed", "staked_open", "fees", "pnl", "rebates_taker", "rebates_maker", "deposits", "withdrawals"] as const) s[k] = r2(s[k]);

  return {
    stats: s,
    by: {
      type: rows(byType),
      phase: rows(byPhase),
      role: rows(byRole),
      bucket: rows(byBucket, (a, b) => (bucketIdx.get(a.k) ?? 0) - (bucketIdx.get(b.k) ?? 0)),
      month: rows(byMonth, (a, b) => (a.k < b.k ? -1 : 1)),
    },
    eq,
  };
}
