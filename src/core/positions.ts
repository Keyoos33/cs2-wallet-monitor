// Reconstruction des positions (une par token) à partir du registre. Code pur.
//
// Règles de montants (notes/ARCHITECTURE.md) :
//  - mise = Σ usdc_size des achats (cash sorti, frais inclus) ; frais = Σ (usdc_size − size×price) ;
//  - prix d'entrée = Σ size×price / Σ size (hors frais) ;
//  - vente : PnL réalisé = produit − coût moyen (frais inclus) × parts vendues ;
//  - résolution : payout = parts détenues × prix de règlement (1, 0 ou 0,5) ;
//    PnL = payout + ventes − cash ; ROI = PnL / cash ;
//  - les rebates ne sont jamais attribués à une position.
//
// Résolution d'un token : marché Gamma fermé et résolu (prix de règlement = outcomePrices[issue]),
// ou à défaut ligne REDEEM jointe sur (condition_id, outcome_index) — le token_id des REDEEM peut être vide.

import type { Fill, LedgerEvent, MarketEntry, Position } from "./types.ts";

const DUST = 1e-6;

interface Redeem { ts: number; usdc: number; size: number }

function newPosition(f: { token_id: string; condition_id: string; outcome_index: number; outcome: string; slug: string; event_slug: string; cs2: boolean; timestamp: number }): Position {
  return {
    token_id: f.token_id, condition_id: f.condition_id, outcome_index: f.outcome_index, outcome: f.outcome,
    slug: f.slug, event_slug: f.event_slug, cs2: f.cs2,
    bought: 0, held: 0, sold: 0, cost: 0, fees: 0, cash: 0, proceeds: 0, realized: 0, basis: 0,
    avgPrice: null, nFills: 0, firstTs: f.timestamp, lastTs: f.timestamp,
    status: "open", settle: null, payout: 0, resolvedTs: null, pnl: 0, roi: null, fills: [],
  };
}

function reduce(p: Position, shares: number, proceeds: number): void {
  let s = shares;
  if (s > p.held + DUST) {
    p.warn = "sortie supérieure aux parts connues (historique incomplet ?)";
    s = p.held;
  }
  const avg = p.held > DUST ? p.basis / p.held : 0;
  p.proceeds += proceeds;
  p.realized += proceeds - avg * s;
  p.basis -= avg * s;
  p.held -= s;
  p.sold += s;
  if (p.held < DUST) { p.held = 0; p.basis = 0; }
}

/** Arrondit un ratio de règlement aux valeurs canoniques 0 / 0,5 / 1 s'il en est très proche. */
function canonSettle(x: number): number {
  for (const c of [0, 0.5, 1]) if (Math.abs(x - c) < 1e-3) return c;
  return x;
}

