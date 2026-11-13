// Chaîne de traitement commune au moniteur, au backfill, à la réconciliation et au rejeu TEST :
// lignes du flux → registre (dédup) → positions → machine d'alertes → Telegram → fichiers.
// Toutes les dépendances d'E/S sont injectées (API, Telegram, magasin, horloge) pour les tests.

import * as fs from "node:fs";
import * as path from "node:path";
import {
  bookSnapshot, buildAlertInput, dueAlerts, emptyAlertState, ingestFill, markSent, openTokens, pendingCount, resultAlerts,
} from "../core/alerts.ts";
import type { Config } from "../core/config.ts";
import { buildDashboardData, safeDescribe, stubMeta } from "../core/dashboard-data.ts";
import { formatAlert, toPlainText, toTelegramHtml } from "../core/format.ts";
import { Ledger, phaseOf } from "../core/ledger.ts";
import { entryChanged, stubEntry, toMarketEntry } from "../core/market-entry.ts";
import { buildPositions } from "../core/positions.ts";
import type {
  AlertDraft, AlertRecord, BetDescription, BookSnapshot, Fill, FillSource, Heartbeat, LedgerEvent, MarketEntry, MarketMeta,
  Position, RawActivity, RunnerState,
} from "../core/types.ts";
import type { PolymarketApi } from "./polymarket.ts";
import { FILES, readAlerts, readEvents, readFills, readMarkets, readState, writeMarkets } from "./store.ts";
import type { Store, SyncResult } from "./store.ts";
import type { Sender } from "./telegram.ts";

export interface PipelineDeps {
  cfg: Config;
  store: Store;
  api: PolymarketApi;
  sender: Sender;
  /** Horloge murale, en secondes. */
  now: () => number;
  log: (line: string) => void;
  describe: (meta: MarketMeta, outcomeIndex: number) => BetDescription;
  toMarketMeta: (gammaMarket: any, gammaEvent?: any) => MarketMeta;
  runId: string;
  /** Rejeu : alertes préfixées « 🧪 TEST (rejeu historique) ». */
  isTest?: boolean;
}

export function freshState(): RunnerState {
  return { v: 1, cursor: 0, lease: null, alerts: emptyAlertState(), open: [], ledger_n: 0, bootstrapped_ts: null, last_reconcile_ts: null, last_fill_ts: 0 };
}

export interface ReconcileReport {
  done_ts: number; run_id: string; api_trades: number; ledger_fills: number;
  added_fills: number; added_events: number; alerted_fills: number; phantoms: number;
}

/** Message d'erreur sobre : jamais de pile, jamais d'URL avec requête. */
export function errText(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.split("\n")[0].replace(/\?[^\s]*/g, "").slice(0, 160);
}

export class Pipeline {
  readonly d: PipelineDeps;
  ledger = new Ledger();
  markets = new Map<string, MarketEntry>();
  alerts: AlertRecord[] = [];
  state: RunnerState = freshState();
  positions = new Map<string, Position>();
  /** Par token : nombre de fills et cash d'achat déjà au registre (position « avant » un nouveau fill). */
  private agg = new Map<string, { nFills: number; cash: number }>();
  siteDirty = false;
  marketsDirty = false;
  startedTs: number;
  polls = 0;
  errors = 0;
  lastPollOkTs = 0;

  constructor(d: PipelineDeps) {
    this.d = d;
    this.startedTs = d.now();
  }

  // ── Chargement ─────────────────────────────────────────────────────────────

