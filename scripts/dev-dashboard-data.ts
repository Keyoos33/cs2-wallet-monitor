// Outil de développement du dashboard : construit un data.json conforme au schéma DashboardData
// à partir de data/raw/*.jsonl (historique réel, non versionné), avec les fonctions pures de src/core.
//
//   node scripts/dev-dashboard-data.ts <sortie.json> [--fake-alerts] [--heartbeat <heartbeat.json>]
//
// --fake-alerts : ajoute quelques alertes SYNTHÉTIQUES (is_test = true, libellées TEST dans la page) pour
//                 tester la vue Alertes ; elles ne correspondent à aucun envoi réel.
// --heartbeat   : écrit aussi un heartbeat.json factice (horodaté maintenant) pour tester le badge de santé.
// Ne jamais écrire dans site/data.json : ce fichier appartient au moniteur (branche `data`).

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_CONFIG } from "../src/core/config.ts";
import { buildDashboardData } from "../src/core/dashboard-data.ts";
import { toMarketMeta } from "../src/core/gamma.ts";
import { Ledger } from "../src/core/ledger.ts";
import { toMarketEntry } from "../src/core/market-entry.ts";
import { buildPositions } from "../src/core/positions.ts";
import { describeBet } from "../src/core/translate.ts";
import type { AlertKind, AlertRecord, Heartbeat, MarketEntry, RawActivity } from "../src/core/types.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RAW = path.join(ROOT, "data", "raw");
const args = process.argv.slice(2);
const out = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--heartbeat");
if (!out) { console.error("usage: node scripts/dev-dashboard-data.ts <sortie.json> [--fake-alerts] [--heartbeat <fichier>]"); process.exit(2); }
if (path.resolve(out) === path.join(ROOT, "site", "data.json")) { console.error("refus : site/data.json appartient au moniteur"); process.exit(2); }

const readJsonl = <T>(f: string): T[] => fs.readFileSync(f, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as T);
const cfg = { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8")) };
const now = Math.floor(Date.now() / 1000);

const markets = new Map<string, MarketEntry>();
for (const m of readJsonl<any>(path.join(RAW, "markets.jsonl"))) {
  const e = toMarketEntry(m, toMarketMeta, now);
  markets.set(e.meta.conditionId, e);
}
// Flux brut : plus ancien d'abord dans le fichier ; Ledger.diff attend l'ordre de l'API (plus récent d'abord).
const rows = readJsonl<RawActivity>(path.join(RAW, "activity.jsonl")).reverse();
const ledger = new Ledger();
ledger.commit(ledger.diff(rows, "backfill", null, (c) => markets.get(c)));
const positions = buildPositions(ledger.fills, ledger.events, markets);

const hb: Heartbeat = {
  ts: now, run_id: "dev-local", started_ts: now - 3600, last_poll_ok_ts: now - 3,
  last_fill_ts: ledger.fills.at(-1)?.timestamp ?? 0, polls: 1200, errors: 2, outbox: 0, pending: 0,
};

const alerts: AlertRecord[] = [];
if (args.includes("--fake-alerts")) {
  const kinds: AlertKind[] = ["NEW", "INCREASE", "RESULT", "NEW", "INCREASE", "REDUCE", "CLOSE"];
  const recent = [...positions].sort((a, b) => b.lastTs - a.lastTs).slice(0, kinds.length);
  recent.forEach((p, n) => {
    const k = kinds[n];
    const f0 = ledger.fills[p.fills[0]];
    alerts.push({
      id: `a${n + 1}`, kind: k, token_id: p.token_id, condition_id: p.condition_id, fills: p.fills.slice(0, 3),
      usdc: Math.round(p.cash * 100) / 100, title: `[SYNTHÉTIQUE] ${k}`,
      text: `Alerte synthétique de développement (${k}) pour ${p.outcome} — ${p.event_slug}`,
      url: `https://polymarket.com/event/${p.event_slug}`, created_ts: f0.timestamp + 25, fill_ts: f0.timestamp,
      last_fill_ts: p.lastTs, detected_ts: f0.timestamp + 4, sent_ts: f0.timestamp + 26, lat_detect_s: 4, lat_send_s: 22,
      status: n % 3 === 2 ? "dry" : "ok", tries: 1, is_test: true,
      book: k === "NEW" || k === "INCREASE" ? { ts: f0.timestamp + 26, bestAsk: Math.min(0.99, f0.price + 0.01), bestAskSize: 500, limit: f0.price + 0.02, usdAvail: 812.5, sharesAvail: 1500 } : null,
    });
  });
  alerts.sort((a, b) => a.sent_ts - b.sent_ts);
}

const t = performance.now();
const data = buildDashboardData({
  now, wallet: cfg.WALLET, tz: cfg.TZ, initialWindowS: cfg.INITIAL_WINDOW_S, buckets: cfg.STAKE_BUCKETS, alertLogMax: cfg.ALERT_LOG_MAX,
  fills: ledger.fills, events: ledger.events, positions, markets, alerts, health: hb, describe: describeBet,
});
const json = JSON.stringify(data);
fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
fs.writeFileSync(out, json);
const hbIdx = args.indexOf("--heartbeat");
if (hbIdx >= 0 && args[hbIdx + 1]) fs.writeFileSync(args[hbIdx + 1], JSON.stringify(hb));
console.log(`data.json : ${data.pos.length} positions, ${data.stats.n_fills} fills, ${data.matches.length} matchs, ${data.alerts.length} alertes, `
  + `${(json.length / 1e6).toFixed(2)} Mo, construit en ${Math.round(performance.now() - t)} ms → ${out}`);
