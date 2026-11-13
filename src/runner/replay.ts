// Rejeu TEST : repasse N fills HISTORIQUES dans la vraie chaîne d'alertes (regroupement, traduction, carnet,
// format, Telegram) pour montrer à quoi ressemblent les messages. Chaque alerte est préfixée
// « 🧪 TEST (rejeu historique) ». Rien n'est écrit : le registre et l'état réels ne sont que LUS,
// la chaîne tourne sur un magasin en mémoire avec une horloge simulée (les délais réels entre fills sont respectés
// sans attendre).
//   REPLAY_N=12 node src/runner/replay.ts      (ou : node src/runner/main.ts replay)

import { pathToFileURL } from "node:url";
import type { Config } from "../core/config.ts";
import { safeDescribe } from "../core/dashboard-data.ts";
import { buildPositions } from "../core/positions.ts";
import type { BetDescription, Fill, MarketEntry, MarketMeta, Position, RawActivity } from "../core/types.ts";
import { createRuntime } from "./env.ts";
import type { Runtime } from "./env.ts";
import { errText, freshState, Pipeline } from "./pipeline.ts";
import { MemoryStore, readFills, readMarkets } from "./store.ts";
import type { Sender } from "./telegram.ts";

/** Types de marché à montrer en priorité (clés stables du traducteur). */
export const REPLAY_TYPES = ["match_winner", "map_handicap", "total_maps", "map_winner"];

/**
 * Choisit les fills à rejouer : pour chaque type voulu, la position CS2 la plus récente dont les premiers fills
 * suffisent à produire un NOUVEAU PARI puis un RENFORT (≥ INCREASE_MIN_USD après la rafale initiale) ;
 * à défaut, la plus récente du type. `n` = nombre total de fills.
 */
export function selectReplayFills(
  positions: Position[],
  fills: Fill[],
  betOf: (p: Position) => BetDescription,
  n: number,
  cfg: Pick<Config, "NEW_SETTLE_S" | "INCREASE_MIN_USD">,
  types: string[] = REPLAY_TYPES,
): Fill[][] {
  const per = Math.max(2, Math.floor(n / types.length));
  const recent = positions.filter((p) => p.cs2 && p.nFills >= 1).sort((a, b) => b.lastTs - a.lastTs);
  const groups: Fill[][] = [];
  let left = n;
  for (const type of types) {
    if (left <= 0) break;
    const budget = Math.min(per, left);
    let fallback: Fill[] | null = null;
    let chosen: Fill[] | null = null;
    for (const p of recent) {
      if (betOf(p).marketTypeKey !== type) continue;
      const fs = p.fills.map((i) => fills[i]).filter((f): f is Fill => !!f && f.side === "BUY").slice(0, budget);
      if (fs.length === 0) continue;
      fallback ??= fs;
      let later = 0;
      for (let k = 0; k < fs.length; k++) {
        if (fs[k].timestamp > fs[0].timestamp + cfg.NEW_SETTLE_S) later += fs[k].usdc_size;
        if (later >= cfg.INCREASE_MIN_USD) { chosen = fs.slice(0, k + 1); break; }
      }
      if (chosen) break;
    }
    const g = chosen ?? fallback;
    if (g) { groups.push(g); left -= g.length; }
  }
  return groups;
}

function toRaw(f: Fill): RawActivity {
  return {
    type: "TRADE", timestamp: f.timestamp, transaction_hash: f.transaction_hash, condition_id: f.condition_id, token_id: f.token_id,
    side: f.side, outcome_index: f.outcome_index, size: f.size, price: f.price, usdc_size: f.usdc_size,
    slug: f.slug, event_slug: f.event_slug, outcome: f.outcome,
  };
}

