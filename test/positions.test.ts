import { describe, expect, it } from "vitest";
import { Ledger } from "../src/core/ledger.ts";
import { buildPositions } from "../src/core/positions.ts";
import type { MarketEntry, Position, RawActivity } from "../src/core/types.ts";
import { FIX_DIR, HAS_RAW, loadRaw, RAW_DIR, synthMarket, T0, trade } from "./helpers.ts";

function build(rows: RawActivity[], markets: Map<string, MarketEntry>): { pos: Map<string, Position>; ledger: Ledger } {
  const l = new Ledger();
  l.commit(l.diff(rows, "backfill", null, (c) => markets.get(c)));
  return { pos: new Map(buildPositions(l.fills, l.events, markets).map((p) => [p.token_id, p])), ledger: l };
}

/** Compare les positions reconstruites aux lignes /v2/positions. */
function compare(rows: RawActivity[], markets: Map<string, MarketEntry>, api: any[]) {
  const { pos } = build(rows, markets);
  let sizeBad = 0, feeBad = 0, pnlChecked = 0, pnlBad = 0, maxPnlDiff = 0, sumPnlDiff = 0, statusBad = 0, openCostBad = 0;
  for (const a of api) {
    const p = pos.get(a.token_id);
    if (!p) { sizeBad++; continue; }
    if (Math.abs(p.bought - a.total_size) > 1e-4) sizeBad++;
    if (Math.abs(p.fees - a.entry_fees_usdc) > 1e-4) feeBad++;
    if (a.status === "CLOSED") {
      const want = a.current_price === 1 ? "won" : a.current_price === 0 ? "lost" : "void";
      if (p.status !== want) statusBad++;
      pnlChecked++;
      const diff = a.realized_pnl - p.pnl;
      sumPnlDiff += diff;
      maxPnlDiff = Math.max(maxPnlDiff, Math.abs(diff));
      if (Math.abs(diff) > 1.51) pnlBad++;
    } else {
      // Ouverte : coût hors frais (l'API le sert légèrement en dessous, jusqu'à 0,68 $ — voir API_NOTES).
      if (Math.abs(p.cost - a.entry_cost_usdc) > 1.0) openCostBad++;
    }
  }
  return { n: api.length, built: pos.size, sizeBad, feeBad, statusBad, pnlChecked, pnlBad, maxPnlDiff, sumPnlDiff, openCostBad, pos };
}

describe("positions : sous-ensemble réel (test/fixtures/real)", () => {
  const { rows, markets, positions } = loadRaw(FIX_DIR);
  const r = compare(rows, markets, positions);

  it("parts et frais exacts, statuts et PnL conformes à /v2/positions", () => {
    expect(r.built).toBe(r.n);
    expect(r.sizeBad).toBe(0);
    expect(r.feeBad).toBe(0);
    expect(r.statusBad).toBe(0);
    expect(r.pnlBad).toBe(0);
  });

  it("remboursement 50-50 : statut void, payout = parts × 0,5", () => {
    const v = [...r.pos.values()].filter((p) => p.status === "void");
    expect(v.length).toBeGreaterThan(0);
    for (const p of v) { expect(p.settle).toBe(0.5); expect(p.payout).toBeCloseTo(p.held * 0.5, 6); }
  });

  it("condition achetée des deux côtés : deux positions distinctes, une gagnée, une perdue", () => {
    const byCond = new Map<string, Position[]>();
    for (const p of r.pos.values()) byCond.set(p.condition_id, [...(byCond.get(p.condition_id) ?? []), p]);
    const both = [...byCond.values()].find((a) => a.length === 2 && a.every((p) => p.status === "won" || p.status === "lost"));
    expect(both).toBeDefined();
    expect(both!.map((p) => p.status).sort()).toEqual(["lost", "won"]);
  });

  it("REDEEM sans token_id : la position est quand même résolue et datée", () => {
    const held = new Set([...r.pos.values()].map((q) => `${q.condition_id}|${q.outcome_index}`));
    const degraded = rows.find((x) => x.type === "REDEEM" && x.token_id === "" && held.has(`${x.condition_id}|${x.outcome_index}`));
    expect(degraded).toBeDefined();
    const p = [...r.pos.values()].find((q) => q.condition_id === degraded!.condition_id && q.outcome_index === degraded!.outcome_index);
    expect(p?.status === "won" || p?.status === "lost").toBe(true);
    expect(p?.resolvedTs).toBe(degraded!.timestamp);
  });

  it("sans Gamma, le REDEEM seul suffit à résoudre (prix de règlement = usdc_size / size)", () => {
    const { pos } = build(rows, new Map());
    const closed = [...pos.values()].filter((p) => p.status !== "open");
    expect(closed.length).toBeGreaterThan(5);
    for (const p of closed) expect([0, 0.5, 1]).toContain(p.settle);
  });

  it("montants : mise = Σ usdc_size, prix d'entrée hors frais, PnL = payout − mise", () => {
    for (const p of r.pos.values()) {
      expect(p.cash).toBeCloseTo(p.cost + p.fees, 6);
      expect(p.avgPrice).toBeCloseTo(p.cost / p.bought, 9);
      if (p.status !== "open") {
        expect(p.pnl).toBeCloseTo(p.payout - p.cash, 6);
        expect(p.roi).toBeCloseTo(p.pnl / p.cash, 9);
      }
    }
  });
});

