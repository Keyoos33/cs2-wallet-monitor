// Regroupement des alertes : machine à états PURE, à état sérialisable (state/state.json).
//
//  NEW       premier fill connu sur un token → on attend NEW_SETTLE_S après la première détection, puis on envoie la rafale.
//  INCREASE  fills suivants cumulés ; envoi quand
//              (A) cumul ≥ INCREASE_MIN_USD et ≥ INCREASE_MIN_GAP_S depuis la dernière alerte de la position, ou
//              (B) cumul ≥ INCREASE_BIG_RATIO × cash de la position à la dernière alerte (et ≥ INCREASE_MIN_USD),
//                  après INCREASE_SETTLE_S de calme.
//  REDUCE / CLOSE  toute vente, après SELL_SETTLE_S de calme, sans seuil.
//  RESULT    à la résolution d'une position qui était ouverte.
//
// Invariants : un fill n'entre que dans UNE alerte ; un fill de backfill n'entre dans AUCUNE ;
// ce qui est sous les seuils reste en attente et sera inclus dans la prochaine alerte de la position.
// L'état ne contient que des numéros de fills : les montants sont toujours recalculés depuis le registre.

import type { Config } from "./config.ts";
import type { AlertInput } from "./format.ts";
import type {
  AlertDraft, AlertKind, AlertState, BetDescription, BookSnapshot, Fill, MarketEntry, PosAlertState, Position,
} from "./types.ts";

export function emptyAlertState(): AlertState {
  return { seq: 0, pos: {}, outbox: [] };
}

export interface AlertLookup {
  fill(i: number): Fill | undefined;
  position(tokenId: string): Position | undefined;
}

type Cfg = Pick<Config, "NEW_SETTLE_S" | "INCREASE_MIN_USD" | "INCREASE_MIN_GAP_S" | "INCREASE_BIG_RATIO" | "INCREASE_SETTLE_S" | "SELL_SETTLE_S">;

/**
 * Présente un nouveau fill à la machine. `prior` décrit la position AVANT ce fill
 * (0 fill → ce sera un NEW ; sinon un INCREASE, y compris pour une position issue du backfill).
 * Idempotent : un fill déjà en attente ou déjà dans une alerte à envoyer est ignoré.
 * Renvoie true si le fill a été pris en compte.
 */
export function ingestFill(st: AlertState, f: Fill, prior: { nFills: number; cash: number }, now: number): boolean {
  if (f.src === "backfill" || !f.cs2) return false;
  let ps = st.pos[f.token_id];
  if (ps && (ps.buys.includes(f.i) || ps.sells.includes(f.i))) return false;
  if (st.outbox.some((d) => d.token_id === f.token_id && d.fills.includes(f.i))) return false;
  if (!ps) {
    ps = { alerted: prior.nFills > 0, lastAlertTs: 0, cashAtLastAlert: prior.cash, buys: [], sells: [], firstDetTs: 0, lastDetTs: 0 };
    st.pos[f.token_id] = ps;
  }
  const det = f.detected_ts ?? now;
  if (ps.buys.length + ps.sells.length === 0) ps.firstDetTs = det;
  ps.lastDetTs = Math.max(ps.lastDetTs, det);
  (f.side === "SELL" ? ps.sells : ps.buys).push(f.i);
  return true;
}

