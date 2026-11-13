import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/core/config.ts";
import type { AlertRecord, Handover, Lease, RunnerState } from "../src/core/types.ts";
import { decideAtStart, handoverDue, leaseAlive, newLease, runExpired, successorReady } from "../src/runner/lease.ts";
import { runMonitor } from "../src/runner/monitor.ts";
import type { MonitorDeps, MonitorOutcome } from "../src/runner/monitor.ts";
import { createStore, FILES } from "../src/runner/store.ts";
import { Clock, deps, FakeApi, FakeSender, gammaMarket } from "./fakes.ts";
import { T0, trade } from "./helpers.ts";

const cfg = DEFAULT_CONFIG;
const live = (o: Partial<Lease> = {}): Lease => ({ run_id: "A", acquired_ts: T0, heartbeat_ts: T0, released: false, handover_wanted_ts: null, ...o });

describe("bail : décisions (fonctions pures)", () => {
  it("bail absent, libéré ou mort (> 120 s) → on le prend", () => {
    expect(decideAtStart(null, null, T0, "B", cfg)).toBe("acquire");
    expect(decideAtStart(live({ released: true }), null, T0 + 1, "B", cfg)).toBe("acquire");
    expect(decideAtStart(live(), null, T0 + 121, "B", cfg)).toBe("acquire");
    expect(leaseAlive(live(), T0 + 120, 120)).toBe(true);
    expect(leaseAlive(live(), T0 + 121, 120)).toBe(false);
  });
  it("bail vivant sans relais demandé (chien de garde) → arrêt immédiat", () => {
    expect(decideAtStart(live(), null, T0 + 60, "B", cfg)).toBe("exit");
  });
  it("bail vivant + relais demandé → successeur en attente ; un seul successeur", () => {
    const l = live({ handover_wanted_ts: T0 + 50 });
    expect(decideAtStart(l, null, T0 + 60, "B", cfg)).toBe("standby");
    const hB: Handover = { run_id: "B", ready_ts: T0 + 55 };
    expect(decideAtStart(l, hB, T0 + 60, "C", cfg)).toBe("exit");      // B s'est déjà annoncé
    expect(decideAtStart(l, hB, T0 + 60, "B", cfg)).toBe("standby");   // c'est moi
    expect(decideAtStart(l, { run_id: "X", ready_ts: T0 + 10 }, T0 + 60, "C", cfg)).toBe("standby"); // annonce antérieure à la demande : périmée
  });
  it("le détenteur demande le relais à MAX_RUN_S − 300 s, une seule fois, et s'arrête à MAX_RUN_S", () => {
    const l = newLease("A", T0);
    expect(handoverDue(T0, T0 + cfg.MAX_RUN_S - 301, l, cfg)).toBe(false);
    expect(handoverDue(T0, T0 + cfg.MAX_RUN_S - 300, l, cfg)).toBe(true);
    expect(handoverDue(T0, T0 + cfg.MAX_RUN_S - 100, { ...l, handover_wanted_ts: T0 + 1 }, cfg)).toBe(false);
    expect(runExpired(T0, T0 + cfg.MAX_RUN_S - 1, cfg)).toBe(false);
    expect(runExpired(T0, T0 + cfg.MAX_RUN_S, cfg)).toBe(true);
  });
  it("successeur prêt : handover.json d'un autre run, postérieur à la demande", () => {
    const l = live({ handover_wanted_ts: T0 + 50 });
    expect(successorReady(l, { run_id: "B", ready_ts: T0 + 51 })).toBe(true);
    expect(successorReady(l, { run_id: "B", ready_ts: T0 + 49 })).toBe(false);
    expect(successorReady(l, { run_id: "A", ready_ts: T0 + 60 })).toBe(false);
    expect(successorReady(l, null)).toBe(false);
    expect(successorReady(live(), { run_id: "B", ready_ts: T0 + 60 })).toBe(false);
  });
});