describe.skipIf(!HAS_RAW)("positions : reconstruction complète contre data/raw/positions.json", () => {
  it("754 positions : parts exactes, frais exacts, PnL à ±1,5 $", () => {
    const { rows, markets, positions } = loadRaw(RAW_DIR);
    const r = compare(rows, markets, positions);
    console.log(`reconstruction: ${r.built} positions reconstruites / ${r.n} dans positions.json ; parts ≠ ${r.sizeBad} ; frais ≠ ${r.feeBad} ; `
      + `statut ≠ ${r.statusBad} ; PnL vérifié sur ${r.pnlChecked} closes, hors tolérance ${r.pnlBad}, écart max ${r.maxPnlDiff.toFixed(4)} $, somme des écarts ${r.sumPnlDiff.toFixed(2)} $ ; coût des ouvertes ≠ ${r.openCostBad}`);
    expect(r.n).toBe(754);
    expect(r.built).toBe(754);
    expect(r.sizeBad).toBe(0);
    expect(r.feeBad).toBe(0);
    expect(r.statusBad).toBe(0);
    expect(r.pnlBad).toBe(0);
    expect(r.openCostBad).toBe(0);
  });
});

describe("positions : ventes, fermetures, MERGE, SPLIT (lignes SYNTHÉTIQUES — le wallet n'en a aucune)", () => {
  const mk = new Map([["0xc0nd1", synthMarket()]]);

  it("vente partielle : PnL réalisé = produit − coût moyen (frais inclus) × parts vendues", () => {
    const rows = [
      trade({ ts: T0 + 20, side: "SELL", size: 40, price: 0.7 }),           // reçoit 28
      trade({ ts: T0 + 10, size: 100, price: 0.5, fee: 2 }),                 // paie 52
    ];
    const p = build(rows, mk).pos.get("tokA")!;
    expect(p.status).toBe("open");
    expect(p.held).toBe(60);
    expect(p.sold).toBe(40);
    expect(p.proceeds).toBeCloseTo(28, 9);
    expect(p.realized).toBeCloseTo(28 - 0.52 * 40, 9);
    expect(p.basis).toBeCloseTo(52 - 0.52 * 40, 9);
    expect(p.cash).toBeCloseTo(52, 9);
  });

  it("fermeture complète par vente : statut sold, PnL = ventes − mise", () => {
    const rows = [
      trade({ ts: T0 + 30, side: "SELL", size: 60, price: 0.4 }),
      trade({ ts: T0 + 20, side: "SELL", size: 40, price: 0.7 }),
      trade({ ts: T0 + 10, size: 100, price: 0.5, fee: 2 }),
    ];
    const p = build(rows, mk).pos.get("tokA")!;
    expect(p.status).toBe("sold");
    expect(p.held).toBe(0);
    expect(p.pnl).toBeCloseTo(28 + 24 - 52, 9);
    expect(p.roi).toBeCloseTo((28 + 24 - 52) / 52, 9);
    expect(p.resolvedTs).toBe(T0 + 30);
  });

  it("vente partielle puis résolution gagnante : PnL = payout + ventes − mise", () => {
    const rows = [trade({ ts: T0 + 20, side: "SELL", size: 40, price: 0.7 }), trade({ ts: T0 + 10, size: 100, price: 0.5, fee: 2 })];
    const won = new Map([["0xc0nd1", synthMarket("0xc0nd1", { closed: true, resolved: true, prices: [1, 0], closedTs: T0 + 9000 })]]);
    const p = build(rows, won).pos.get("tokA")!;
    expect(p.status).toBe("won");
    expect(p.payout).toBe(60);
    expect(p.pnl).toBeCloseTo(60 + 28 - 52, 9);
    expect(p.resolvedTs).toBe(T0 + 9000);
  });

  it("vente d'un preneur : usdc_size < size×price, l'écart est le frais ; le cash reçu fait foi", () => {
    const rows = [trade({ ts: T0 + 20, side: "SELL", size: 100, price: 0.6, fee: 1.2 }), trade({ ts: T0 + 10, size: 100, price: 0.5 })];
    const { pos, ledger } = build(rows, mk);
    expect(ledger.fills[1].fee).toBeCloseTo(1.2, 9);
    expect(ledger.fills[1].taker).toBe(true);
    expect(pos.get("tokA")!.pnl).toBeCloseTo(58.8 - 50, 9);
  });

  it("résolution perdante et remboursement 50-50", () => {
    const rows = [trade({ ts: T0 + 10, size: 100, price: 0.5, fee: 2 })];
    const lost = build(rows, new Map([["0xc0nd1", synthMarket("0xc0nd1", { closed: true, resolved: true, prices: [0, 1] })]])).pos.get("tokA")!;
    expect(lost.status).toBe("lost");
    expect(lost.pnl).toBeCloseTo(-52, 9);
    expect(lost.roi).toBeCloseTo(-1, 9);
    const half = build(rows, new Map([["0xc0nd1", synthMarket("0xc0nd1", { closed: true, resolved: true, prices: [0.5, 0.5] })]])).pos.get("tokA")!;
    expect(half.status).toBe("void");
    expect(half.pnl).toBeCloseTo(50 - 52, 9);
  });

  it("marché fermé mais pas encore résolu : la position reste ouverte", () => {
    const rows = [trade({ ts: T0 + 10, size: 100, price: 0.5 })];
    const p = build(rows, new Map([["0xc0nd1", synthMarket("0xc0nd1", { closed: true, resolved: false, prices: [1, 0] })]])).pos.get("tokA")!;
    expect(p.status).toBe("open");
    expect(p.roi).toBeNull();
  });

  it("MERGE : les deux jambes sont réduites, le PnL total est exact", () => {
    const rows: RawActivity[] = [
      { ...trade({ ts: T0 + 30, size: 50, price: 0 }), type: "MERGE", side: "", token_id: "", outcome_index: 999, usdc_size: 50 },
      trade({ ts: T0 + 20, size: 100, price: 0.45, token: "tokB", outcome_index: 1, outcome: "Beta" }),
      trade({ ts: T0 + 10, size: 100, price: 0.5 }),
    ];
    const { pos } = build(rows, mk);
    const a = pos.get("tokA")!, b = pos.get("tokB")!;
    expect(a.held).toBe(50);
    expect(b.held).toBe(50);
    expect(a.proceeds + b.proceeds).toBeCloseTo(50, 9);
    // 50 paires achetées 0,95 $ et fusionnées pour 1 $ : +2,50 $ au total.
    expect(a.realized + b.realized).toBeCloseTo(50 - 50 * 0.95, 9);
  });

  it("SPLIT : crée des parts des deux issues, coût réparti à parts égales", () => {
    const rows: RawActivity[] = [
      { ...trade({ ts: T0 + 10, size: 80, price: 0 }), type: "SPLIT", side: "", token_id: "", outcome_index: 999, usdc_size: 80 },
    ];
    const { pos } = build(rows, mk);
    expect(pos.get("tokA")!.held).toBe(80);
    expect(pos.get("tokB")!.held).toBe(80);
    expect(pos.get("tokA")!.cash + pos.get("tokB")!.cash).toBeCloseTo(80, 9);
    expect(pos.get("tokA")!.avgPrice).toBeCloseTo(0.5, 9);
  });

  it("CONVERSION : non interprétée, la position est signalée (aucun montant inventé)", () => {
    const rows: RawActivity[] = [
      { ...trade({ ts: T0 + 20, size: 10, price: 0 }), type: "CONVERSION", side: "", usdc_size: 0 },
      trade({ ts: T0 + 10, size: 100, price: 0.5 }),
    ];
    const p = build(rows, mk).pos.get("tokA")!;
    expect(p.warn).toMatch(/CONVERSION/);
    expect(p.held).toBe(100);
  });
});