  load(): void {
    const s = this.d.store;
    const fills = readFills(s);
    let renum = 0;
    fills.forEach((f, idx) => { if (f.i !== idx) { f.i = idx; renum++; } });
    if (renum > 0) this.d.log(`registre: ${renum} numéros de fills incohérents, renumérotés d'après la position dans le fichier`);
    this.ledger = new Ledger();
    this.ledger.load(fills, readEvents(s));
    this.markets = readMarkets(s);
    this.alerts = readAlerts(s);
    this.state = readState(s) ?? freshState();
    this.state.alerts ??= emptyAlertState();
    this.state.open ??= [];
    this.recompute();

    // Garde-fous de reprise : rien de ce qui a déjà été envoyé ne doit repartir.
    const sentDrafts = new Set<string>();
    const sentFills = new Set<number>();
    for (const a of this.alerts) {
      if (a.is_test) continue;
      sentDrafts.add(`${a.kind}|${a.token_id}|${a.created_ts}`);
      for (const i of a.fills) sentFills.add(i);
    }
    this.state.alerts.outbox = this.state.alerts.outbox.filter((dft) => !sentDrafts.has(`${dft.kind}|${dft.token_id}|${dft.created_ts}`));

    // Fills écrits au registre mais jamais présentés à la machine d'alertes (arrêt brutal entre deux écritures).
    const n = Math.min(this.state.ledger_n, fills.length);
    this.agg = new Map();
    for (let i = 0; i < n; i++) this.bumpAgg(fills[i]);
    let orphans = 0;
    const now = this.d.now();
    for (let i = n; i < fills.length; i++) {
      const f = fills[i];
      if (f.src !== "backfill" && !sentFills.has(f.i)) {
        if (ingestFill(this.state.alerts, f, this.agg.get(f.token_id) ?? { nFills: 0, cash: 0 }, now)) orphans++;
      }
      this.bumpAgg(f);
    }
    this.state.ledger_n = fills.length;
    if (orphans > 0) this.d.log(`reprise: ${orphans} fills du registre remis dans la file d'alertes`);
  }

  private bumpAgg(f: Fill): void {
    const a = this.agg.get(f.token_id);
    const cash = f.side === "BUY" ? f.usdc_size : 0;
    if (a) { a.nFills++; a.cash += cash; } else this.agg.set(f.token_id, { nFills: 1, cash });
  }

  recompute(): void {
    const list = buildPositions(this.ledger.fills, this.ledger.events, this.markets);
    this.positions = new Map(list.map((p) => [p.token_id, p]));
  }

  // ── Marchés (Gamma) ────────────────────────────────────────────────────────

  /**
   * Charge les métadonnées Gamma manquantes (ou périmées si `force`). Ne lève jamais :
   * en cas de panne, une entrée minimale est construite depuis la ligne du flux et sera rafraîchie plus tard.
   * Renvoie true si quelque chose de significatif a changé (résolution, heure du match…).
   */
  async ensureMarkets(conds: string[], sample?: Map<string, RawActivity>, force = false): Promise<boolean> {
    const now = this.d.now();
    const need = [...new Set(conds)].filter((c) => {
      if (!c) return false;
      const e = this.markets.get(c);
      if (!e) return true;
      if (force) return true;
      return !!e.stub && now - e.fetched_ts >= this.d.cfg.MARKET_RETRY_S;
    });
    if (need.length === 0) return false;
    let changed = false;
    try {
      const raws = await this.d.api.markets(need);
      for (const raw of raws) {
        try {
          const e = toMarketEntry(raw, this.d.toMarketMeta, now);
          if (!e.meta.conditionId) continue;
          if (entryChanged(this.markets.get(e.meta.conditionId), e)) { changed = true; this.marketsDirty = true; }
          this.markets.set(e.meta.conditionId, e);
        } catch (err) {
          this.d.log(`gamma: marché illisible ignoré (${errText(err)})`);
        }
      }
    } catch (err) {
      this.errors++;
      this.d.log(`gamma: indisponible, ${need.length} marché(s) en attente (${errText(err)})`);
    }
    for (const c of need) {
      const e = this.markets.get(c);
      if (e) { if (e.stub) e.fetched_ts = now; continue; }
      const r = sample?.get(c);
      if (r) { this.markets.set(c, stubEntry(r, now)); this.marketsDirty = true; }
    }
    return changed;
  }

  // ── Ingestion ──────────────────────────────────────────────────────────────

