import { describe, expect, it } from "vitest";
import type { AlertRecord, DashboardData, Fill, RunnerState } from "../src/core/types.ts";
import { Pipeline } from "../src/runner/pipeline.ts";
import { FILES, MemoryStore } from "../src/runner/store.ts";
import { Clock, deps, FakeApi, FakeSender, gammaMarket } from "./fakes.ts";
import { T0, trade } from "./helpers.ts";

function setup(over = {}) {
  const clock = new Clock(T0);
  const store = new MemoryStore();
  const api = new FakeApi(clock);
  api.gamma.set("0xc0nd1", gammaMarket("0xc0nd1"));
  const sender = new FakeSender();
  const d = deps(store, api, sender, clock, over);
  const p = new Pipeline(d);
  p.load();
  p.state.bootstrapped_ts = T0;
  return { clock, store, api, sender, d, p };
}

/** Un tour de boucle : lecture de la fenêtre, alertes, écriture. */
async function turn(p: Pipeline, api: FakeApi, clock: Clock, t: number): Promise<number> {
  clock.t = t;
  await p.ingest(await api.activitySince(Math.max(1, p.state.cursor - 600)), "live");
  const n = await p.tick();
  p.persist("test");
  return n;
}

describe("chaîne : détection → alerte → Telegram", () => {
  it("un nouveau pari est notifié une fois, avec carnet ; relire la même fenêtre ne renvoie rien", async () => {
    const { clock, store, api, sender, p } = setup();
    api.rows.push(trade({ ts: T0 + 1, size: 200, price: 0.5, fee: 2.5 }), trade({ ts: T0 + 3, size: 100, price: 0.5 }));
    expect(await turn(p, api, clock, T0 + 5)).toBe(0);
    expect(await turn(p, api, clock, T0 + 10)).toBe(0);
    expect(await turn(p, api, clock, T0 + 25)).toBe(1);
    for (let t = T0 + 30; t < T0 + 2000; t += 5) expect(await turn(p, api, clock, t)).toBe(0);
    expect(sender.sent).toHaveLength(1);
    const text = sender.sent[0].plain.replace(/ /g, " ");
    expect(text).toContain("NOUVEAU PARI CS2");
    expect(text).toContain("Mise : 153 $ (dont 2,50 $ de frais)");
    expect(text).toContain("Dispo maintenant : 0,51 (cote 1,96) × 400 parts — 204 $ jusqu'à 0,52");
    expect(text).toContain("https://polymarket.com/event/cs2-alpha-beta-2026-01-01");
    const recs = store.readJsonl<AlertRecord>(FILES.alerts);
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ fill_ts: T0 + 1, last_fill_ts: T0 + 3, detected_ts: T0 + 5, sent_ts: T0 + 25, kind: "NEW", fills: [0, 1], status: "ok", is_test: false, lat_detect_s: 4, lat_send_s: 20 });
    expect(recs[0].book?.bestAsk).toBe(0.51);
    expect(store.readJsonl<Fill>(FILES.fills)).toHaveLength(2);
  });

  it("échec Telegram : l'alerte reste en attente, n'est PAS journalisée comme envoyée, puis part une seule fois", async () => {
    const { clock, store, api, sender, p, d } = setup();
    sender.failNext = 2;
    api.rows.push(trade({ ts: T0 + 1, size: 200, price: 0.5 }));
    await turn(p, api, clock, T0 + 2);
    expect(await turn(p, api, clock, T0 + 25)).toBe(0);
    expect(store.readJsonl(FILES.alerts)).toHaveLength(0);
    expect(p.state.alerts.outbox).toHaveLength(1);
    expect(store.readJson<RunnerState>(FILES.state)?.alerts.outbox).toHaveLength(1);
    let sent = 0;
    for (let t = T0 + 30; t < T0 + 400; t += 5) sent += await turn(p, api, clock, t);
    expect(sent).toBe(1);
    expect(sender.sent).toHaveLength(1);
    expect(sender.attempts).toBe(3);            // essais espacés (pas un par tour de boucle)
    expect(store.readJsonl(FILES.alerts)).toHaveLength(1);
    expect(p.state.alerts.outbox).toHaveLength(0);
    expect(d.logs.filter((l) => l.startsWith("telegram: échec"))).toHaveLength(2);
  });

  it("panne Gamma : le fill n'est pas perdu, l'alerte part avec l'intitulé brut, puis les métadonnées se rattrapent", async () => {
    const { clock, api, sender, p, d } = setup({ MARKET_RETRY_S: 30 });
    api.failMarkets = true;
    api.rows.push(trade({ ts: T0 + 1, size: 200, price: 0.5 }));
    await turn(p, api, clock, T0 + 2);
    expect(p.ledger.fills).toHaveLength(1);
    expect(p.ledger.fills[0].phase).toBeNull();
    expect(p.markets.get("0xc0nd1")?.stub).toBe(true);
    await turn(p, api, clock, T0 + 25);
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0].plain).toContain("NOUVEAU PARI CS2");
    expect(d.logs.some((l) => l.startsWith("gamma: indisponible"))).toBe(true);
    api.failMarkets = false;
    clock.t = T0 + 200;
    await p.refreshResolutions();
    expect(p.markets.get("0xc0nd1")?.stub).toBeUndefined();
    expect(p.markets.get("0xc0nd1")?.meta.gameStartTime).toBe("2026-01-01T18:00:00.000Z");
  });

  it("carnet indisponible : l'alerte part quand même", async () => {
    const { clock, api, sender, p } = setup();
    api.failBook = true;
    api.rows.push(trade({ ts: T0 + 1, size: 200, price: 0.5 }));
    await turn(p, api, clock, T0 + 2);
    await turn(p, api, clock, T0 + 25);
    expect(sender.sent[0].plain).toContain("Dispo maintenant : carnet indisponible");
  });

  it("détection tardive (> 120 s) : mention dans le message", async () => {
    const { clock, api, sender, p } = setup();
    api.rows.push(trade({ ts: T0 + 1, size: 200, price: 0.5 }));
    await turn(p, api, clock, T0 + 500);
    await turn(p, api, clock, T0 + 525);
    expect(sender.sent[0].plain).toContain("⏱ Détecté en retard");
  });

  it("résolution : alerte RÉSULTAT unique, position close dans data.json", async () => {
    const { clock, store, api, sender, p } = setup();
    api.rows.push(trade({ ts: T0 + 1, size: 200, price: 0.5, fee: 2 }));
    await turn(p, api, clock, T0 + 2);
    await turn(p, api, clock, T0 + 25);
    api.gamma.set("0xc0nd1", gammaMarket("0xc0nd1", { closed: true, prices: ["1", "0"] }));
    clock.t = T0 + 8 * 3600;
    await p.refreshResolutions();
    expect(await turn(p, api, clock, T0 + 8 * 3600 + 5)).toBe(1);
    expect(await turn(p, api, clock, T0 + 8 * 3600 + 10)).toBe(0);
    const text = sender.sent[1].plain.replace(/ /g, " ");
    expect(text).toContain("RÉSULTAT CS2 : ✅ GAGNÉ");
    expect(text).toContain("Mise totale : 102 $ (dont 2,00 $ de frais)");
    expect(text).toContain("PnL : +98 $ (ROI +96,1 %)");
    const data = store.readJson<DashboardData>(FILES.data)!;
    expect(data.pos[0]).toMatchObject({ st: "won", cash: 102, pay: 200, pnl: 98 });
    expect(data.alerts.map((a) => a.k)).toEqual(["RESULT", "NEW"]);
    expect(data.stats).toMatchObject({ n_pos: 1, won: 1, pnl: 98, staked: 102 });
  });

  it("un REDEEM dans le flux déclenche la résolution sans attendre le prochain passage Gamma", async () => {
    const { clock, api, sender, p } = setup();
    api.rows.push(trade({ ts: T0 + 1, size: 200, price: 0.5 }));
    await turn(p, api, clock, T0 + 2);
    await turn(p, api, clock, T0 + 25);
    api.gamma.set("0xc0nd1", gammaMarket("0xc0nd1", { closed: true, prices: ["0", "1"] }));
    api.rows.push({ ...trade({ ts: T0 + 9000, size: 200, price: 0 }), type: "REDEEM", side: "", token_id: "", usdc_size: 0 });
    expect(await turn(p, api, clock, T0 + 9005)).toBe(1);
    expect(sender.sent[1].plain).toContain("❌ PERDU");
  });
});