function makeDraft(st: AlertState, kind: AlertKind, ids: number[], lk: AlertLookup, now: number): AlertDraft | null {
  const fills = ids.map((i) => lk.fill(i)).filter((f): f is Fill => !!f);
  if (fills.length === 0) return null;
  const f0 = fills[0];
  const p = lk.position(f0.token_id);
  let shares = 0, usdc = 0, fees = 0, notional = 0, tk = 0, mk = 0, maxLag = 0;
  let firstTs = Infinity, lastTs = 0, firstDet = Infinity;
  let last = f0;
  for (const f of fills) {
    shares += f.size; usdc += f.usdc_size; fees += f.fee; notional += f.size * f.price;
    if (f.taker) tk++; else mk++;
    firstTs = Math.min(firstTs, f.timestamp);
    if (f.timestamp >= lastTs) { lastTs = f.timestamp; last = f; }
    firstDet = Math.min(firstDet, f.detected_ts ?? now);
    maxLag = Math.max(maxLag, f.lag_s ?? 0);
  }
  let realized: number | null = null;
  if (kind === "REDUCE" || kind === "CLOSE") {
    // PnL réalisé du lot = produit − coût moyen (frais inclus) des parts vendues, coût moyen pris sur les achats de la position.
    const avgCost = p && p.bought > 0 ? p.cash / p.bought : null;
    realized = avgCost === null ? null : usdc - avgCost * shares;
  }
  return {
    id: `a${++st.seq}`,
    kind,
    token_id: f0.token_id,
    condition_id: f0.condition_id,
    outcome_index: f0.outcome_index,
    fills: fills.map((f) => f.i),
    shares, usdc, fees,
    avgPrice: shares > 0 ? notional / shares : 0,
    takerCount: tk, makerCount: mk,
    firstTs, lastTs,
    firstDetTs: firstDet,
    maxLagS: maxLag,
    phase: last.phase,
    posShares: p?.held ?? shares,
    posCash: p ? (kind === "REDUCE" || kind === "CLOSE" ? p.basis : p.cash) : usdc,
    posAvgPrice: p?.avgPrice ?? null,
    realizedPnl: realized,
    created_ts: now,
    tries: 0,
  };
}

/**
 * Fait avancer la machine à l'instant `now` : les lots mûrs passent dans `st.outbox`.
 * Renvoie les alertes nouvellement créées.
 */
export function dueAlerts(st: AlertState, now: number, cfg: Cfg, lk: AlertLookup): AlertDraft[] {
  const out: AlertDraft[] = [];
  for (const [token, ps] of Object.entries(st.pos)) {
    const p = lk.position(token);
    if (ps.sells.length > 0 && now - ps.lastDetTs >= cfg.SELL_SETTLE_S) {
      const d = makeDraft(st, p && p.held <= 1e-6 ? "CLOSE" : "REDUCE", ps.sells, lk, now);
      ps.sells = [];
      if (d) { out.push(d); ps.lastAlertTs = now; ps.cashAtLastAlert = p?.cash ?? ps.cashAtLastAlert; }
    }
    if (ps.buys.length > 0) {
      let fire = false;
      if (!ps.alerted) {
        fire = now - ps.firstDetTs >= cfg.NEW_SETTLE_S;
      } else {
        let cum = 0;
        for (const i of ps.buys) cum += lk.fill(i)?.usdc_size ?? 0;
        if (cum >= cfg.INCREASE_MIN_USD) {
          const a = now - ps.lastAlertTs >= cfg.INCREASE_MIN_GAP_S && now - ps.firstDetTs >= cfg.INCREASE_SETTLE_S;
          const b = cum >= cfg.INCREASE_BIG_RATIO * ps.cashAtLastAlert && now - ps.lastDetTs >= cfg.INCREASE_SETTLE_S;
          fire = a || b;
        }
      }
      if (fire) {
        const d = makeDraft(st, ps.alerted ? "INCREASE" : "NEW", ps.buys, lk, now);
        ps.buys = [];
        ps.alerted = true;
        ps.lastAlertTs = now;
        ps.cashAtLastAlert = p?.cash ?? ps.cashAtLastAlert;
        if (d) out.push(d);
      }
    }
    if (ps.buys.length + ps.sells.length === 0) { ps.firstDetTs = 0; }
  }
  st.outbox.push(...out);
  return out;
}

/**
 * Résolutions : toute position de `prevOpen` désormais gagnée / perdue / remboursée donne une alerte RESULT
 * (une seule fois : l'appelant remplace ensuite sa liste des positions ouvertes par `openTokens(positions)`).
 * Les fills encore en attente sur ce token sont rattachés à l'alerte RESULT.
 */
export function resultAlerts(st: AlertState, prevOpen: string[], positions: Map<string, Position>, now: number): AlertDraft[] {
  const out: AlertDraft[] = [];
  for (const token of prevOpen) {
    const p = positions.get(token);
    if (!p || !p.cs2) continue;
    if (p.status !== "won" && p.status !== "lost" && p.status !== "void") continue;
    const ps = st.pos[token];
    const pending = ps ? [...ps.buys, ...ps.sells] : [];
    delete st.pos[token];
    out.push({
      id: `a${++st.seq}`,
      kind: "RESULT",
      token_id: token,
      condition_id: p.condition_id,
      outcome_index: p.outcome_index,
      fills: pending,
      shares: p.bought,
      usdc: p.cash,
      fees: p.fees,
      avgPrice: p.avgPrice ?? 0,
      takerCount: 0, makerCount: 0,
      firstTs: p.firstTs, lastTs: p.resolvedTs ?? p.lastTs,
      firstDetTs: now,
      maxLagS: 0,
      phase: null,
      posShares: p.held,
      posCash: p.cash,
      posAvgPrice: p.avgPrice,
      realizedPnl: null,
      result: { status: p.status, payout: p.payout, pnl: p.pnl, roi: p.roi, settle: p.settle ?? 0 },
      created_ts: now,
      tries: 0,
    });
  }
  st.outbox.push(...out);
  return out;
}