  /**
   * Compare des lignes du flux au registre, écrit les nouvelles, met à jour positions et alertes.
   * `alert(f)` décide si un nouveau fill peut déclencher une alerte (jamais pour le backfill).
   */
  async ingest(rows: RawActivity[], src: FillSource, alert: (f: Fill) => boolean = () => true): Promise<{ fills: Fill[]; events: LedgerEvent[] }> {
    const sample = new Map<string, RawActivity>();
    let maxTs = 0;
    for (const r of rows) {
      if (typeof r?.timestamp === "number" && r.timestamp > maxTs) maxTs = r.timestamp;
      if (r?.type === "TRADE" && r.condition_id && !sample.has(r.condition_id)) sample.set(r.condition_id, r);
    }
    await this.ensureMarkets([...sample.keys()], sample);

    const now = this.d.now();
    const res = this.ledger.diff(rows, src, src === "backfill" ? null : now, (c) => this.markets.get(c));
    if (maxTs > this.state.cursor) this.state.cursor = maxTs;
    if (res.fills.length === 0 && res.events.length === 0) return res;

    // Disque d'abord, mémoire ensuite : un échec d'écriture laisse le registre en mémoire inchangé (les lignes seront revues).
    this.d.store.appendJsonl(FILES.fills, res.fills);
    this.d.store.appendJsonl(FILES.events, res.events);
    this.ledger.commit(res);

    for (const f of res.fills) {
      if (src !== "backfill" && alert(f)) ingestFill(this.state.alerts, f, this.agg.get(f.token_id) ?? { nFills: 0, cash: 0 }, now);
      this.bumpAgg(f);
      if (f.timestamp > this.state.last_fill_ts) this.state.last_fill_ts = f.timestamp;
    }
    this.state.ledger_n = this.ledger.fills.length;
    this.siteDirty = true;

    // Un REDEEM annonce une résolution : on rafraîchit tout de suite le marché concerné.
    const redeemed = res.events.filter((e) => e.type === "REDEEM" && e.condition_id).map((e) => e.condition_id);
    if (redeemed.length > 0 && src !== "backfill") await this.ensureMarkets(redeemed, undefined, true);
    this.recompute();
    return res;
  }

  // ── Résolutions ────────────────────────────────────────────────────────────

  /** Interroge Gamma (cache contourné) pour les positions ouvertes dont le match a commencé, et les marchés sans métadonnées. */
  async refreshResolutions(): Promise<void> {
    const now = this.d.now();
    const conds = new Set<string>();
    for (const p of this.positions.values()) {
      if (p.status !== "open") continue;
      const e = this.markets.get(p.condition_id);
      const start = e?.meta.gameStartTime ? Date.parse(e.meta.gameStartTime) / 1000 : NaN;
      if (!e || e.stub || Number.isNaN(start) || start <= now) conds.add(p.condition_id);
    }
    for (const [c, e] of this.markets) if (e.stub) conds.add(c);
    if (conds.size === 0) return;
    if (await this.ensureMarkets([...conds], undefined, true)) {
      this.recompute();
      this.siteDirty = true;
    }
  }

  // ── Alertes ────────────────────────────────────────────────────────────────

  /** Fait avancer la machine d'alertes et envoie ce qui est mûr. Renvoie le nombre d'alertes envoyées. */
  async tick(): Promise<number> {
    const now = this.d.now();
    const lk = { fill: (i: number) => this.ledger.fills[i], position: (t: string) => this.positions.get(t) };
    dueAlerts(this.state.alerts, now, this.d.cfg, lk);
    resultAlerts(this.state.alerts, this.state.open, this.positions, now);
    this.state.open = openTokens(this.positions.values());
    return this.sendOutbox();
  }

  private betOf(dft: AlertDraft, entry: MarketEntry | undefined): BetDescription {
    const p = this.positions.get(dft.token_id);
    const meta = entry?.meta ?? stubMeta({
      condition_id: dft.condition_id, slug: p?.slug ?? "", event_slug: p?.event_slug ?? "", outcome: p?.outcome ?? "", outcome_index: dft.outcome_index,
    });
    return safeDescribe(this.d.describe, meta, dft.outcome_index, p?.outcome ?? "");
  }

