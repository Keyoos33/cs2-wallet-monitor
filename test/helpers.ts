// Outils communs aux tests. `describeBet` / `toMarketMeta` : on charge les vrais modules de l'agent traducteur
// s'ils sont présents (src/core/translate.ts, src/core/gamma.ts) ; sinon, des doublures locales minimales.
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { toMarketEntry } from "../src/core/market-entry.ts";
import type { BetDescription, MarketEntry, MarketMeta, RawActivity } from "../src/core/types.ts";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const RAW_DIR = path.join(ROOT, "data", "raw");
export const HAS_RAW = fs.existsSync(path.join(RAW_DIR, "activity.jsonl")) && fs.existsSync(path.join(RAW_DIR, "positions.json"));
export const FIX_DIR = path.join(ROOT, "test", "fixtures", "real");

function stubToMarketMeta(m: any, ev?: any): MarketMeta {
  const e = ev ?? m?.events?.[0] ?? {};
  const arr = (v: unknown): string[] => { try { const a = typeof v === "string" ? JSON.parse(v) : v; return Array.isArray(a) ? a.map(String) : []; } catch { return []; } };
  const iso = (v: unknown): string | null => {
    if (typeof v !== "string" || !v) return null;
    const t = Date.parse(v.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00"));
    return Number.isNaN(t) ? null : new Date(t).toISOString();
  };
  return {
    conditionId: String(m?.conditionId ?? ""), question: String(m?.question ?? ""), slug: String(m?.slug ?? ""),
    eventSlug: String(e.slug ?? ""), eventTitle: String(e.title ?? ""), seriesSlug: e.seriesSlug ?? null,
    sportsMarketType: m?.sportsMarketType ?? null, line: typeof m?.line === "number" ? m.line : null,
    outcomes: arr(m?.outcomes), tokenIds: arr(m?.clobTokenIds), groupItemTitle: m?.groupItemTitle ?? null,
    gameStartTime: iso(m?.gameStartTime) ?? iso(e.startTime), negRisk: m?.negRisk === true,
  };
}

const STUB_KEYS: Record<string, [string, string]> = {
  moneyline: ["match_winner", "Vainqueur du match"], child_moneyline: ["map_winner", "Vainqueur d'une carte"],
  map_handicap: ["map_handicap", "Handicap de cartes"], totals: ["total_maps", "Nombre de cartes (plus/moins)"],
};
function stubDescribeBet(meta: MarketMeta, oi: number): BetDescription {
  const t = /^Counter-Strike: (.+?)(?: \((BO\d)\))?(?: - (.+))?$/.exec(meta.eventTitle);
  const [key, fr] = STUB_KEYS[meta.sportsMarketType ?? ""] ?? ["unknown", "Type non reconnu"];
  return {
    match: t?.[1] ?? meta.eventTitle, format: t?.[2] ?? null, tournament: t?.[3] ?? "", marketTypeKey: key, marketTypeFr: fr,
    betFr: `${meta.outcomes[oi] ?? "?"} (${fr})`, winConditionFr: "", exact: key !== "unknown",
  };
}

async function tryImport(rel: string): Promise<any | null> {
  const file = path.join(ROOT, rel);
  if (!fs.existsSync(file)) return null;
  try { return await import(/* @vite-ignore */ file); } catch { return null; }
}
const tr = await tryImport("src/core/translate.ts");
const gm = await tryImport("src/core/gamma.ts");
export const REAL_TRANSLATOR = !!tr?.describeBet && !!gm?.toMarketMeta;
export const describeBet: (meta: MarketMeta, oi: number) => BetDescription = tr?.describeBet ?? stubDescribeBet;
export const toMarketMeta: (m: any, e?: any) => MarketMeta = gm?.toMarketMeta ?? stubToMarketMeta;

export function readJsonl<T = any>(file: string): T[] {
  return fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as T);
}

/** Charge activité (ordre du flux : plus récent d'abord), marchés et positions d'un répertoire au format data/raw. */
export function loadRaw(dir: string): { rows: RawActivity[]; markets: Map<string, MarketEntry>; positions: any[] } {
  const rows = readJsonl<RawActivity>(path.join(dir, "activity.jsonl")).reverse();
  const markets = new Map<string, MarketEntry>();
  for (const m of readJsonl(path.join(dir, "markets.jsonl"))) {
    const e = toMarketEntry(m, toMarketMeta, 1794555000);
    markets.set(e.meta.conditionId, e);
  }
  const positions = JSON.parse(fs.readFileSync(path.join(dir, "positions.json"), "utf8")).positions as any[];
  return { rows, markets, positions };
}

// ── Fabrique de lignes synthétiques (marquées comme telles : hash "0xsynth…") ──

let seq = 0;
export function trade(o: Partial<RawActivity> & { ts: number; size: number; price: number; fee?: number; token?: string; cond?: string }): RawActivity {
  const side = o.side ?? "BUY";
  const notional = o.size * o.price;
  const fee = o.fee ?? 0;
  return {
    type: "TRADE", timestamp: o.ts, transaction_hash: o.transaction_hash ?? `0xsynth${(++seq).toString(16).padStart(6, "0")}`,
    condition_id: o.cond ?? "0xc0nd1", token_id: o.token ?? "tokA", side, outcome_index: o.outcome_index ?? 0,
    size: o.size, price: o.price, usdc_size: o.usdc_size ?? (side === "BUY" ? notional + fee : notional - fee),
    title: o.title ?? "Counter-Strike: Alpha vs Beta (BO3) - Synth Cup", slug: o.slug ?? "cs2-alpha-beta-2026-01-01",
    event_slug: o.event_slug ?? "cs2-alpha-beta-2026-01-01", outcome: o.outcome ?? "Alpha",
  };
}

export function synthMarket(cond = "0xc0nd1", o: Partial<MarketEntry> & { start?: string; tokens?: string[]; type?: string } = {}): MarketEntry {
  return {
    meta: {
      conditionId: cond, question: "Counter-Strike: Alpha vs Beta (BO3) - Synth Cup", slug: "cs2-alpha-beta-2026-01-01",
      eventSlug: "cs2-alpha-beta-2026-01-01", eventTitle: "Counter-Strike: Alpha vs Beta (BO3) - Synth Cup", seriesSlug: "counter-strike",
      sportsMarketType: o.type ?? "moneyline", line: null, outcomes: ["Alpha", "Beta"], tokenIds: o.tokens ?? ["tokA", "tokB"],
      groupItemTitle: null, gameStartTime: o.start ?? "2026-01-01T18:00:00.000Z", negRisk: false,
    },
    eventId: "1", league: null, closed: o.closed ?? false, resolved: o.resolved ?? false, prices: o.prices ?? null,
    closedTs: o.closedTs ?? null, fetched_ts: 0,
  };
}

/** 2026-01-01T12:00:00Z : six heures avant le début du match synthétique. */
export const T0 = 1767268800;
