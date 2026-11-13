// Client HTTP des API publiques Polymarket (Data API v2, Gamma, CLOB). Aucune authentification.
// Voir notes/API_NOTES.md : cache CDN contourné par `_=<ms>`, pagination par curseur,
// `condition_ids` répété, `closed=true|false` à interroger séparément, carnet en 404 si marché fermé.

import type { RawActivity } from "../core/types.ts";

export const DATA_API = "https://data-api.polymarket.com/v2";
export const GAMMA_API = "https://gamma-api.polymarket.com";
export const CLOB_API = "https://clob.polymarket.com";

/** Tous les types d'activité (TIP n'est servi que s'il est nommé). */
export const ALL_TYPES = "TRADE,SPLIT,MERGE,REDEEM,CONVERSION,MIGRATION,REWARD,YIELD,MAKER_REBATE,TAKER_REBATE,REFERRAL_REWARD,"
  + "DEPOSIT,WITHDRAWAL,DIRECTIONAL_SPLIT,DIRECTIONAL_MERGE,THRESHOLD_COMPOSE,THRESHOLD_DECOMPOSE,TIP";

export class HttpError extends Error {
  status: number;
  retryAfterS: number | null;
  constructor(where: string, status: number, retryAfterS: number | null) {
    super(`${where}: HTTP ${status}`);
    this.status = status;
    this.retryAfterS = retryAfterS;
  }
  /** 429 ou 5xx : on ralentit (backoff). */
  get transient(): boolean { return this.status === 429 || this.status >= 500; }
}

export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{
  ok: boolean; status: number; headers: { get(name: string): string | null }; json(): Promise<unknown>; text(): Promise<string>;
}>;

/** GET JSON avec délai maximal. Le message d'erreur ne contient que l'hôte et le chemin (jamais la requête). */
export async function getJson(fetchImpl: FetchLike, url: string, timeoutMs: number): Promise<unknown> {
  const u = new URL(url);
  const where = `${u.host}${u.pathname}`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { headers: { Accept: "application/json", "User-Agent": "cs2-wallet-monitor/1.0" }, signal: ac.signal });
    if (!res.ok) {
      const ra = Number(res.headers.get("retry-after"));
      throw new HttpError(where, res.status, Number.isFinite(ra) && ra > 0 ? ra : null);
    }
    return await res.json();
  } catch (e) {
    if (e instanceof HttpError) throw e;
    const name = (e as { name?: string })?.name;
    throw new Error(`${where}: ${name === "AbortError" ? `délai dépassé (${timeoutMs} ms)` : "erreur réseau"}`);
  } finally {
    clearTimeout(timer);
  }
}

export interface PolymarketApi {
  /** Toutes les lignes d'activité d'horodatage ≥ start (paginé jusqu'au bout), plus récentes d'abord. */
  activitySince(start: number, limit: number): Promise<RawActivity[]>;
  /** Marchés Gamma bruts pour ces condition_id (ouverts et fermés). */
  markets(conditionIds: string[]): Promise<unknown[]>;
  /** Carnet CLOB d'un token ; null si aucun carnet (marché fermé). */
  book(tokenId: string): Promise<unknown | null>;
}

export function createApi(opts: { wallet: string; timeoutMs: number; fetchImpl?: FetchLike; maxPages?: number }): PolymarketApi {
  const f: FetchLike = opts.fetchImpl ?? (fetch as unknown as FetchLike);
  const bust = (): string => `_=${Date.now()}`;
  return {
    async activitySince(start, limit) {
      const base = `${DATA_API}/activity?user=${opts.wallet}&type=${ALL_TYPES}&exclude_deposits_withdrawals=false`;
      const rows: RawActivity[] = [];
      let cursor: string | null = null;
      const maxPages = opts.maxPages ?? 500;
      for (let page = 0; page < maxPages; page++) {
        const url: string = `${base}&limit=${limit}&start=${Math.max(1, Math.floor(start))}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}&${bust()}`;
        // Une page de 1000 lignes prend jusqu'à 1 s : on laisse plus de marge sur les longues lectures.
        const body = (await getJson(f, url, limit > 200 ? Math.max(opts.timeoutMs, 30000) : opts.timeoutMs)) as { data?: unknown; pagination?: { next_cursor?: string | null } };
        if (!Array.isArray(body?.data)) throw new Error("data-api.polymarket.com/v2/activity: réponse inattendue");
        for (const r of body.data) rows.push(r as RawActivity);
        cursor = body.pagination?.next_cursor ?? null;
        if (!cursor || body.data.length === 0) return rows;
      }
      throw new Error("data-api.polymarket.com/v2/activity: pagination interminable");
    },

    async markets(conditionIds) {
      const out: unknown[] = [];
      const ids = [...new Set(conditionIds.filter((c) => /^0x[0-9a-fA-F]+$/.test(c)))];
      for (let i = 0; i < ids.length; i += 40) {
        const chunk = ids.slice(i, i + 40);
        const q = chunk.map((c) => `condition_ids=${c}`).join("&");
        const got = new Set<string>();
        for (const closed of ["false", "true"]) {
          if (got.size === chunk.length) break;
          const body = await getJson(f, `${GAMMA_API}/markets?${q}&closed=${closed}&limit=${chunk.length}&${bust()}`, Math.max(opts.timeoutMs, 15000));
          if (!Array.isArray(body)) throw new Error("gamma-api.polymarket.com/markets: réponse inattendue");
          for (const m of body) {
            const c = (m as { conditionId?: string })?.conditionId;
            if (typeof c === "string" && !got.has(c)) { got.add(c); out.push(m); }
          }
        }
      }
      return out;
    },

    async book(tokenId) {
      try {
        return await getJson(f, `${CLOB_API}/book?token_id=${encodeURIComponent(tokenId)}`, opts.timeoutMs);
      } catch (e) {
        if (e instanceof HttpError && e.status === 404) return null;
        throw e;
      }
    },
  };
}