export function buildPositions(
  fills: Fill[],
  events: LedgerEvent[],
  markets: Record<string, MarketEntry> | Map<string, MarketEntry>,
): Position[] {
  const marketOf = (c: string): MarketEntry | undefined => (markets instanceof Map ? markets.get(c) : markets[c]);
  const pos = new Map<string, Position>();
  const byCond = new Map<string, Position[]>();
  const add = (p: Position): void => {
    pos.set(p.token_id, p);
    const a = byCond.get(p.condition_id);
    if (a) a.push(p); else byCond.set(p.condition_id, [p]);
  };

  // Opérations dans l'ordre chronologique ; à horodatage égal : fills (ordre du registre) puis événements.
  type Op = { ts: number; k: 0 | 1; n: number; f?: Fill; e?: LedgerEvent };
  const ops: Op[] = [];
  fills.forEach((f) => ops.push({ ts: f.timestamp, k: 0, n: f.i, f }));
  const redeems = new Map<string, Redeem>();
  events.forEach((e, n) => {
    if (e.type === "REDEEM") {
      if (!e.condition_id || e.outcome_index === 999) return; // ligne dégradée : Gamma fera foi
      const k = `${e.condition_id}|${e.outcome_index}`;
      const r = redeems.get(k);
      if (r) { r.usdc += e.usdc_size; r.size += e.size; r.ts = Math.max(r.ts, e.timestamp); }
      else redeems.set(k, { ts: e.timestamp, usdc: e.usdc_size, size: e.size });
    } else if (e.condition_id) {
      ops.push({ ts: e.timestamp, k: 1, n, e });
    }
  });
  ops.sort((a, b) => (a.ts - b.ts) || (a.k - b.k) || (a.n - b.n));

  for (const op of ops) {
    if (op.f) {
      const f = op.f;
      let p = pos.get(f.token_id);
      if (!p) { p = newPosition(f); add(p); }
      p.fills.push(f.i);
      p.nFills++;
      p.lastTs = Math.max(p.lastTs, f.timestamp);
      if (f.cs2) p.cs2 = true;
      if (f.side === "BUY") {
        p.bought += f.size;
        p.held += f.size;
        p.cost += f.size * f.price;
        p.fees += f.fee;
        p.cash += f.usdc_size;
        p.basis += f.usdc_size;
      } else {
        reduce(p, f.size, f.usdc_size);
      }
      continue;
    }
    const e = op.e as LedgerEvent;
    const legs = byCond.get(e.condition_id) ?? [];
    if (e.type === "MERGE") {
      // Fusion : `size` parts de CHAQUE issue sont brûlées contre `usdc_size` $. Le produit est réparti
      // entre les jambes au prorata de leur coût moyen (le PnL total est exact quelle que soit la clé).
      const held = legs.filter((p) => p.held > DUST);
      const avgs = held.map((p) => p.basis / p.held);
      const tot = avgs.reduce((a, b) => a + b, 0);
      held.forEach((p, j) => reduce(p, e.size, e.usdc_size * (tot > 0 ? avgs[j] / tot : 1 / held.length)));
      if (held.length < 2) for (const p of legs) p.warn = "MERGE avec une seule jambe connue";
    } else if (e.type === "SPLIT") {
      // Scission : `usdc_size` $ donnent `size` parts de chaque issue ; coût réparti à parts égales.
      const m = marketOf(e.condition_id);
      const tokens = m?.meta.tokenIds ?? [];
      if (tokens.length < 2) { for (const p of legs) p.warn = "SPLIT sans métadonnées de marché"; continue; }
      tokens.forEach((t, oi) => {
        let p = pos.get(t);
        if (!p) {
          p = newPosition({
            token_id: t, condition_id: e.condition_id, outcome_index: oi, outcome: m?.meta.outcomes[oi] ?? "",
            slug: m?.meta.slug ?? "", event_slug: m?.meta.eventSlug ?? "", cs2: m?.meta.seriesSlug === "counter-strike", timestamp: e.timestamp,
          });
          add(p);
        }
        const c = e.usdc_size / tokens.length;
        p.bought += e.size; p.held += e.size; p.cost += c; p.cash += c; p.basis += c;
        p.lastTs = Math.max(p.lastTs, e.timestamp);
      });
    } else if (e.type !== "MAKER_REBATE" && e.type !== "TAKER_REBATE") {
      for (const p of legs) p.warn = `opération ${e.type} non interprétée`;
    }
  }

  for (const p of pos.values()) {
    p.avgPrice = p.bought > 0 ? p.cost / p.bought : null;
    const m = marketOf(p.condition_id);
    // L'API renvoie parfois outcome_index = 999 (non renseigné) : le token_id fait foi.
    p.outcome_index = outcomeIndexFor(m?.meta, p.token_id, p.outcome_index);
    if (m && !p.outcome && m.meta.outcomes[p.outcome_index]) p.outcome = m.meta.outcomes[p.outcome_index];
    const rd = redeems.get(`${p.condition_id}|${p.outcome_index}`);
    let settle: number | null = null;
    let ts: number | null = null;
    const gp = m?.resolved ? m.prices?.[p.outcome_index] : undefined;
    if (typeof gp === "number" && Number.isFinite(gp)) {
      settle = canonSettle(gp);
      ts = rd?.ts ?? m?.closedTs ?? m?.fetched_ts ?? p.lastTs;
    } else if (rd && rd.size > 0) {
      settle = canonSettle(rd.usdc / rd.size);
      ts = rd.ts;
    }
    if (p.held <= DUST && p.sold > 0) {
      // Entièrement sortie avant la résolution : le résultat du marché ne change plus rien.
      p.status = "sold";
      p.resolvedTs = p.lastTs;
      p.pnl = p.realized;
      p.roi = p.cash > 0 ? p.pnl / p.cash : null;
    } else if (settle !== null) {
      p.settle = settle;
      p.resolvedTs = ts;
      p.payout = p.held * settle;
      p.pnl = p.payout + p.proceeds - p.cash;
      p.roi = p.cash > 0 ? p.pnl / p.cash : null;
      p.status = settle >= 0.999 ? "won" : settle <= 0.001 ? "lost" : "void";
    } else {
      p.status = "open";
      p.pnl = p.realized;
      p.roi = null;
    }
  }
  return [...pos.values()];
}

export function isClosed(p: Position): boolean { return p.status !== "open"; }

/** Index de l'issue d'après le token (source sûre) ; repli sur l'index fourni par l'API. */
export function outcomeIndexFor(meta: { tokenIds: string[] } | null | undefined, tokenId: string, fallback: number): number {
  const i = meta?.tokenIds?.indexOf(tokenId) ?? -1;
  return i >= 0 ? i : fallback;
}