describe("chaîne : reprise après interruption", () => {
  it("arrêt au milieu d'une rafale, état rechargé depuis le magasin : une seule alerte, aucun doublon", async () => {
    const { clock, store, api, sender, p, d } = setup();
    api.rows.push(trade({ ts: T0 + 1, size: 200, price: 0.5 }), trade({ ts: T0 + 12, size: 100, price: 0.5 }), trade({ ts: T0 + 14, size: 100, price: 0.5 }));
    await turn(p, api, clock, T0 + 5);                    // 1 fill vu, NEW en attente
    expect(sender.sent).toHaveLength(0);
    // ── arrêt brutal ; un nouveau processus recharge tout depuis le magasin ──
    const p2 = new Pipeline({ ...d, runId: "run-2" });
    p2.load();
    expect(p2.ledger.fills).toHaveLength(1);
    clock.t = T0 + 16;
    await p2.ingest(await api.activitySince(Math.max(1, p2.state.cursor - 3600)), "live"); // reprise : recul d'une heure
    expect(p2.ledger.fills).toHaveLength(3);
    let sent = 0;
    for (let t = T0 + 20; t < T0 + 1500; t += 5) sent += await turn(p2, api, clock, t);
    expect(sent).toBe(1);
    expect(sender.sent).toHaveLength(1);
    const recs = store.readJsonl<AlertRecord>(FILES.alerts);
    expect(recs).toHaveLength(1);
    expect(recs[0].fills).toEqual([0, 1, 2]);
    expect(sender.sent[0].plain.replace(/ /g, " ")).toContain("Mise : 200 $");
  });

  it("redémarrages répétés sur un flux inchangé : zéro alerte en double", async () => {
    const { clock, api, sender, p, d } = setup();
    api.rows.push(trade({ ts: T0 + 1, size: 400, price: 0.5 }));
    await turn(p, api, clock, T0 + 2);
    await turn(p, api, clock, T0 + 25);
    expect(sender.sent).toHaveLength(1);
    for (let k = 0; k < 5; k++) {
      const q = new Pipeline({ ...d, runId: `run-${k}` });
      q.load();
      clock.t += 700;
      await q.ingest(await api.activitySince(Math.max(1, q.state.cursor - 3600)), "live");
      await q.tick();
      q.persist("test");
    }
    expect(sender.sent).toHaveLength(1);
  });

  it("arrêt entre l'envoi Telegram et l'écriture de l'état : l'alerte n'est pas renvoyée", async () => {
    const { clock, store, api, sender, p, d } = setup();
    api.rows.push(trade({ ts: T0 + 1, size: 400, price: 0.5 }));
    await turn(p, api, clock, T0 + 2);
    clock.t = T0 + 25;
    await p.ingest(await api.activitySince(1), "live");
    // État tel qu'il serait sur disque si le processus mourait juste après l'envoi : alerte encore dans la file.
    const lk = { ...p.state, alerts: JSON.parse(JSON.stringify(p.state.alerts)) } as RunnerState;
    await p.tick();
    expect(sender.sent).toHaveLength(1);
    const stale = JSON.parse(JSON.stringify(lk)) as RunnerState;
    // On simule l'ancienne file : le brouillon créé à T0+25 y figure encore.
    stale.alerts.outbox = [{ ...(store.readJsonl<AlertRecord>(FILES.alerts)[0] as any), fills: [0], created_ts: T0 + 25, tries: 0, kind: "NEW", token_id: "tokA" }];
    stale.alerts.pos = {};
    store.writeJson(FILES.state, stale);
    const q = new Pipeline({ ...d, runId: "run-après-crash" });
    q.load();
    expect(q.state.alerts.outbox).toHaveLength(0);
    clock.t = T0 + 60;
    await q.tick();
    expect(sender.sent).toHaveLength(1);
  });

  it("fills au registre mais absents de l'état (arrêt entre deux écritures) : remis en file, sauf s'ils ont déjà été notifiés", async () => {
    const { clock, store, api, sender, p, d } = setup();
    api.rows.push(trade({ ts: T0 + 1, size: 400, price: 0.5 }));
    clock.t = T0 + 2;
    await p.ingest(await api.activitySince(1), "live");   // registre écrit, état PAS écrit
    expect(store.readJson(FILES.state)).toBeNull();
    const q = new Pipeline({ ...d, runId: "run-2" });
    q.load();
    expect(d.logs.some((l) => l.includes("remis dans la file"))).toBe(true);
    clock.t = T0 + 30;
    expect(await q.tick()).toBe(1);
    q.persist("test");
    // Même scénario, mais l'alerte est déjà dans alerts.jsonl : rien ne repart.
    store.remove(FILES.state);
    const r = new Pipeline({ ...d, runId: "run-3" });
    r.load();
    clock.t = T0 + 90;
    expect(await r.tick()).toBe(0);
    expect(sender.sent).toHaveLength(1);
  });
});

