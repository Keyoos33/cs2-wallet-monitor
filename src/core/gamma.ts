// Conversion d'un marché brut de l'API Gamma (https://gamma-api.polymarket.com)
// vers `MarketMeta`. Code PUR : aucun accès réseau ni disque.
//
// Particularités Gamma gérées ici :
// - `outcomes` et `clobTokenIds` sont des chaînes JSON ('["A", "B"]') ;
// - `line` est un nombre (parfois absent, parfois entier) ;
// - `gameStartTime` est au format "2026-11-13 18:00:00+00" (pas ISO strict) ;
// - l'événement parent est soit passé en 2e argument (GET /events → event.markets[]),
//   soit embarqué dans `market.events[0]` (GET /markets).

import type { MarketMeta } from './types.ts';

function str(v: unknown): string {
  return typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v);
}

function strOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

/** Tableau de chaînes, à partir d'un tableau ou d'une chaîne JSON ; [] si illisible. */
function stringArray(v: unknown): string[] {
  let arr: unknown = v;
  if (typeof v === 'string') {
    try {
      arr = JSON.parse(v);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(arr)) return [];
  return arr.map((x) => str(x));
}

function numOrNull(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** "2026-11-13 18:00:00+00" ou ISO → "2026-11-13T18:00:00.000Z" ; null si illisible. */
function isoUtc(v: unknown): string | null {
  if (typeof v !== 'string' || v.trim() === '') return null;
  let s = v.trim().replace(' ', 'T');
  // Décalage abrégé "+00" → "+00:00" (Date.parse ne l'accepte pas partout).
  s = s.replace(/([+-]\d{2})$/, '$1:00');
  // Aucune indication de fuseau → UTC.
  if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(s)) s += 'Z';
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/**
 * Mappe un marché Gamma brut (+ son événement parent) vers `MarketMeta`.
 * `gammaEvent` est prioritaire sur `gammaMarket.events[0]`.
 */
export function toMarketMeta(gammaMarket: any, gammaEvent?: any): MarketMeta {
  const m = gammaMarket ?? {};
  const e = gammaEvent ?? (Array.isArray(m.events) ? m.events[0] : undefined) ?? {};
  const series = Array.isArray(e.series) ? e.series[0] : undefined;

  return {
    conditionId: str(m.conditionId),
    question: str(m.question),
    slug: str(m.slug),
    eventSlug: str(e.slug),
    eventTitle: str(e.title),
    seriesSlug: strOrNull(e.seriesSlug) ?? strOrNull(series?.slug),
    sportsMarketType: strOrNull(m.sportsMarketType),
    line: numOrNull(m.line),
    outcomes: stringArray(m.outcomes),
    tokenIds: stringArray(m.clobTokenIds),
    groupItemTitle: strOrNull(m.groupItemTitle),
    gameStartTime: isoUtc(m.gameStartTime) ?? isoUtc(m.eventStartTime) ?? isoUtc(e.startTime),
    negRisk: m.negRisk === true,
  };
}
