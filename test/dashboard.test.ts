import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/core/config.ts";
import { buildDashboardData } from "../src/core/dashboard-data.ts";
import { Ledger } from "../src/core/ledger.ts";
import { buildPositions } from "../src/core/positions.ts";
import { bucketOf, monthOf } from "../src/core/stats.ts";
import type { AlertRecord, DashboardData, MarketEntry, RawActivity } from "../src/core/types.ts";
import { selectReplayFills } from "../src/runner/replay.ts";
import { describeBet, FIX_DIR, HAS_RAW, loadRaw, RAW_DIR, synthMarket, T0, trade } from "./helpers.ts";

function dash(rows: RawActivity[], markets: Map<string, MarketEntry>, alerts: AlertRecord[] = [], src: "backfill" | "live" = "backfill"): { d: DashboardData; ledger: Ledger } {
  const l = new Ledger();
  l.commit(l.diff(rows, src, src === "live" ? T0 + 99999 : null, (c) => markets.get(c)));
  const positions = buildPositions(l.fills, l.events, markets);
  const d = buildDashboardData({
    now: T0 + 100000, wallet: DEFAULT_CONFIG.WALLET, tz: "Europe/Zurich", initialWindowS: 60, buckets: DEFAULT_CONFIG.STAKE_BUCKETS, alertLogMax: 2,
    fills: l.fills, events: l.events, positions, markets, alerts, health: null, describe: describeBet,
  });
  return { d, ledger: l };
}