describe("chaîne : backfill et réconciliation", () => {
  it("backfill : tout l'historique au registre, AUCUNE alerte, positions ouvertes mémorisées", async () => {
    const { clock, api, sender, p } = setup();
    api.gamma.set("0xc0nd2", gammaMarket("0xc0nd2", { closed: true, prices: ["0", "1"], tokens: ["tokC", "tokD"] }));
    api.rows.push(trade({ ts: T0 - 5000, size: 1000, price: 0.5, cond: "0xc0nd2", token: "tokC" }), trade({ ts: T0 - 100, size: 500, price: 0.5 }));
    clock.t = T0;
    p.state.bootstrapped_ts = null;
    const r = await p.backfill(null);
    expect(r).toMatchObject({ fills: 2, fromRaw: false });
    expect(p.ledger.fills.every((f) => f.src === "backfill" && f.detected_ts === null)).toBe(true);
    expect(p.state.open).toEqual(["tokA"]);
    expect(p.state.bootstrapped_ts).toBe(T0);
    for (let t = T0; t < T0 + 3000; t += 60) { clock.t = t; await p.tick(); }
    expect(sender.sent).toHaveLength(0);
    // Un fill en direct sur la position issue du backfill est un RENFORT.
    api.rows.push(trade({ ts: T0 + 3000, size: 600, price: 0.5 }));
    await turn(p, api, clock, T0 + 3004);
    await turn(p, api, clock, T0 + 3030);
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0].plain).toContain("RENFORT DE POSITION CS2");
    expect(sender.sent[0].plain.replace(/ /g, " ")).toContain("Position totale : 550 $");
  });

  it("réconciliation : un fill manqué de moins de 24 h est ajouté (src reconcile) et notifié en retard ; un vieux est ajouté sans alerte", async () => {
    const { clock, store, api, sender, p } = setup();
    clock.t = T0 + 100000;
    api.gamma.set("0xc0nd2", gammaMarket("0xc0nd2", { tokens: ["tokC", "tokD"] }));
    const recent = trade({ ts: T0 + 100000 - 7200, size: 400, price: 0.5 });
    const old = trade({ ts: T0 + 100000 - 90000, size: 400, price: 0.5, cond: "0xc0nd2", token: "tokC" });
    const fresh = trade({ ts: T0 + 100000 - 10, size: 50, price: 0.5 }); // encore dans la fenêtre de la boucle : laissé à la boucle
    api.rows.push(recent, old, fresh);
    const rep = await p.reconcile();
    expect(rep).toMatchObject({ added_fills: 2, alerted_fills: 1, phantoms: 0, api_trades: 2 });
    expect(p.ledger.fills.map((f) => f.src)).toEqual(["reconcile", "reconcile"]);
    expect(store.readJson(FILES.reconcileReport)).toMatchObject({ added_fills: 2 });
    clock.t += 25;
    await p.tick();
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0].plain).toContain("⏱ Détecté en retard");
    // Deuxième réconciliation : rien de plus.
    const rep2 = await p.reconcile();
    expect(rep2.added_fills).toBe(0);
    clock.t += 5000;
    await p.tick();
    expect(sender.sent).toHaveLength(1);
  });
});