  private async sendOutbox(): Promise<number> {
    let sent = 0;
    // Copie : la file est modifiée pendant l'envoi.
    for (const dft of [...this.state.alerts.outbox]) {
      const now = this.d.now();
      if (dft.tries > 0 && dft.last_try_ts !== undefined && now - dft.last_try_ts < Math.min(300, 5 * 2 ** dft.tries)) continue;
      try {
        const entry = this.markets.get(dft.condition_id);
        if (dft.phase === null && dft.kind !== "RESULT") dft.phase = phaseOf(dft.lastTs, entry);
        let book: BookSnapshot | null | undefined;
        if (dft.kind === "NEW" || dft.kind === "INCREASE") {
          book = null;
          try {
            const raw = await this.d.api.book(dft.token_id);
            if (raw !== null) book = bookSnapshot(raw, dft.avgPrice + this.d.cfg.BOOK_PRICE_MARGIN, this.d.now());
          } catch (err) {
            this.d.log(`clob: carnet indisponible pour l'alerte ${dft.id} (${errText(err)})`);
          }
        }
        const input = buildAlertInput(dft, this.betOf(dft, entry), entry, {
          now: this.d.now(), tz: this.d.cfg.TZ, lateLagS: this.d.cfg.LATE_LAG_S, book, isTest: this.d.isTest,
        });
        const msg = formatAlert(input);
        const res = await this.d.sender.send(toTelegramHtml(msg), toPlainText(msg));
        const sentTs = this.d.now();
        if (!res.ok) {
          dft.tries++;
          dft.last_try_ts = sentTs;
          this.errors++;
          this.d.log(`telegram: échec de l'alerte ${dft.id} (${res.error ?? "inconnu"}), essai n° ${dft.tries}, elle reste en attente`);
          continue;
        }
        const rec: AlertRecord = {
          id: dft.id, kind: dft.kind, token_id: dft.token_id, condition_id: dft.condition_id, fills: dft.fills, usdc: dft.usdc,
          title: msg.title, text: msg.body, url: msg.url,
          created_ts: dft.created_ts, sent_ts: sentTs,
          lat_detect_s: Math.max(0, dft.firstDetTs - (dft.kind === "RESULT" ? dft.lastTs : dft.firstTs)),
          lat_send_s: Math.max(0, sentTs - dft.firstDetTs),
          status: res.dry ? "dry" : "ok", tries: dft.tries + res.tries, is_test: !!this.d.isTest, book: book ?? null,
        };
        // Ordre : journal des alertes, puis état — un arrêt entre les deux est rattrapé au chargement (pas de double envoi).
        this.d.store.appendJsonl(FILES.alerts, [rec]);
        this.alerts.push(rec);
        markSent(this.state.alerts, dft.id);
        this.d.store.writeJson(FILES.state, this.state);
        this.siteDirty = true;
        sent++;
        this.d.log(`alerte ${dft.id} ${dft.kind} envoyée (${dft.fills.length} fill(s), détection→envoi ${Math.round(rec.lat_send_s)} s)`);
      } catch (err) {
        dft.tries++;
        dft.last_try_ts = this.d.now();
        this.errors++;
        this.d.log(`alerte ${dft.id}: erreur de préparation (${errText(err)}), elle reste en attente`);
      }
    }
    return sent;
  }

  // ── Persistance ────────────────────────────────────────────────────────────

  heartbeat(): Heartbeat {
    return {
      ts: this.d.now(), run_id: this.d.runId, started_ts: this.startedTs, last_poll_ok_ts: this.lastPollOkTs,
      last_fill_ts: this.state.last_fill_ts, polls: this.polls, errors: this.errors,
      outbox: this.state.alerts.outbox.length, pending: pendingCount(this.state.alerts),
    };
  }

  buildSite(): void {
    const data = buildDashboardData({
      now: this.d.now(), wallet: this.d.cfg.WALLET, tz: this.d.cfg.TZ, initialWindowS: this.d.cfg.INITIAL_WINDOW_S,
      buckets: this.d.cfg.STAKE_BUCKETS, alertLogMax: this.d.cfg.ALERT_LOG_MAX,
      fills: this.ledger.fills, events: this.ledger.events, positions: [...this.positions.values()], markets: this.markets,
      alerts: this.alerts.filter((a) => !a.is_test), health: this.heartbeat(), describe: this.d.describe,
    });
    this.d.store.writeJson(FILES.data, data);
  }

  /** Écrit les fichiers modifiés (sans pousser). */
  flush(withHeartbeat: boolean): void {
    if (this.siteDirty) { this.buildSite(); this.siteDirty = false; withHeartbeat = true; }
    if (this.marketsDirty) { writeMarkets(this.d.store, this.markets); this.marketsDirty = false; }
    if (withHeartbeat) this.d.store.writeJson(FILES.heartbeat, this.heartbeat());
    this.d.store.writeJson(FILES.state, this.state);
  }

  /** Écrit puis pousse. Ne lève jamais. */
  persist(message: string, withHeartbeat = false): SyncResult {
    try {
      this.flush(withHeartbeat);
      return this.d.store.sync(message);
    } catch (err) {
      this.errors++;
      this.d.log(`persistance: échec (${errText(err)})`);
      return "failed";
    }
  }

  // ── Backfill ───────────────────────────────────────────────────────────────

