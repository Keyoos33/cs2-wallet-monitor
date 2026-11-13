// Envoie UN message Telegram de test, en clair, pour vérifier la configuration (jeton + chat).
//   node src/runner/send-test.ts        (ou : node src/runner/main.ts send-test)

import { pathToFileURL } from "node:url";
import { escapeHtml, frTime } from "../core/format.ts";
import { createRuntime } from "./env.ts";
import type { Runtime } from "./env.ts";

export async function runSendTest(rt: Runtime): Promise<number> {
  const when = frTime(rt.now(), rt.cfg.TZ, true);
  const plain = `✅ Test du moniteur CS2\nCe message confirme que Telegram est bien configuré.\nEnvoyé le ${when} (${rt.cfg.TZ}).`;
  const html = `<b>✅ Test du moniteur CS2</b>\n${escapeHtml(`Ce message confirme que Telegram est bien configuré.\nEnvoyé le ${when} (${rt.cfg.TZ}).`)}`;
  const res = await rt.sender.send(html, plain);
  rt.log(res.ok ? (res.dry ? "send-test: DRY_RUN, rien envoyé" : "send-test: message envoyé (Telegram ok:true)") : `send-test: ÉCHEC (${res.error ?? "inconnu"})`);
  return res.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runSendTest(createRuntime()).then((code) => { process.exitCode = code; }, () => { console.log("send-test: erreur inattendue"); process.exitCode = 1; });
}
