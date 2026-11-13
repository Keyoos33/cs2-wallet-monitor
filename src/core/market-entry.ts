// Conversion d'un marché Gamma brut en entrée du cache `ledger/markets.json`. Code pur.
// La traduction en `MarketMeta` est déléguée à `toMarketMeta` (src/core/gamma.ts), injectée.

import type { MarketEntry, MarketMeta, RawActivity } from "./types.ts";

function jsonArray(v: unknown): unknown[] | null {
  if (Array.isArray(v)) return v;
  if (typeof v === "string") {
    try { const a = JSON.parse(v); return Array.isArray(a) ? a : null; } catch { return null; }
  }
  return null;
}

/** "2026-08-19 16:46:30+00" ou ISO → secondes epoch ; null si illisible. */
export function gammaTs(v: unknown): number | null {
  if (typeof v !== "string" || v.trim() === "") return null;
  let s = v.trim().replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00");
  if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(s)) s += "Z";
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : Math.floor(t / 1000);
}

export function toMarketEntry(raw: any, toMarketMeta: (m: any, e?: any) => MarketMeta, now: number): MarketEntry {
  const ev = raw?._event ?? (Array.isArray(raw?.events) ? raw.events[0] : undefined);
  const meta = toMarketMeta(raw, ev);
  const prices = jsonArray(raw?.outcomePrices)?.map((x) => Number(x)) ?? null;
  const closed = raw?.closed === true;
  return {
    meta,
    eventId: ev?.id != null ? String(ev.id) : null,
    league: typeof ev?.eventMetadata?.league === "string" ? ev.eventMetadata.league : null,
    closed,
    resolved: closed && raw?.umaResolutionStatus === "resolved" && !!prices && prices.every((p) => Number.isFinite(p)),
    prices: prices && prices.every((p) => Number.isFinite(p)) ? prices : null,
    closedTs: gammaTs(raw?.closedTime),
    fetched_ts: now,
  };
}

/** Entrée minimale construite depuis une ligne du flux quand Gamma ne répond pas : rien n'est interprété. */
export function stubEntry(r: RawActivity, now: number): MarketEntry {
  const oi = Number(r.outcome_index);
  const outcomes = ["", ""];
  if (oi === 0 || oi === 1) outcomes[oi] = String(r.outcome ?? "");
  return {
    meta: {
      conditionId: String(r.condition_id ?? ""), question: String(r.title ?? ""), slug: String(r.slug ?? ""),
      eventSlug: String(r.event_slug ?? ""), eventTitle: "", seriesSlug: null, sportsMarketType: null, line: null,
      outcomes, tokenIds: [], groupItemTitle: null, gameStartTime: null, negRisk: false,
    },
    eventId: null, league: null, closed: false, resolved: false, prices: null, closedTs: null, fetched_ts: now, stub: true,
  };
}

/** Vrai si la différence entre deux lectures mérite d'être persistée (les prix d'un marché ouvert bougent sans cesse : ignorés). */
export function entryChanged(a: MarketEntry | undefined, b: MarketEntry): boolean {
  if (!a) return true;
  return !!a.stub !== !!b.stub || a.resolved !== b.resolved || a.closed !== b.closed
    || a.meta.gameStartTime !== b.meta.gameStartTime || a.meta.eventTitle !== b.meta.eventTitle
    || a.meta.question !== b.meta.question || a.meta.sportsMarketType !== b.meta.sportsMarketType
    || (b.resolved && JSON.stringify(a.prices) !== JSON.stringify(b.prices));
}
