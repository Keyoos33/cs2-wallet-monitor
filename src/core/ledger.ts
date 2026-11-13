// Registre des fills : déduplication par MULTIENSEMBLE. Code pur.
//
// L'API n'expose aucun identifiant de ligne. La clé (tx, token, side, price, size, timestamp)
// n'a aucune collision dans l'historique mais n'est pas garantie unique : deux ordres au repos
// identiques exécutés dans la même transaction donnent deux lignes strictement égales.
// On compte donc les occurrences : une fenêtre du flux contenant k fois une clé déjà vue
// c fois produit max(0, k − c) nouvelles lignes — jamais de fusion, jamais de recomptage.
//
// Précondition : la fenêtre doit contenir TOUTES les lignes des horodatages qu'elle couvre
// (lecture avec `start=` paginée jusqu'au bout), ce que garantit le client HTTP.

import type { Fill, FillSource, LedgerEvent, MarketEntry, Phase, RawActivity } from "./types.ts";

/** Clé de dédup d'une ligne TRADE. */
export function fillKey(r: { transaction_hash: string; token_id: string; side: string; price: number; size: number; timestamp: number }): string {
  return `${r.transaction_hash}|${r.token_id}|${r.side}|${r.price}|${r.size}|${r.timestamp}`;
}

/** Clé de dédup d'une ligne non-TRADE (token_id peut être vide sur les REDEEM : on joint sur condition + issue). */
export function eventKey(r: { type: string; transaction_hash: string; condition_id: string; outcome_index: number; token_id: string; size: number; usdc_size: number; timestamp: number }): string {
  return `${r.type}|${r.transaction_hash}|${r.condition_id}|${r.outcome_index}|${r.token_id}|${r.size}|${r.usdc_size}|${r.timestamp}`;
}

export function isCs2(eventSlug: string, entry?: MarketEntry | null): boolean {
  if (entry && entry.meta.seriesSlug === "counter-strike") return true;
  return typeof eventSlug === "string" && eventSlug.startsWith("cs2-");
}

/** PRE si le fill précède l'heure PRÉVUE du match ; null si elle est inconnue. */
export function phaseOf(ts: number, entry?: MarketEntry | null): Phase | null {
  const g = entry?.meta.gameStartTime;
  if (!g) return null;
  const t = Date.parse(g);
  if (Number.isNaN(t)) return null;
  return ts * 1000 < t ? "PRE" : "LIVE";
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : Number(v) || 0);
const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));

/** Dérive un `Fill` d'une ligne TRADE brute. Aucun montant inventé : tout vient de `usdc_size`, `size`, `price`. */
export function toFill(r: RawActivity, i: number, src: FillSource, detectedTs: number | null, entry?: MarketEntry | null): Fill {
  const size = num(r.size), price = num(r.price);
  const notional = size * price;
  const side = r.side === "SELL" ? "SELL" : "BUY";
  // `usdc_size` absent (ligne dégradée) : on retombe sur le notionnel, sans frais.
  const hasUsdc = typeof r.usdc_size === "number" && Number.isFinite(r.usdc_size);
  const usdc = hasUsdc ? Math.abs(r.usdc_size) : notional;
  // Achat : le preneur paie notionnel + frais. Vente : le preneur reçoit notionnel − frais (signe non vérifié sur l'API : on prend l'écart absolu).
  const diff = side === "BUY" ? usdc - notional : notional - usdc;
  const taker = diff > 1e-6;
  const ts = num(r.timestamp);
  return {
    i,
    timestamp: ts,
    transaction_hash: str(r.transaction_hash),
    token_id: str(r.token_id),
    condition_id: str(r.condition_id),
    outcome_index: num(r.outcome_index),
    side,
    size,
    price,
    usdc_size: usdc,
    slug: str(r.slug),
    event_slug: str(r.event_slug),
    outcome: str(r.outcome),
    fee: taker ? diff : 0,
    taker,
    phase: phaseOf(ts, entry),
    cs2: isCs2(str(r.event_slug), entry),
    src,
    detected_ts: detectedTs,
    lag_s: detectedTs === null ? null : Math.max(0, detectedTs - ts),
  };
}

export function toEvent(r: RawActivity, src: FillSource, detectedTs: number | null): LedgerEvent {
  return {
    type: str(r.type),
    timestamp: num(r.timestamp),
    transaction_hash: str(r.transaction_hash),
    condition_id: str(r.condition_id),
    token_id: str(r.token_id),
    outcome_index: num(r.outcome_index),
    size: num(r.size),
    usdc_size: num(r.usdc_size),
    src,
    detected_ts: detectedTs,
  };
}