describe("données du dashboard (synthétique)", () => {
  const won = synthMarket("0xc0nd1", { closed: true, resolved: true, prices: [1, 0], closedTs: T0 + 30000 });
  const open2 = synthMarket("0xc0nd2", { tokens: ["tokC", "tokD"], type: "map_handicap", prices: [0.4, 0.6] });
  const markets = new Map([["0xc0nd1", won], ["0xc0nd2", open2]]);
  const rows: RawActivity[] = [
    { ...trade({ ts: T0 + 40000, size: 5, price: 0 }), type: "TAKER_REBATE", side: "", condition_id: "", token_id: "", outcome_index: 999, usdc_size: 5 },
    { ...trade({ ts: T0 + 39000, size: 3, price: 0 }), type: "MAKER_REBATE", side: "", condition_id: "", token_id: "", outcome_index: 999, usdc_size: 3 },
    trade({ ts: T0 + 25000, size: 200, price: 0.6, cond: "0xc0nd2", token: "tokC" }),       // LIVE (après 18:00Z), maker
    trade({ ts: T0 + 900, size: 100, price: 0.5 }),                                          // renfort maker
    trade({ ts: T0 + 30, size: 100, price: 0.4, fee: 1.2 }),                                 // dans la fenêtre initiale
    trade({ ts: T0, size: 200, price: 0.4, fee: 2.4 }),                                      // premier fill, taker
    { ...trade({ ts: T0 - 100, size: 1000, price: 0 }), type: "DEPOSIT", side: "", condition_id: "", token_id: "", outcome_index: 999, usdc_size: 1000 },
  ];
  const alert: AlertRecord = {
    id: "a1", kind: "NEW", token_id: "tokA", condition_id: "0xc0nd1", fills: [0, 1], usdc: 123.6, title: "🎯 NOUVEAU PARI CS2", text: "…", url: "https://polymarket.com/event/x",
    created_ts: T0 + 50, fill_ts: T0, last_fill_ts: T0 + 30, detected_ts: T0 + 4, sent_ts: T0 + 51, lat_detect_s: 4, lat_send_s: 21, status: "ok", tries: 1, is_test: false,
    book: { ts: T0 + 51, bestAsk: 0.41, bestAskSize: 10, limit: 0.42, usdAvail: 4.1, sharesAvail: 10 },
  };
  const { d } = dash(rows, markets, [alert, { ...alert, id: "a2", sent_ts: T0 + 60 }, { ...alert, id: "a3", sent_ts: T0 + 70, status: "dry" }]);

  it("position close : mise, frais, prix d'entrée, cote, mise initiale vs renforts, résultat, PnL, ROI", () => {
    const p = d.pos.find((x) => x.id === "tokA")!;
    expect(p).toMatchObject({
      st: "won", sh: 400, held: 400, cash: 173.6, fee: 3.6, px: 0.425, odds: 2.35, init: 123.6, add: 50, nf: 3,
      t0: T0, t1: T0 + 900, tr: T0 + 30000, set: 1, pay: 400, sold: 0, pnl: 226.4, roi: 1.3041, mk: null, ex: 1,
    });
    expect(p.tk).toBe("match_winner");
    expect(d.matches[p.m].slug).toBe("cs2-alpha-beta-2026-01-01");
  });

  it("fills d'une position : [ts, parts, prix, cash frais inclus, frais, drapeaux, tx, retard]", () => {
    const p = d.pos.find((x) => x.id === "tokA")!;
    expect(p.f).toHaveLength(3);
    const [ts, sh, px, cash, fee, flags, tx, lag] = p.f[0];
    expect([ts, sh, px, cash, fee, lag]).toEqual([T0, 200, 0.4, 82.4, 2.4, null]);
    expect(tx).toMatch(/^0xsynth/);
    expect(flags & 1).toBe(1);        // taker
    expect(flags & 2).toBe(0);        // pré-match
    expect(flags & 16).toBe(0);       // mise initiale
    expect(flags & 32).toBe(32);      // backfill
    expect(p.f[2][5] & 1).toBe(0);    // maker
    expect(p.f[2][5] & 16).toBe(16);  // renfort
  });

  it("position ouverte : pas de PnL, dernier prix connu, phase LIVE", () => {
    const p = d.pos.find((x) => x.id === "tokC")!;
    expect(p).toMatchObject({ st: "open", pnl: null, roi: null, tr: null, mk: 0.4, cash: 120 });
    expect(p.f[0][5] & 2).toBe(2);
    expect(["map_handicap", "unknown"]).toContain(p.tk); // marché synthétique : le vrai traducteur le classe « non reconnu »
  });

  it("retard de détection reporté sur les fills détectés en direct", () => {
    const live = dash([trade({ ts: T0, size: 10, price: 0.5 })], markets, [], "live").d;
    expect(live.pos[0].f[0][7]).toBe(99999);
    expect(live.pos[0].f[0][5] & 32).toBe(0);
  });

  it("stats globales : mise, PnL, ROI, taux de réussite ; rebates à part", () => {
    expect(d.stats).toMatchObject({
      n_pos: 2, n_open: 1, n_closed: 1, n_fills: 4, n_matches: 1, won: 1, lost: 0,
      staked: 293.6, staked_closed: 173.6, staked_open: 120, fees: 3.6, pnl: 226.4, roi: 1.3041, win_rate: 1,
      rebates_taker: 5, rebates_maker: 3, pnl_with_rebates: 234.4, deposits: 1000, withdrawals: 0,
    });
  });

  it("ventilations : type, PRÉ/LIVE, maker/taker (au prorata du cash), tranche, mois", () => {
    expect(d.by.type).toEqual([{ k: "match_winner", l: expect.any(String), n: 1, st: 173.6, pnl: 226.4, roi: 1.3041, w: 1, lo: 0, v: 0 }]);
    expect(d.by.phase.map((r) => r.k)).toEqual(["PRE"]);
    const taker = d.by.role.find((r) => r.k === "taker")!, maker = d.by.role.find((r) => r.k === "maker")!;
    expect(taker.st).toBeCloseTo(123.6, 2);
    expect(maker.st).toBeCloseTo(50, 2);
    expect(taker.pnl + maker.pnl).toBeCloseTo(226.4, 1);
    expect(d.by.bucket).toMatchObject([{ k: "100-500", n: 1 }]);
    expect(d.by.month).toMatchObject([{ k: "2026-01", l: "janvier 2026", n: 1 }]);
  });

  it("courbe de PnL : cumul hors rebates et rebates inclus", () => {
    expect(d.eq).toEqual([[T0 + 30000, 226.4, 226.4]]);
  });

  it("journal des alertes : plus récentes d'abord, borné, latences, statut", () => {
    expect(d.alerts.map((a) => a.id)).toEqual(["a3", "a2"]);
    expect(d.alerts[0]).toMatchObject({ tf: T0, td: T0 + 4, ts: T0 + 70, k: "NEW", tok: "tokA", n: 2, ld: 4, ls: 21, ok: 0, test: 0, ask: 0.41, avail: 4.1 });
    expect(d.alerts[1].ok).toBe(1);
  });

  it("utilitaires : tranches et mois (fuseau)", () => {
    expect(bucketOf(99.99, [100, 500]).k).toBe("lt100");
    expect(bucketOf(100, [100, 500])).toMatchObject({ k: "100-500", idx: 1 });
    expect(bucketOf(500, [100, 500]).k).toBe("ge500");
    expect(monthOf(Date.UTC(2026, 9, 31, 23, 30) / 1000, "Europe/Zurich")).toBe("2026-11");
    expect(monthOf(Date.UTC(2026, 9, 31, 23, 30) / 1000, "UTC")).toBe("2026-10");
  });
});