export function openTokens(positions: Iterable<Position>): string[] {
  const out: string[] = [];
  for (const p of positions) if (p.status === "open") out.push(p.token_id);
  return out.sort();
}

/** Retire une alerte de la file d'envoi (à n'appeler qu'après `ok:true` de Telegram, ou en DRY_RUN). */
export function markSent(st: AlertState, id: string): void {
  st.outbox = st.outbox.filter((d) => d.id !== id);
}

/** Nombre de fills en cours de regroupement (pas encore dans une alerte). */
export function pendingCount(st: AlertState): number {
  let n = 0;
  for (const ps of Object.values(st.pos)) n += ps.buys.length + ps.sells.length;
  return n;
}

/**
 * Mesure du carnet CLOB (`GET /book`) : meilleur ask, sa taille, et $ disponibles jusqu'à `limit`.
 * L'ordre des niveaux n'est pas supposé (l'API les sert décroissants, le meilleur en dernier).
 */
export function bookSnapshot(book: unknown, limit: number, now: number): BookSnapshot | null {
  const asks = (book as { asks?: unknown } | null)?.asks;
  if (!Array.isArray(asks)) return null;
  let best: number | null = null, bestSize: number | null = null, usd = 0, sh = 0;
  for (const lvl of asks) {
    const price = Number((lvl as { price?: unknown })?.price), size = Number((lvl as { size?: unknown })?.size);
    if (!Number.isFinite(price) || !Number.isFinite(size) || size <= 0) continue;
    if (best === null || price < best) { best = price; bestSize = size; }
    if (price <= limit + 1e-9) { usd += price * size; sh += size; }
  }
  return { ts: now, bestAsk: best, bestAskSize: bestSize, limit, usdAvail: usd, sharesAvail: sh };
}

/** Assemble l'entrée de `formatAlert` à partir d'un brouillon, de la traduction du pari et du carnet. */
export function buildAlertInput(
  d: AlertDraft,
  bet: BetDescription,
  entry: MarketEntry | null | undefined,
  opts: { now: number; tz: string; lateLagS: number; book?: BookSnapshot | null; isTest?: boolean },
): AlertInput {
  const start = entry?.meta.gameStartTime ? Date.parse(entry.meta.gameStartTime) : NaN;
  const eventSlug = entry?.meta.eventSlug ?? "";
  const late = d.kind !== "RESULT" && d.maxLagS > opts.lateLagS;
  return {
    kind: d.kind,
    bet,
    usdc: d.usdc,
    fees: d.fees,
    shares: d.shares,
    avgPrice: d.avgPrice,
    fillCount: d.fills.length,
    firstTs: d.firstTs,
    lastTs: d.lastTs,
    positionShares: d.posShares,
    positionCost: d.posCash,
    positionAvgPrice: d.posAvgPrice,
    realizedPnl: d.realizedPnl,
    phase: d.phase,
    minutesToStart: Number.isNaN(start) ? null : (start / 1000 - opts.now) / 60,
    url: eventSlug ? `https://polymarket.com/event/${encodeURIComponent(eventSlug)}` : "https://polymarket.com",
    isTest: opts.isTest,
    tz: opts.tz,
    takerCount: d.takerCount,
    makerCount: d.makerCount,
    book: d.kind === "NEW" || d.kind === "INCREASE" ? opts.book : undefined,
    lateLagS: late ? d.maxLagS : null,
    detectedTs: late ? d.firstDetTs : null,
    result: d.result ? { status: d.result.status, payout: d.result.payout, pnl: d.result.pnl, roi: d.result.roi } : null,
  };
}

// Petit utilitaire partagé par les tests : état d'une position d'alerte (lecture seule).
export function posAlertState(st: AlertState, token: string): PosAlertState | undefined {
  return st.pos[token];
}