  /**
   * Initialise le registre avec tout l'historique : fichiers `data/raw/*.jsonl` s'ils existent (puis complément API),
   * sinon lecture complète de l'API. Les fills sont marqués `src:"backfill"` et ne déclenchent AUCUNE alerte.
   */
  async backfill(rawDir: string | null): Promise<{ fills: number; events: number; fromRaw: boolean }> {
    let nf = 0, ne = 0, fromRaw = false;
    const actFile = rawDir ? path.join(rawDir, "activity.jsonl") : null;
    if (actFile && fs.existsSync(actFile)) {
      fromRaw = true;
      const mk = path.join(rawDir as string, "markets.jsonl");
      if (fs.existsSync(mk)) {
        const now = this.d.now();
        for (const line of fs.readFileSync(mk, "utf8").split("\n")) {
          if (!line.trim()) continue;
          try {
            const e = toMarketEntry(JSON.parse(line), this.d.toMarketMeta, now);
            if (e.meta.conditionId && !this.markets.has(e.meta.conditionId)) { this.markets.set(e.meta.conditionId, e); this.marketsDirty = true; }
          } catch { /* ligne illisible ignorée */ }
        }
      }
      const rows: RawActivity[] = [];
      for (const line of fs.readFileSync(actFile, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try { rows.push(JSON.parse(line) as RawActivity); } catch { /* ligne illisible ignorée */ }
      }
      rows.reverse(); // le fichier est du plus ancien au plus récent ; le flux (et `diff`) du plus récent au plus ancien
      const r = await this.ingest(rows, "backfill");
      nf += r.fills.length; ne += r.events.length;
      this.d.log(`backfill: ${r.fills.length} fills et ${r.events.length} événements lus dans data/raw`);
    }
    // Complément (ou totalité) par l'API.
    const start = fromRaw ? Math.max(1, this.state.cursor - this.d.cfg.RESUME_REWIND_S) : 1;
    const rows = await this.d.api.activitySince(start, 1000);
    const r = await this.ingest(rows, "backfill");
    nf += r.fills.length; ne += r.events.length;
    this.d.log(`backfill: ${r.fills.length} fills et ${r.events.length} événements lus par l'API (${rows.length} lignes parcourues)`);
    await this.refreshResolutions();
    this.recompute();
    this.state.open = openTokens(this.positions.values());
    this.state.bootstrapped_ts = this.d.now();
    this.siteDirty = true;
    return { fills: nf, events: ne, fromRaw };
  }

  // ── Réconciliation ─────────────────────────────────────────────────────────

  /**
   * Relit tout l'historique et ajoute ce qui manque au registre (`src:"reconcile"`).
   * Un fill manquant de moins de RECONCILE_ALERT_MAX_AGE_S déclenche une alerte (avec la mention de retard) ; les autres non.
   * Les lignes trop récentes (encore dans la fenêtre de la boucle) sont laissées à la boucle.
   */
  async reconcile(): Promise<ReconcileReport> {
    const all = await this.d.api.activitySince(1, 1000);
    const now = this.d.now();
    const horizon = now - Math.floor(this.d.cfg.POLL_OVERLAP_S / 2);
    const rows = all.filter((r) => r.timestamp <= horizon);
    const before = this.ledger.fills.length;
    let alerted = 0;
    const res = await this.ingest(rows, "reconcile", (f) => {
      const ok = now - f.timestamp < this.d.cfg.RECONCILE_ALERT_MAX_AGE_S;
      if (ok) alerted++;
      return ok;
    });
    const rep: ReconcileReport = {
      done_ts: this.d.now(), run_id: this.d.runId,
      api_trades: rows.filter((r) => r.type === "TRADE").length, ledger_fills: before,
      added_fills: res.fills.length, added_events: res.events.length, alerted_fills: alerted,
      phantoms: this.ledger.phantoms(rows, horizon),
    };
    this.state.last_reconcile_ts = rep.done_ts;
    this.siteDirty = true; // data.json est régénéré à chaque réconciliation
    this.d.store.writeJson(FILES.reconcileReport, rep);
    this.d.store.remove(FILES.reconcileRequest);
    this.d.log(`réconciliation: API ${rep.api_trades} trades, registre ${rep.ledger_fills} ; ajoutés ${rep.added_fills} fills / ${rep.added_events} événements ; ${rep.phantoms} ligne(s) du registre absente(s) de l'API`);
    return rep;
  }
}