export async function runReplay(rt: Runtime, opts: { n?: number } = {}): Promise<number> {
  const { log, cfg } = rt;
  const n = Math.max(2, Math.min(200, opts.n ?? (Number(process.env.REPLAY_N) || 12)));

  // 1. Lecture seule du registre réel (à défaut : data/raw via un backfill en mémoire).
  let fills: Fill[] = [];
  let markets = new Map<string, MarketEntry>();
  try {
    rt.store.init();
    fills = readFills(rt.store);
    markets = readMarkets(rt.store);
  } catch (e) {
    log(`rejeu: registre illisible (${errText(e)})`);
  }
  const silent: Sender = { dryRun: true, send: async () => ({ ok: true, dry: true, tries: 0 }) };
  if (fills.length === 0) {
    log("rejeu: registre vide, lecture de l'historique en mémoire");
    const tmp = new Pipeline({ ...rt, store: new MemoryStore(), sender: silent });
    try { await tmp.backfill(rt.rawDir); } catch (e) { log(`rejeu: historique indisponible (${errText(e)})`); return 1; }
    fills = tmp.ledger.fills;
    markets = tmp.markets;
  }

  // 2. Sélection.
  const describe = (meta: MarketMeta, oi: number): BetDescription => rt.describe(meta, oi);
  const positions = buildPositions(fills, [], markets);
  const betOf = (p: Position): BetDescription => {
    const e = markets.get(p.condition_id);
    return e ? safeDescribe(describe, e.meta, p.outcome_index, p.outcome) : { match: "", format: null, tournament: "", marketTypeKey: "unknown", marketTypeFr: "", betFr: "", winConditionFr: "", exact: false };
  };
  const groups = selectReplayFills(positions, fills, betOf, n, cfg);
  const chosen = groups.flat().sort((a, b) => (a.timestamp - b.timestamp) || (a.i - b.i));
  if (chosen.length === 0) { log("rejeu: aucun fill CS2 à rejouer"); return 1; }
  log(`rejeu: ${chosen.length} fills historiques sur ${groups.length} position(s) — alertes préfixées « 🧪 TEST (rejeu historique) »`);

  // 3. Chaîne réelle sur magasin en mémoire, horloge simulée, marchés vus comme « non résolus » pendant le rejeu.
  const clock = { t: chosen[0].timestamp };
  const conds = new Set(chosen.map((f) => f.condition_id));
  const sender: Sender = {
    dryRun: rt.sender.dryRun,
    async send(html, plain) {
      const r = await rt.sender.send(html, plain);
      if (!r.dry) await rt.sleep(1200); // on ménage la limite de débit de Telegram
      return r;
    },
  };
  const rp = new Pipeline({
    ...rt, store: new MemoryStore(), sender, isTest: true, now: () => clock.t,
    api: { activitySince: async () => [], markets: async () => [], book: (t) => rt.api.book(t) },
  });
  rp.state = freshState();
  rp.state.bootstrapped_ts = clock.t;
  for (const c of conds) {
    const e = markets.get(c);
    if (e) rp.markets.set(c, { ...e, resolved: false, closed: false, prices: null, closedTs: null });
  }

  const ticks: number[] = [];
  const runTicksUntil = async (limit: number): Promise<void> => {
    ticks.sort((a, b) => a - b);
    while (ticks.length > 0 && ticks[0] <= limit) {
      clock.t = Math.max(clock.t, ticks.shift() as number);
      await rp.tick();
    }
  };
  for (const f of chosen) {
    const det = f.timestamp + 4; // retard de détection simulé : 4 s
    await runTicksUntil(det);
    clock.t = Math.max(clock.t, det);
    await rp.ingest([toRaw(f)], "live");
    await rp.tick();
    ticks.push(clock.t + cfg.NEW_SETTLE_S + 1, clock.t + cfg.INCREASE_MIN_GAP_S + cfg.NEW_SETTLE_S + 2);
  }
  await runTicksUntil(Infinity);

  // 4. Résolutions réelles (si les marchés sont résolus) → alertes RÉSULTAT sur la partie rejouée.
  clock.t += 3600;
  for (const c of conds) { const e = markets.get(c); if (e) rp.markets.set(c, e); }
  rp.recompute();
  await rp.tick();
  for (let i = 0; i < 3 && rp.state.alerts.outbox.length > 0; i++) { clock.t += 400; await rp.tick(); }

  const kinds: Record<string, number> = {};
  for (const a of rp.alerts) kinds[a.kind] = (kinds[a.kind] ?? 0) + 1;
  const covered = new Set(rp.alerts.flatMap((a) => (a.kind === "RESULT" ? [] : a.fills)));
  const failed = rp.state.alerts.outbox.length;
  log(`rejeu: terminé — ${rp.alerts.length} alerte(s) TEST ${rt.sender.dryRun ? "affichée(s) (DRY_RUN)" : "envoyée(s)"} `
    + `(${Object.entries(kinds).map(([k, v]) => `${k} ${v}`).join(", ") || "aucune"}) ; `
    + `${chosen.length - covered.size} fill(s) sous les seuils, non notifié(s) seul(s) ; ${failed} envoi(s) en échec. Registre réel intact.`);
  return failed > 0 ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runReplay(createRuntime()).then((code) => { process.exitCode = code; }, () => { console.log("rejeu: erreur inattendue"); process.exitCode = 1; });
}
