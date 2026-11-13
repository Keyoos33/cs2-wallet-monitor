// Boucle du moniteur : bail, amorçage (backfill), lecture périodique du flux, résolutions, alertes,
// battement de coeur, relais vers le run suivant. Aucune erreur d'E/S ne doit arrêter la boucle.

import type { Handover, RunnerState } from "../core/types.ts";
import { decideAtStart, dispatchSuccessor, handoverDue, leaseAlive, newLease, runExpired, successorReady } from "./lease.ts";
import { errText, Pipeline } from "./pipeline.ts";
import type { PipelineDeps } from "./pipeline.ts";
import { HttpError } from "./polymarket.ts";
import { FILES, readState } from "./store.ts";

export interface MonitorDeps extends PipelineDeps {
  sleep: (ms: number) => Promise<void>;
  /** Répertoire data/raw (amorçage local) ; null en CI. */
  rawDir: string | null;
  /** Lance le run suivant ; renvoie false si impossible. */
  dispatch: () => Promise<boolean>;
  /** Demande d'arrêt (SIGTERM / SIGINT). */
  stopRequested: () => boolean;
}

export type MonitorOutcome = "exit-lease-alive" | "exit-other-successor" | "standby-timeout" | "lease-lost" | "released" | "no-lease";

export async function runMonitor(d: MonitorDeps): Promise<{ outcome: MonitorOutcome; pipeline: Pipeline | null }> {
  const { cfg, store, log, now, sleep, runId } = d;
  store.init();

  // ── 1. Bail ────────────────────────────────────────────────────────────────
  let st: RunnerState | null = readState(store);
  let decision = decideAtStart(st?.lease, store.readJson<Handover>(FILES.handover), now(), runId, cfg);
  if (decision === "exit") {
    const h = st?.lease?.handover_wanted_ts != null;
    log(h ? "bail: un successeur est déjà annoncé, arrêt" : "bail: un autre run est vivant, arrêt (chien de garde)");
    return { outcome: h ? "exit-other-successor" : "exit-lease-alive", pipeline: null };
  }
  if (decision === "standby") {
    log("bail: relais demandé par le run en cours, je me déclare successeur");
    let announced = false;
    for (let attempt = 0; attempt < 3 && !announced; attempt++) {
      store.writeJson(FILES.handover, { run_id: runId, ready_ts: now() } satisfies Handover);
      const r = store.sync(`relais: successeur ${runId} prêt`);
      if (r === "ok") announced = true;
      else { store.resetToRemote(); await sleep(2000); }
    }
    if (!announced) log("bail: annonce du successeur non poussée, j'attends quand même la fin du bail");
    const t0 = now();
    for (;;) {
      await sleep(cfg.HANDOVER_POLL_S * 1000);
      if (d.stopRequested()) return { outcome: "standby-timeout", pipeline: null };
      if (!store.fetchRemote()) continue;
      const remote = store.readRemoteJson<RunnerState>(FILES.state);
      const h = store.readRemoteJson<Handover>(FILES.handover);
      if (!leaseAlive(remote?.lease, now(), cfg.LEASE_STALE_S)) break;
      if (remote?.lease && remote.lease.run_id !== runId && remote.lease.handover_wanted_ts === null) {
        // Le bail a changé de main sans nous (un autre successeur l'a pris).
        log("bail: repris par un autre run, arrêt");
        return { outcome: "exit-other-successor", pipeline: null };
      }
      if (announced && h && h.run_id !== runId && h.ready_ts > t0) {
        log("bail: un autre successeur s'est annoncé après moi, arrêt");
        return { outcome: "exit-other-successor", pipeline: null };
      }
      if (now() - t0 > cfg.SUCCESSOR_MAX_WAIT_S) {
        log("bail: le run en cours n'a pas libéré le bail à temps, arrêt");
        return { outcome: "standby-timeout", pipeline: null };
      }
    }
    store.resetToRemote();
    st = readState(store);
    decision = "acquire";
  }

  // ── 2. Prise du bail ───────────────────────────────────────────────────────
  const p = new Pipeline(d);
  p.load();
  const started = now();
  p.state.lease = newLease(runId, started);
  store.remove(FILES.handover);
  let got = p.persist(`bail: pris par ${runId}`, true);
  for (let i = 0; i < 3 && got === "failed"; i++) { await sleep(5000); got = p.persist(`bail: pris par ${runId}`, true); }
  if (got !== "ok") {
    log(got === "conflict" ? "bail: pris simultanément par un autre run, arrêt" : "bail: impossible de pousser la prise du bail, arrêt");
    return { outcome: got === "conflict" ? "lease-lost" : "no-lease", pipeline: null };
  }
  log(`bail: pris (run ${runId}) ; registre ${p.ledger.fills.length} fills, curseur ${p.state.cursor}`);
  store.squash("data: compaction de l'historique");

  let lastSync = now();
  let lastHbFile = now();
  const beat = (msg: string, force = false): "ok" | "lost" => {
    const t = now();
    if (!force && t - lastSync < cfg.LEASE_HEARTBEAT_S) { try { p.flush(false); } catch (e) { log(`persistance: échec local (${errText(e)})`); } return "ok"; }
    const lease = p.state.lease;
    if (lease) lease.heartbeat_ts = t;
    const withHb = t - lastHbFile >= cfg.HEARTBEAT_S;
    const r = p.persist(msg, withHb);
    lastSync = t;
    if (withHb) lastHbFile = t;
    if (r === "conflict") {
      // La branche distante a divergé : soit un autre run a pris le bail (on s'arrête), soit on se recale dessus.
      store.fetchRemote();
      const remote = store.readRemoteJson<RunnerState>(FILES.state);
      if (remote?.lease && remote.lease.run_id !== runId) return "lost";
      log("persistance: recalage sur la branche distante (les lignes non poussées seront relues dans le flux)");
      if (store.resetToRemote()) { p.load(); if (p.state.lease) p.state.lease.heartbeat_ts = t; }
    }
    return "ok";
  };

  // ── 3. Amorçage ────────────────────────────────────────────────────────────
  if (p.state.bootstrapped_ts === null) {
    log("amorçage: registre vide, chargement de l'historique complet (aucune alerte)");
    for (let attempt = 1; p.state.bootstrapped_ts === null; attempt++) {
      try {
        const r = await p.backfill(d.rawDir);
        log(`amorçage: terminé (${r.fills} fills, ${r.events} événements, ${p.positions.size} positions dont ${p.state.open.length} ouvertes)`);
      } catch (e) {
        p.errors++;
        log(`amorçage: échec n° ${attempt} (${errText(e)}), nouvel essai dans 30 s`);
        if (beat("battement", true) === "lost") return { outcome: "lease-lost", pipeline: p };
        if (d.stopRequested() || runExpired(started, now(), cfg)) break;
        await sleep(30000);
      }
    }
    if (beat("amorçage: historique chargé", true) === "lost") return { outcome: "lease-lost", pipeline: p };
  }

  // ── 4. Boucle ──────────────────────────────────────────────────────────────
  let first = true;
  let failures = 0;
  let lastResolve = 0;
  let lastHandoverPoll = 0;
  let needReconcile = cfg.RECONCILE_ON_START;
  let outcome: MonitorOutcome = "released";

  for (;;) {
    const t = now();
    if (d.stopRequested()) { log("arrêt demandé"); break; }
    if (runExpired(started, t, cfg)) { log("durée maximale du run atteinte"); break; }

    // a) Lecture du flux.
    let delayS = cfg.POLL_SECONDS;
    try {
      const start = Math.max(1, p.state.cursor - (first ? cfg.RESUME_REWIND_S : cfg.POLL_OVERLAP_S));
      const rows = await d.api.activitySince(start, cfg.POLL_LIMIT);
      const res = await p.ingest(rows, "live");
      p.polls++;
      p.lastPollOkTs = now();
      failures = 0;
      if (res.fills.length + res.events.length > 0) log(`flux: ${res.fills.length} nouveau(x) fill(s), ${res.events.length} événement(s)`);
      first = false;
    } catch (e) {
      p.errors++;
      failures++;
      const transient = !(e instanceof HttpError) || e.transient;
      if (transient) delayS = Math.min(cfg.BACKOFF_MAX_S, cfg.POLL_SECONDS * 2 ** Math.min(failures, 6));
      if (e instanceof HttpError && e.retryAfterS) delayS = Math.min(cfg.BACKOFF_MAX_S, Math.max(delayS, e.retryAfterS));
      log(`flux: lecture en échec (${errText(e)}), nouvel essai dans ${delayS} s`);
    }

    // b) Réconciliation (au démarrage, puis sur demande de daily.yml).
    if (!first && (needReconcile || store.exists(FILES.reconcileRequest))) {
      try { await p.reconcile(); needReconcile = false; } catch (e) {
        p.errors++;
        needReconcile = false; // on ne boucle pas dessus : la prochaine demande (quotidienne) réessaiera
        store.remove(FILES.reconcileRequest);
        log(`réconciliation: échec (${errText(e)})`);
      }
    }

    // c) Résolutions.
    if (now() - lastResolve >= cfg.RESOLVE_POLL_S) {
      lastResolve = now();
      try { await p.refreshResolutions(); } catch (e) { p.errors++; log(`résolutions: échec (${errText(e)})`); }
    }

    // d) Alertes.
    let sent = 0;
    try { sent = await p.tick(); } catch (e) { p.errors++; log(`alertes: échec (${errText(e)})`); }

    // e) Persistance : tout de suite après un envoi, sinon au rythme du battement du bail.
    if (beat(sent > 0 ? `alertes: ${sent} envoyée(s)` : "battement", sent > 0) === "lost") {
      log("bail: perdu au profit d'un autre run, arrêt sans rien écrire");
      outcome = "lease-lost";
      return { outcome, pipeline: p };
    }

    // f) Relais.
    const lease = p.state.lease;
    if (lease && handoverDue(started, now(), lease, cfg)) {
      lease.handover_wanted_ts = now();
      beat("relais: successeur demandé", true);
      try { await d.dispatch(); } catch { log("relais: échec du lancement du successeur"); }
    }
    if (lease && lease.handover_wanted_ts !== null && now() - lastHandoverPoll >= cfg.HANDOVER_POLL_S) {
      lastHandoverPoll = now();
      let h: Handover | null = null;
      try { if (store.fetchRemote()) h = store.readRemoteJson<Handover>(FILES.handover); } catch { h = null; }
      if (successorReady(lease, h)) { log("relais: successeur prêt, je libère le bail"); break; }
    }

    await sleep(Math.max(0, delayS * 1000 - (now() - t) * 1000));
  }

  // ── 5. Libération : les agrégats en attente restent dans l'état pour le successeur ──
  if (p.state.lease) { p.state.lease.released = true; p.state.lease.heartbeat_ts = now(); }
  p.siteDirty = true;
  let rel = p.persist(`bail: libéré par ${runId}`, true);
  for (let i = 0; i < 3 && rel === "failed"; i++) { await sleep(3000); rel = p.persist(`bail: libéré par ${runId}`, true); }
  log(rel === "ok" ? "bail: libéré" : "bail: libération non poussée (il expirera de lui-même)");
  return { outcome, pipeline: p };
}
