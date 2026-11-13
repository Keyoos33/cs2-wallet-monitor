// Réconciliation quotidienne (daily.yml) : relit tout l'historique, le compare au registre, ajoute ce qui manque
// (`src:"reconcile"`, alerte avec mention de retard seulement si le fill a moins de 24 h) et régénère site/data.json.
//
// Un seul écrivain à la fois sur la branche `data` : si un moniteur détient le bail, ce job lui DEMANDE la
// réconciliation (state/reconcile-request.json) et attend son compte rendu (state/reconcile.json) ;
// si aucun moniteur ne tourne, il prend le bail, la fait lui-même, puis le libère.
// Code de sortie 1 si le moniteur ne répond pas : le run rouge sert de signal.

import { pathToFileURL } from "node:url";
import { pendingCount } from "../core/alerts.ts";
import { createRuntime } from "./env.ts";
import type { Runtime } from "./env.ts";
import { leaseAlive, newLease } from "./lease.ts";
import { errText, Pipeline } from "./pipeline.ts";
import type { ReconcileReport } from "./pipeline.ts";
import { FILES, readState } from "./store.ts";

export async function runReconcile(rt: Runtime): Promise<number> {
  const { store, cfg, log, now, sleep } = rt;
  store.init();
  const st = readState(store);

  if (leaseAlive(st?.lease, now(), cfg.LEASE_STALE_S)) {
    const reqTs = Math.floor(now());
    let pushed = false;
    for (let attempt = 0; attempt < 3 && !pushed; attempt++) {
      store.writeJson(FILES.reconcileRequest, { ts: reqTs, run_id: rt.runId });
      if (store.sync(`réconciliation: demande de ${rt.runId}`) === "ok") pushed = true;
      else { store.resetToRemote(); await sleep(3000); }
    }
    if (!pushed) { log("réconciliation: demande non poussée"); return 1; }
    log("réconciliation: demandée au moniteur en cours, attente du compte rendu");
    const t0 = now();
    while (now() - t0 < cfg.RECONCILE_WAIT_S) {
      await sleep(15000);
      if (!store.fetchRemote()) continue;
      const rep = store.readRemoteJson<ReconcileReport>(FILES.reconcileReport);
      if (rep && rep.done_ts >= reqTs) {
        log(`réconciliation: faite par ${rep.run_id} — API ${rep.api_trades} trades, registre ${rep.ledger_fills} ; ajoutés ${rep.added_fills} fills / ${rep.added_events} événements ; alertés ${rep.alerted_fills} ; fantômes ${rep.phantoms}`);
        return 0;
      }
    }
    log("réconciliation: le moniteur n'a pas répondu dans le délai (est-il bloqué ?)");
    return 1;
  }

  log("réconciliation: aucun moniteur actif, exécution directe");
  const p = new Pipeline(rt);
  p.load();
  p.state.lease = newLease(rt.runId, now());
  if (p.persist(`bail: pris par ${rt.runId} (réconciliation)`, true) !== "ok") { log("réconciliation: bail non obtenu, abandon"); return 1; }
  let code = 0;
  try {
    if (p.state.bootstrapped_ts === null) await p.backfill(rt.rawDir);
    await p.reconcile();
    // On laisse aux alertes le temps de se regrouper et de partir (NEW : 20 s).
    const t0 = now();
    do {
      await p.tick();
      if (p.state.lease) p.state.lease.heartbeat_ts = now();
      if (p.state.alerts.outbox.length === 0 && pendingCount(p.state.alerts) === 0) break;
      await sleep(5000);
    } while (now() - t0 < cfg.NEW_SETTLE_S + 40);
  } catch (e) {
    log(`réconciliation: échec (${errText(e)})`);
    code = 1;
  }
  if (p.state.lease) { p.state.lease.released = true; p.state.lease.heartbeat_ts = now(); }
  p.siteDirty = true;
  if (p.persist("réconciliation: terminée", true) !== "ok") { log("réconciliation: résultat non poussé"); code = 1; }
  return code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runReconcile(createRuntime()).then((code) => { process.exitCode = code; }, () => { console.log("réconciliation: erreur inattendue"); process.exitCode = 1; });
}
