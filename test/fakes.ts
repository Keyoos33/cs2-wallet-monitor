// Doublures d'E/S pour les tests de la chaîne : API Polymarket scriptée, Telegram, horloge.
import { DEFAULT_CONFIG } from "../src/core/config.ts";
import type { Config } from "../src/core/config.ts";
import type { RawActivity } from "../src/core/types.ts";
import type { PipelineDeps } from "../src/runner/pipeline.ts";
import { HttpError } from "../src/runner/polymarket.ts";
import type { PolymarketApi } from "../src/runner/polymarket.ts";
import type { Store } from "../src/runner/store.ts";
import type { Sender, SendResult } from "../src/runner/telegram.ts";
import { describeBet, toMarketMeta } from "./helpers.ts";

export class Clock { t: number; constructor(t: number) { this.t = t; } now = (): number => this.t; }

/** Marché Gamma brut minimal (forme réelle : chaînes JSON, events[0]). */
export function gammaMarket(cond: string, o: { closed?: boolean; prices?: string[]; tokens?: string[]; start?: string; type?: string; slug?: string } = {}): any {
  return {
    conditionId: cond, question: "Counter-Strike: Alpha vs Beta (BO3) - Synth Cup", slug: o.slug ?? "cs2-alpha-beta-2026-01-01",
    outcomes: '["Alpha", "Beta"]', outcomePrices: JSON.stringify(o.prices ?? ["0.5", "0.5"]),
    clobTokenIds: JSON.stringify(o.tokens ?? ["tokA", "tokB"]), sportsMarketType: o.type ?? "moneyline",
    gameStartTime: o.start ?? "2026-01-01 18:00:00+00", closed: !!o.closed,
    ...(o.closed ? { umaResolutionStatus: "resolved", closedTime: "2026-01-01 21:00:00+00" } : {}),
    events: [{ id: "1", slug: "cs2-alpha-beta-2026-01-01", title: "Counter-Strike: Alpha vs Beta (BO3) - Synth Cup", seriesSlug: "counter-strike", startTime: "2026-01-01T18:00:00Z" }],
  };
}

export class FakeApi implements PolymarketApi {
  /** Toutes les lignes du « flux » ; seules celles d'horodatage ≤ horloge sont visibles. */
  rows: RawActivity[] = [];
  gamma = new Map<string, any>();
  failActivity = 0;       // nombre d'appels à faire échouer
  failMarkets = false;
  failBook = false;
  calls = { activity: 0, markets: 0, book: 0 };
  clock: Clock;
  constructor(clock: Clock) { this.clock = clock; }
  async activitySince(start: number): Promise<RawActivity[]> {
    this.calls.activity++;
    if (this.failActivity > 0) { this.failActivity--; throw new HttpError("data-api.polymarket.com/v2/activity", 503, null); }
    return this.rows.filter((r) => r.timestamp >= start && r.timestamp <= this.clock.t).sort((a, b) => b.timestamp - a.timestamp);
  }
  async markets(conds: string[]): Promise<unknown[]> {
    this.calls.markets++;
    if (this.failMarkets) throw new Error("gamma-api.polymarket.com/markets: erreur réseau");
    return conds.map((c) => this.gamma.get(c)).filter(Boolean);
  }
  async book(): Promise<unknown | null> {
    this.calls.book++;
    if (this.failBook) throw new Error("clob.polymarket.com/book: erreur réseau");
    return { asks: [{ price: "0.55", size: "1000" }, { price: "0.51", size: "400" }], bids: [] };
  }
}

export class FakeSender implements Sender {
  dryRun = false;
  sent: Array<{ html: string; plain: string }> = [];
  /** Nombre d'envois à faire échouer avant de réussir. */
  failNext = 0;
  attempts = 0;
  async send(html: string, plain: string): Promise<SendResult> {
    this.attempts++;
    if (this.failNext > 0) { this.failNext--; return { ok: false, dry: false, tries: 3, error: "http 502" }; }
    this.sent.push({ html, plain });
    return { ok: true, dry: false, tries: 1 };
  }
}

export function deps(store: Store, api: FakeApi, sender: Sender, clock: Clock, over: Partial<Config> = {}, runId = "run-test"): PipelineDeps & { logs: string[] } {
  const logs: string[] = [];
  return {
    cfg: { ...DEFAULT_CONFIG, ...over }, store, api, sender, now: clock.now, log: (l) => { logs.push(l); },
    describe: describeBet, toMarketMeta, runId, logs,
  };
}