export interface IngestResult { fills: Fill[]; events: LedgerEvent[] }

/** Registre en mémoire : fills (ordre d'ajout = numéro `i`), événements, compteurs d'occurrences. */
export class Ledger {
  fills: Fill[] = [];
  events: LedgerEvent[] = [];
  private fillCounts = new Map<string, number>();
  private eventCounts = new Map<string, number>();

  /** Recharge un registre persistant (lignes déjà dédupliquées). */
  load(fills: Fill[], events: LedgerEvent[]): void {
    for (const f of fills) this.pushFill(f);
    for (const e of events) this.pushEvent(e);
  }

  private pushFill(f: Fill): void {
    this.fills.push(f);
    const k = fillKey(f);
    this.fillCounts.set(k, (this.fillCounts.get(k) ?? 0) + 1);
  }
  private pushEvent(e: LedgerEvent): void {
    this.events.push(e);
    const k = eventKey(e);
    this.eventCounts.set(k, (this.eventCounts.get(k) ?? 0) + 1);
  }

  countOf(key: string): number { return this.fillCounts.get(key) ?? 0; }

  /**
   * Compare une fenêtre du flux au registre et renvoie UNIQUEMENT les lignes nouvelles,
   * sans rien modifier (le registre n'est mis à jour que par `commit`, après écriture disque).
   * Les lignes sont rendues dans l'ordre chronologique (horodatage croissant, ordre du flux inversé).
   */
  diff(rows: RawActivity[], src: FillSource, detectedTs: number | null, marketOf: (conditionId: string) => MarketEntry | null | undefined): IngestResult {
    const seenF = new Map<string, number>();
    const seenE = new Map<string, number>();
    const newFills: RawActivity[] = [];
    const newEvents: RawActivity[] = [];
    for (const r of rows) {
      if (!r || typeof r !== "object") continue;
      if (r.type === "TRADE" || r.type === undefined) {
        const k = fillKey({ ...r, side: r.side === "SELL" ? "SELL" : "BUY" } as RawActivity);
        const c = (seenF.get(k) ?? 0) + 1;
        seenF.set(k, c);
        if (c > (this.fillCounts.get(k) ?? 0)) newFills.push(r);
      } else {
        const k = eventKey(toEvent(r, src, null));
        const c = (seenE.get(k) ?? 0) + 1;
        seenE.set(k, c);
        if (c > (this.eventCounts.get(k) ?? 0)) newEvents.push(r);
      }
    }
    // Le flux est « plus récent d'abord » : on remet en ordre chronologique en conservant l'ordre de chaîne.
    const chrono = <T extends { timestamp: number }>(a: T[]): T[] =>
      a.map((x, idx) => ({ x, idx })).sort((p, q) => (p.x.timestamp - q.x.timestamp) || (q.idx - p.idx)).map((p) => p.x);
    let i = this.fills.length;
    return {
      fills: chrono(newFills).map((r) => toFill(r, i++, src, detectedTs, marketOf(str(r.condition_id)))),
      events: chrono(newEvents).map((r) => toEvent(r, src, detectedTs)),
    };
  }

  /** Enregistre le résultat d'un `diff` (à appeler une fois les lignes écrites sur disque). */
  commit(res: IngestResult): void {
    for (const f of res.fills) {
      if (f.i !== this.fills.length) throw new Error(`registre: numéro de fill inattendu ${f.i} (attendu ${this.fills.length})`);
      this.pushFill(f);
    }
    for (const e of res.events) this.pushEvent(e);
  }

  /**
   * Lignes du registre absentes d'une relecture complète de l'historique (« fantômes »), pour la réconciliation.
   * Ne considère que les horodatages ≤ `maxTs`.
   */
  phantoms(rows: RawActivity[], maxTs: number): number {
    const api = new Map<string, number>();
    for (const r of rows) {
      if (r.type !== "TRADE") continue;
      const k = fillKey({ ...r, side: r.side === "SELL" ? "SELL" : "BUY" } as RawActivity);
      api.set(k, (api.get(k) ?? 0) + 1);
    }
    let n = 0;
    for (const [k, c] of this.fillCounts) {
      const ts = Number(k.slice(k.lastIndexOf("|") + 1));
      if (ts > maxTs) continue;
      const a = api.get(k) ?? 0;
      if (c > a) n += c - a;
    }
    return n;
  }
}