describe("relais de bail entre deux runs (magasin local partagé, horloge simulée)", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

  function world() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs2mon-lease-"));
    dirs.push(dir);
    const clock = new Clock(T0);
    const api = new FakeApi(clock);
    api.gamma.set("0xc0nd1", gammaMarket("0xc0nd1"));
    const sender = new FakeSender();
    const logs: string[] = [];
    const sleep = async (ms: number): Promise<void> => { clock.t += Math.max(1, Math.ceil(ms / 1000)); await new Promise<void>((r) => setImmediate(r)); };
    const mk = (runId: string, over: Partial<MonitorDeps> = {}): MonitorDeps => {
      const d = deps(createStore({ repoDir: dir, storeDir: dir }), api, sender, clock,
        { MAX_RUN_S: 600, HANDOVER_BEFORE_END_S: 300, RECONCILE_ON_START: false }, runId);
      return { ...d, log: (l) => { logs.push(`${runId}@${clock.t - T0} ${l}`); }, sleep, rawDir: null, dispatch: async () => false, stopRequested: () => false, ...over };
    };
    return { dir, clock, api, sender, logs, mk };
  }

  it("A demande un successeur, B attend puis reprend au curseur : chaque fill est notifié exactement une fois", async () => {
    const w = world();
    // Fills avant, pendant et après le relais (jetons distincts → un NOUVEAU PARI chacun).
    const tokens = ["t1", "t2", "t3", "t4", "t5", "t6"];
    const times = [30, 200, 295, 310, 330, 500];
    tokens.forEach((tok, k) => {
      w.api.gamma.set(`0xc${k}`, gammaMarket(`0xc${k}`, { tokens: [tok, `${tok}b`] }));
      w.api.rows.push(trade({ ts: T0 + times[k], size: 400, price: 0.5, token: tok, cond: `0xc${k}` }));
    });
    let bRun: Promise<{ outcome: MonitorOutcome }> | null = null;
    const a = runMonitor(w.mk("A", {
      dispatch: async () => {
        bRun = runMonitor(w.mk("B", { stopRequested: () => w.clock.t > T0 + 900 }));
        return true;
      },
    }));
    const ra = await a;
    expect(ra.outcome).toBe("released");
    expect(bRun).not.toBeNull();
    const rb = await bRun!;
    expect(rb.outcome).toBe("released");

    const store = createStore({ repoDir: w.dir, storeDir: w.dir });
    const recs = store.readJsonl<AlertRecord>(FILES.alerts);
    const seen = recs.flatMap((r) => r.fills).sort((x, y) => x - y);
    expect(seen).toEqual([0, 1, 2, 3, 4, 5]);                      // tous notifiés, aucun deux fois
    // 1 message de mise en service (premier démarrage de A, jamais répété par B) + 6 alertes.
    expect(w.sender.sent).toHaveLength(7);
    expect(w.sender.sent.filter((m) => m.plain.includes("Moniteur CS2 en service"))).toHaveLength(1);
    expect(w.sender.sent[0].plain).toContain("Moniteur CS2 en service");
    expect(recs.every((r) => r.kind === "NEW")).toBe(true);

    // Chronologie : B ne prend le bail qu'après la libération par A, et A n'attend pas MAX_RUN_S.
    const at = (needle: string): number => Number(/@(\d+)/.exec(w.logs.find((l) => l.includes(needle)) ?? "@-1")![1]);
    expect(at("A@") >= 0).toBe(true);
    const aReleased = at("successeur prêt, je libère le bail");
    const bTook = Number(/@(\d+)/.exec(w.logs.find((l) => l.startsWith("B@") && l.includes("bail: pris (run B)")) ?? "@-1")![1]);
    expect(aReleased).toBeGreaterThanOrEqual(300);
    expect(aReleased).toBeLessThan(400);
    expect(bTook).toBeGreaterThanOrEqual(aReleased);
    expect(w.logs.some((l) => l.startsWith("B@") && l.includes("je me déclare successeur"))).toBe(true);
    const st = store.readJson<RunnerState>(FILES.state)!;
    expect(st.lease).toMatchObject({ run_id: "B", released: true });
    expect(store.exists(FILES.handover)).toBe(false);
  });

  it("chien de garde : un run qui trouve un bail vivant sans relais demandé s'arrête sans rien écrire", async () => {
    const w = world();
    const store = createStore({ repoDir: w.dir, storeDir: w.dir });
    store.init();
    const state: RunnerState = { v: 1, cursor: T0, lease: live({ heartbeat_ts: T0 - 30 }), alerts: { seq: 0, pos: {}, outbox: [] }, open: [], ledger_n: 0, bootstrapped_ts: T0, last_reconcile_ts: null, last_fill_ts: 0 };
    store.writeJson(FILES.state, state);
    const before = fs.readFileSync(path.join(w.dir, FILES.state), "utf8");
    const r = await runMonitor(w.mk("W"));
    expect(r.outcome).toBe("exit-lease-alive");
    expect(fs.readFileSync(path.join(w.dir, FILES.state), "utf8")).toBe(before);
    expect(w.api.calls.activity).toBe(0);
  });

  it("bail mort (battement > 120 s) : le run suivant le reprend et rattrape les fills manqués avec la mention de retard", async () => {
    const w = world();
    const store = createStore({ repoDir: w.dir, storeDir: w.dir });
    store.init();
    const state: RunnerState = { v: 1, cursor: T0 - 2000, lease: live({ heartbeat_ts: T0 - 1900 }), alerts: { seq: 0, pos: {}, outbox: [] }, open: [], ledger_n: 0, bootstrapped_ts: T0 - 5000, last_reconcile_ts: null, last_fill_ts: 0 };
    store.writeJson(FILES.state, state);
    w.api.rows.push(trade({ ts: T0 - 1500, size: 400, price: 0.5 }));   // passé pendant la panne
    const r = await runMonitor(w.mk("C", { stopRequested: () => w.clock.t > T0 + 60 }));
    expect(r.outcome).toBe("released");
    expect(w.sender.sent).toHaveLength(1);
    expect(w.sender.sent[0].plain).toContain("⏱ Détecté en retard");
  });

  it("premier démarrage : amorçage par backfill (aucune alerte), puis boucle ; erreurs de flux absorbées", async () => {
    const w = world();
    w.api.rows.push(trade({ ts: T0 - 4000, size: 400, price: 0.5 }));   // historique
    w.api.rows.push(trade({ ts: T0 + 40, size: 400, price: 0.5, token: "tokN", cond: "0xn" }));
    w.api.gamma.set("0xn", gammaMarket("0xn", { tokens: ["tokN", "tokM"] }));
    const d = w.mk("F", { stopRequested: () => w.clock.t > T0 + 200 });
    let n = 0;
    const orig = w.api.activitySince.bind(w.api);
    w.api.activitySince = async (s: number) => { n++; if (n === 3 || n === 4) w.api.failActivity = 1; return orig(s); };
    const r = await runMonitor(d);
    expect(r.outcome).toBe("released");
    // message de mise en service (amorçage) puis le seul fill en direct ; aucune alerte pour l'historique
    expect(w.sender.sent).toHaveLength(2);
    expect(w.sender.sent[0].plain).toContain("Moniteur CS2 en service");
    expect(w.sender.sent[1].plain).toContain("NOUVEAU PARI CS2");
    expect(w.logs.filter((l) => l.includes("flux: lecture en échec"))).toHaveLength(2);
    const store = createStore({ repoDir: w.dir, storeDir: w.dir });
    expect(store.readJsonl<any>(FILES.fills).map((f) => f.src)).toEqual(["backfill", "live"]);
    expect(store.exists(FILES.data)).toBe(true);
    expect(store.exists(FILES.heartbeat)).toBe(true);
  });
});
