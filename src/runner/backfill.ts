// Backfill manuel : (ré)initialise le registre avec tout l'historique, sans aucune alerte.
// Le premier run du moniteur le fait tout seul ; ce point d'entrée sert à le relancer à la main.
// Idempotent (dédup par multiensemble) : relancé sur un registre existant, il n'ajoute que ce qui manque.
//   node src/runner/backfill.ts         (ou : node src/runner/main.ts backfill)

import { pathToFileURL } from "node:url";
import { createRuntime } from "./env.ts";
import type { Runtime } from "./env.ts";
import { leaseAlive, newLease } from "./lease.ts";
import { errText, Pipeline } from "./pipeline.ts";
import { readState } from "./store.ts";

export async function runBackfill(rt: Runtime): Promise<number> {
  rt.store.init();
  const st = readState(rt.store);
  if (leaseAlive(st?.lease, rt.now(), rt.cfg.LEASE_STALE_S)) {
    rt.log("backfill: un moniteur détient le bail ; il gère lui-même le registre (utiliser le mode reconcile)");
    return 0;
  }
  const p = new Pipeline(rt);
  p.load();
  p.state.lease = newLease(rt.runId, rt.now());
  if (p.persist(`bail: pris par ${rt.runId} (backfill)`, true) !== "ok") { rt.log("backfill: bail non obtenu, abandon"); return 1; }
  let code = 0;
  try {
    const r = await p.backfill(rt.rawDir);
    rt.log(`backfill: ${r.fills} fills et ${r.events} événements ajoutés ; registre ${p.ledger.fills.length} fills, ${p.positions.size} positions`);
  } catch (e) {
    rt.log(`backfill: échec (${errText(e)})`);
    code = 1;
  }
  if (p.state.lease) p.state.lease.released = true;
  p.siteDirty = true;
  if (p.persist("backfill: terminé", true) !== "ok") { rt.log("backfill: résultat non poussé"); code = 1; }
  return code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runBackfill(createRuntime()).then((code) => { process.exitCode = code; }, () => { console.log("backfill: erreur inattendue"); process.exitCode = 1; });
}
