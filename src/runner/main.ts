// Point d'entrée du moniteur.
//   node src/runner/main.ts [run|backfill|replay|send-test|reconcile]     (ou variable MODE)
//
// Variables d'environnement :
//   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID   secrets (jamais journalisés ni écrits)
//   DRY_RUN=1                              n'envoie rien, écrit le texte des alertes dans le journal
//   STORE_DIR=<répertoire>                 état dans un répertoire local, sans git (essais)
//   MAX_RUN_S, POLL_SECONDS, …             toute clé de config.json peut être remplacée
//   GITHUB_TOKEN, GITHUB_REPOSITORY        lancement du run suivant (relais)

import { pathToFileURL } from "node:url";
import { runBackfill } from "./backfill.ts";
import { createRuntime } from "./env.ts";
import { dispatchSuccessor } from "./lease.ts";
import { runMonitor } from "./monitor.ts";
import { runReconcile } from "./reconcile.ts";
import { runReplay } from "./replay.ts";
import { runSendTest } from "./send-test.ts";

export async function main(argv: string[] = process.argv.slice(2), env: Record<string, string | undefined> = process.env): Promise<number> {
  const mode = (argv[0] ?? env.MODE ?? "run").trim() || "run";
  const rt = createRuntime(env);
  rt.log(`démarrage: mode ${mode}, run ${rt.runId}${rt.dryRun ? ", DRY_RUN" : ""}, magasin ${rt.store.kind}`);
  switch (mode) {
    case "run": {
      let stop = false;
      const onSignal = (): void => { stop = true; };
      process.on("SIGTERM", onSignal);
      process.on("SIGINT", onSignal);
      const { outcome } = await runMonitor({
        ...rt,
        stopRequested: () => stop,
        dispatch: () => dispatchSuccessor({ repo: env.GITHUB_REPOSITORY, token: env.GITHUB_TOKEN, ref: env.GITHUB_REF_NAME || "main", log: rt.log }),
      });
      rt.log(`fin du run: ${outcome}`);
      return outcome === "no-lease" ? 1 : 0;
    }
    case "backfill": return runBackfill(rt);
    case "reconcile": return runReconcile(rt);
    case "replay": return runReplay(rt);
    case "send-test": return runSendTest(rt);
    default:
      rt.log(`mode inconnu « ${mode} » (attendu : run, backfill, replay, send-test, reconcile)`);
      return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => { process.exitCode = code; },
    (e) => {
      // Dernier filet : une ligne sobre, sans pile ni détail pouvant contenir une URL.
      console.log(`erreur fatale: ${e instanceof Error ? e.name : "inconnue"}`);
      process.exitCode = 1;
    },
  );
}