describe("données du dashboard (sous-ensemble réel)", () => {
  const { rows, markets } = loadRaw(FIX_DIR);
  const { d, ledger } = dash(rows, markets);

  it("cohérence : chaque fill est dans une position, chaque position dans un match, les totaux se recoupent", () => {
    expect(d.pos.reduce((s, p) => s + p.f.length, 0)).toBe(ledger.fills.length);
    expect(d.matches.flatMap((m) => m.p).sort((a, b) => a - b)).toEqual(d.pos.map((_, i) => i));
    d.pos.forEach((p, i) => expect(d.matches[p.m].p).toContain(i));
    expect(d.stats.staked).toBeCloseTo(ledger.fills.reduce((s, f) => s + f.usdc_size, 0), 1);
    expect(d.stats.n_pos).toBe(d.pos.length);
    for (const p of d.pos) {
      expect(p.init + p.add).toBeCloseTo(p.cash, 1);
      expect(p.f.reduce((s, f) => s + f[3], 0)).toBeCloseTo(p.cash, 1);
      if (p.st !== "open") expect(p.pnl).toBeCloseTo(p.pay + p.sold - p.cash, 1);
    }
    for (const k of ["type", "bucket", "month", "phase", "role"] as const) {
      expect(d.by[k].reduce((s, r) => s + r.pnl, 0)).toBeCloseTo(d.stats.pnl, 0);
      expect(d.by[k].reduce((s, r) => s + r.st, 0)).toBeCloseTo(d.stats.staked_closed, 0);
    }
    expect(d.eq[d.eq.length - 1][1]).toBeCloseTo(d.stats.pnl, 1);
    expect(d.eq[d.eq.length - 1][2]).toBeCloseTo(d.stats.pnl_with_rebates, 1);
    expect(JSON.parse(JSON.stringify(d))).toEqual(d);
  });

  it("matchs : titre, tournoi, heure de début, positions regroupées par événement", () => {
    const multi = d.matches.find((m) => m.p.length >= 2)!;
    expect(multi).toBeDefined();
    expect(new Set(multi.p.map((i) => d.pos[i].m)).size).toBe(1);
    for (const m of d.matches) { expect(m.slug.startsWith("cs2-")).toBe(true); expect(m.title).toContain("Counter-Strike"); expect(m.start).toBeGreaterThan(1.7e9); expect(m.cs2).toBe(1); }
  });

  it("rejeu : sélection de fills couvrant les types demandés, premier lot capable de produire un renfort", () => {
    const positions = buildPositions(ledger.fills, [], markets);
    const betOf = (p: (typeof positions)[number]) => describeBet(markets.get(p.condition_id)!.meta, p.outcome_index);
    const groups = selectReplayFills(positions, ledger.fills, betOf, 16, DEFAULT_CONFIG);
    expect(groups.length).toBeGreaterThanOrEqual(3);
    const types = groups.map((g) => betOf(positions.find((p) => p.token_id === g[0].token_id)!).marketTypeKey);
    expect(types.slice(0, 3)).toEqual(["match_winner", "map_handicap", "total_maps"]);
    expect(groups.flat().length).toBeLessThanOrEqual(16);
    for (const g of groups) expect(new Set(g.map((f) => f.token_id)).size).toBe(1);
  });
});

describe.skipIf(!HAS_RAW)("données du dashboard (historique complet data/raw)", () => {
  it("≈ 11 000 fills : JSON compact, totaux égaux à ceux de l'API", () => {
    const { rows, markets } = loadRaw(RAW_DIR);
    const { d } = dash(rows, markets);
    const json = JSON.stringify(d);
    console.log(`dashboard: ${d.pos.length} positions, ${d.stats.n_fills} fills, ${d.matches.length} matchs, data.json ${(json.length / 1e6).toFixed(2)} Mo ; `
      + `mise ${d.stats.staked} $, PnL ${d.stats.pnl} $, ROI ${d.stats.roi}, réussite ${d.stats.win_rate}, rebates ${d.stats.rebates_taker}+${d.stats.rebates_maker} $`);
    expect(d.stats.n_fills).toBe(11069);
    expect(d.stats.staked).toBeCloseTo(3159534.69, 1);        // MANIFEST : Σ usdc_size des TRADE
    expect(d.stats.fees).toBeCloseTo(63189.69, 1);            // MANIFEST : frais taker
    expect(d.stats.rebates_taker).toBeCloseTo(13596.67, 2);
    expect(d.stats.rebates_maker).toBeCloseTo(759.65, 2);
    expect(Math.abs(d.stats.pnl - 584225.7)).toBeLessThan(60); // user-stats.realized_pnl, à l'écart documenté (44 $) près
    expect(json.length).toBeLessThan(2.5e6);
  });
});
