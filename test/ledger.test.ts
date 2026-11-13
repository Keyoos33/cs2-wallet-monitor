import { describe, expect, it } from "vitest";
import { fillKey, Ledger, phaseOf, toFill } from "../src/core/ledger.ts";
import type { RawActivity } from "../src/core/types.ts";
import { FIX_DIR, loadRaw, synthMarket, T0, trade } from "./helpers.ts";

const noMarket = (): undefined => undefined;

function ingest(l: Ledger, rows: RawActivity[], src: "live" | "backfill" = "live") {
  const res = l.diff(rows, src, src === "live" ? T0 + 100 : null, noMarket);
  l.commit(res);
  return res;
}

describe("registre : déduplication par multiensemble", () => {
  it("rejouer deux fois la même fenêtre ne produit aucune nouvelle ligne", () => {
    const l = new Ledger();
    const window = [trade({ ts: T0 + 3, size: 10, price: 0.5 }), trade({ ts: T0 + 2, size: 20, price: 0.4 }), trade({ ts: T0 + 1, size: 5, price: 0.6 })];
    expect(ingest(l, window).fills).toHaveLength(3);
    expect(ingest(l, window).fills).toHaveLength(0);
    expect(ingest(l, [...window].reverse()).fills).toHaveLength(0);
    expect(l.fills).toHaveLength(3);
  });

  it("deux lignes strictement identiques sont deux fills, et ne sont jamais recomptées", () => {
    const l = new Ledger();
    const a = trade({ ts: T0, size: 100, price: 0.66, transaction_hash: "0xsynthsame" });
    const twin = { ...a };
    expect(ingest(l, [a, twin]).fills).toHaveLength(2);
    expect(ingest(l, [a, twin]).fills).toHaveLength(0);
    // Une troisième occurrence apparaît plus tard dans la même fenêtre : une seule nouvelle ligne.
    const r = ingest(l, [a, twin, { ...a }]);
    expect(r.fills).toHaveLength(1);
    expect(l.countOf(fillKey(a))).toBe(3);
    expect(l.fills.map((f) => f.i)).toEqual([0, 1, 2]);
  });

  it("une fenêtre qui ne contient qu'une des deux occurrences connues ne crée rien", () => {
    const l = new Ledger();
    const a = trade({ ts: T0, size: 100, price: 0.66, transaction_hash: "0xsynthsame2" });
    ingest(l, [a, { ...a }]);
    expect(ingest(l, [a]).fills).toHaveLength(0);
  });

  it("fills multiples d'une même transaction (prix ou tailles différents) : tous conservés", () => {
    const l = new Ledger();
    const tx = "0xsynthmulti";
    const rows = [
      trade({ ts: T0, size: 494.2, price: 0.66, transaction_hash: tx }),
      trade({ ts: T0, size: 300, price: 0.66, transaction_hash: tx }),
      trade({ ts: T0, size: 491.81, price: 0.65, transaction_hash: tx }),
    ];
    const r = ingest(l, rows);
    expect(r.fills).toHaveLength(3);
    // Ordre chronologique = ordre du flux inversé (le flux sert le plus récent d'abord).
    expect(r.fills.map((f) => f.size)).toEqual([491.81, 300, 494.2]);
    expect(ingest(l, rows).fills).toHaveLength(0);
  });

  it("données réelles : la transaction à 3 lignes du wallet donne 3 fills, et une relecture n'ajoute rien", () => {
    const { rows } = loadRaw(FIX_DIR);
    const l = new Ledger();
    const r = ingest(l, rows, "backfill");
    const trades = rows.filter((x) => x.type === "TRADE");
    expect(r.fills).toHaveLength(trades.length);
    expect(r.events).toHaveLength(rows.length - trades.length);
    const byTx = new Map<string, number>();
    for (const f of r.fills) byTx.set(f.transaction_hash, (byTx.get(f.transaction_hash) ?? 0) + 1);
    expect(Math.max(...byTx.values())).toBe(3);
    const again = ingest(l, rows, "backfill");
    expect(again.fills).toHaveLength(0);
    expect(again.events).toHaveLength(0);
    // Horodatages croissants dans le registre.
    for (let i = 1; i < l.fills.length; i++) expect(l.fills[i].timestamp).toBeGreaterThanOrEqual(l.fills[i - 1].timestamp);
    expect(l.phantoms(rows, Infinity)).toBe(0);
  });

  it("`diff` ne modifie pas le registre tant que `commit` n'est pas appelé", () => {
    const l = new Ledger();
    const rows = [trade({ ts: T0, size: 1, price: 0.5 })];
    expect(l.diff(rows, "live", T0, noMarket).fills).toHaveLength(1);
    expect(l.diff(rows, "live", T0, noMarket).fills).toHaveLength(1);
    expect(l.fills).toHaveLength(0);
  });

  it("lignes fantômes : une ligne du registre absente de l'API est comptée", () => {
    const l = new Ledger();
    const a = trade({ ts: T0, size: 1, price: 0.5 }), b = trade({ ts: T0 + 1, size: 2, price: 0.5 });
    ingest(l, [b, a]);
    expect(l.phantoms([a], Infinity)).toBe(1);
    expect(l.phantoms([a], T0)).toBe(0);
  });
});

describe("registre : champs dérivés", () => {
  it("taker si usdc_size > size×price ; frais = différence ; maker sinon", () => {
    const tk = toFill(trade({ ts: T0, size: 305, price: 0.4, fee: 3.66 }), 0, "live", T0 + 4, undefined);
    expect(tk.taker).toBe(true);
    expect(tk.fee).toBeCloseTo(3.66, 6);
    expect(tk.usdc_size).toBeCloseTo(125.66, 6);
    expect(tk.lag_s).toBe(4);
    const mk = toFill(trade({ ts: T0, size: 300, price: 0.66 }), 1, "live", T0, undefined);
    expect(mk.taker).toBe(false);
    expect(mk.fee).toBe(0);
  });

  it("fill de backfill : pas d'heure de détection ni de retard", () => {
    const f = toFill(trade({ ts: T0, size: 1, price: 0.5 }), 0, "backfill", null, undefined);
    expect(f.detected_ts).toBeNull();
    expect(f.lag_s).toBeNull();
    expect(f.src).toBe("backfill");
  });

  it("PRÉ/LIVE d'après l'heure PRÉVUE du match ; inconnu sans métadonnées", () => {
    const m = synthMarket(); // début 18:00Z
    expect(phaseOf(T0, m)).toBe("PRE");
    expect(phaseOf(T0 + 7 * 3600, m)).toBe("LIVE");
    expect(phaseOf(T0, undefined)).toBeNull();
  });

  it("filtre CS2 : série counter-strike ou slug d'événement cs2-", () => {
    expect(toFill(trade({ ts: T0, size: 1, price: 0.5 }), 0, "live", T0, undefined).cs2).toBe(true);
    expect(toFill(trade({ ts: T0, size: 1, price: 0.5, event_slug: "nba-lal-bos" }), 0, "live", T0, undefined).cs2).toBe(false);
    expect(toFill(trade({ ts: T0, size: 1, price: 0.5, event_slug: "x" }), 0, "live", T0, synthMarket()).cs2).toBe(true);
  });
});
