import { describe, expect, it } from "vitest";
import { bookSnapshot, dueAlerts, emptyAlertState, ingestFill, markSent, pendingCount, resultAlerts, openTokens } from "../src/core/alerts.ts";
import { DEFAULT_CONFIG } from "../src/core/config.ts";
import { Ledger } from "../src/core/ledger.ts";
import { buildPositions } from "../src/core/positions.ts";
import type { AlertDraft, AlertState, FillSource, MarketEntry, Position, RawActivity } from "../src/core/types.ts";
import { synthMarket, T0, trade } from "./helpers.ts";

const cfg = DEFAULT_CONFIG;

/** Petit banc d'essai : registre + positions + machine d'alertes, horloge explicite. */
class Bench {
  ledger = new Ledger();
  markets = new Map<string, MarketEntry>([["0xc0nd1", synthMarket()]]);
  st: AlertState = emptyAlertState();
  positions = new Map<string, Position>();
  open: string[] = [];
  all: AlertDraft[] = [];

  feed(rows: RawActivity[], now: number, src: FillSource = "live"): void {
    const before = new Map<string, { nFills: number; cash: number }>();
    for (const f of this.ledger.fills) {
      const a = before.get(f.token_id) ?? { nFills: 0, cash: 0 };
      a.nFills++; if (f.side === "BUY") a.cash += f.usdc_size;
      before.set(f.token_id, a);
    }
    const res = this.ledger.diff(rows, src, src === "backfill" ? null : now, (c) => this.markets.get(c));
    this.ledger.commit(res);
    for (const f of res.fills) {
      const a = before.get(f.token_id) ?? { nFills: 0, cash: 0 };
      ingestFill(this.st, f, a, now);
      before.set(f.token_id, { nFills: a.nFills + 1, cash: a.cash + (f.side === "BUY" ? f.usdc_size : 0) });
    }
    this.recompute();
  }
  recompute(): void {
    this.positions = new Map(buildPositions(this.ledger.fills, this.ledger.events, this.markets).map((p) => [p.token_id, p]));
  }
  tick(now: number): AlertDraft[] {
    const lk = { fill: (i: number) => this.ledger.fills[i], position: (t: string) => this.positions.get(t) };
    const out = [...dueAlerts(this.st, now, cfg, lk), ...resultAlerts(this.st, this.open, this.positions, now)];
    this.open = openTokens(this.positions.values());
    for (const d of out) markSent(this.st, d.id);
    this.all.push(...out);
    return out;
  }
  /** État sérialisé puis rechargé, comme après un redémarrage. */
  reload(): void { this.st = JSON.parse(JSON.stringify(this.st)) as AlertState; }
}

describe("alertes : NEW", () => {
  it("attend NEW_SETTLE_S puis envoie UNE alerte pour toute la rafale", () => {
    const b = new Bench();
    b.feed([trade({ ts: T0, size: 100, price: 0.5, fee: 1 })], T0 + 3);
    expect(b.tick(T0 + 3)).toHaveLength(0);
    b.feed([trade({ ts: T0 + 8, size: 200, price: 0.5 })], T0 + 10);
    expect(b.tick(T0 + 22)).toHaveLength(0); // 19 s après la première détection
    const out = b.tick(T0 + 23);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("NEW");
    expect(out[0].fills).toEqual([0, 1]);
    expect(out[0].usdc).toBeCloseTo(51 + 100, 9);
    expect(out[0].fees).toBeCloseTo(1, 9);
    expect(out[0].avgPrice).toBeCloseTo(0.5, 9);
    expect(out[0].takerCount).toBe(1);
    expect(out[0].makerCount).toBe(1);
    expect(out[0].posCash).toBeCloseTo(151, 9);
    expect(b.tick(T0 + 500)).toHaveLength(0);
  });

  it("un fill de backfill ne déclenche jamais d'alerte, et la position devient « connue »", () => {
    const b = new Bench();
    b.feed([trade({ ts: T0, size: 1000, price: 0.5 })], T0, "backfill");
    expect(pendingCount(b.st)).toBe(0);
    expect(b.tick(T0 + 9999)).toHaveLength(0);
    // Le fill suivant, en direct, est un RENFORT (pas un NOUVEAU PARI).
    b.feed([trade({ ts: T0 + 100, size: 600, price: 0.5 })], T0 + 104);
    const out = b.tick(T0 + 130);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("INCREASE");
    expect(out[0].usdc).toBeCloseTo(300, 9);
    expect(out[0].posCash).toBeCloseTo(800, 9);
  });

  it("un fill non-CS2 va au registre mais ne déclenche rien", () => {
    const b = new Bench();
    b.feed([trade({ ts: T0, size: 1000, price: 0.5, event_slug: "nba-x", cond: "0xother", token: "tokZ" })], T0);
    expect(b.ledger.fills).toHaveLength(1);
    expect(b.tick(T0 + 100)).toHaveLength(0);
  });
});

describe("alertes : INCREASE (seuils)", () => {
  function opened(): Bench {
    const b = new Bench();
    b.feed([trade({ ts: T0, size: 2000, price: 0.5 })], T0); // 1000 $
    expect(b.tick(T0 + 20)).toHaveLength(1);
    return b;
  }

  it("sous INCREASE_MIN_USD : rien, mais le fill reste en attente", () => {
    const b = opened();
    b.feed([trade({ ts: T0 + 700, size: 100, price: 0.5 })], T0 + 700); // 50 $
    expect(b.tick(T0 + 5000)).toHaveLength(0);
    expect(pendingCount(b.st)).toBe(1);
  });

  it("≥ 100 $ mais < 600 s depuis la dernière alerte : attend le délai, puis part", () => {
    const b = opened();
    b.feed([trade({ ts: T0 + 60, size: 300, price: 0.5 })], T0 + 60); // 150 $ (15 % de la position)
    expect(b.tick(T0 + 100)).toHaveLength(0);
    expect(b.tick(T0 + 619)).toHaveLength(0);
    const out = b.tick(T0 + 620);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("INCREASE");
    expect(out[0].usdc).toBeCloseTo(150, 9);
    expect(out[0].posCash).toBeCloseTo(1150, 9);
  });

  it("gros renfort (≥ 50 % de la position) : part après 20 s de calme, sans attendre 600 s", () => {
    const b = opened();
    b.feed([trade({ ts: T0 + 60, size: 600, price: 0.5 })], T0 + 60);  // 300 $
    b.feed([trade({ ts: T0 + 70, size: 600, price: 0.5 })], T0 + 70);  // 600 $ cumulés = 60 %
    expect(b.tick(T0 + 89)).toHaveLength(0);  // 19 s de calme
    const out = b.tick(T0 + 90);
    expect(out).toHaveLength(1);
    expect(out[0].fills).toHaveLength(2);
    expect(out[0].usdc).toBeCloseTo(600, 9);
  });

  it("ce qui est sous les seuils est inclus dans l'alerte suivante : le total reste exact", () => {
    const b = opened();
    b.feed([trade({ ts: T0 + 700, size: 100, price: 0.5 })], T0 + 700);   // 50 $ : en attente
    b.feed([trade({ ts: T0 + 900, size: 120, price: 0.5 })], T0 + 900);   // 60 $ → cumul 110 $
    const out = b.tick(T0 + 921);
    expect(out).toHaveLength(1);
    expect(out[0].fills).toHaveLength(2);
    expect(out[0].usdc).toBeCloseTo(110, 9);
    expect(out[0].posCash).toBeCloseTo(1110, 9);
    expect(pendingCount(b.st)).toBe(0);
  });
});

describe("alertes : ventes (synthétiques) et résultat", () => {
  it("vente partielle → REDUCE après 20 s, sans seuil ; vente totale → CLOSE", () => {
    const b = new Bench();
    b.feed([trade({ ts: T0, size: 100, price: 0.5 })], T0);
    b.tick(T0 + 20);
    b.feed([trade({ ts: T0 + 100, side: "SELL", size: 10, price: 0.6 })], T0 + 100); // 6 $
    expect(b.tick(T0 + 119)).toHaveLength(0);
    const red = b.tick(T0 + 120);
    expect(red).toHaveLength(1);
    expect(red[0].kind).toBe("REDUCE");
    expect(red[0].realizedPnl).toBeCloseTo(6 - 5, 9);
    b.feed([trade({ ts: T0 + 200, side: "SELL", size: 90, price: 0.4 })], T0 + 200);
    const cl = b.tick(T0 + 220);
    expect(cl).toHaveLength(1);
    expect(cl[0].kind).toBe("CLOSE");
    expect(cl[0].posShares).toBe(0);
  });

  it("résolution → UNE alerte RESULT (gagné), avec mise, payout, PnL, ROI", () => {
    const b = new Bench();
    b.feed([trade({ ts: T0, size: 100, price: 0.5, fee: 2 })], T0);
    b.tick(T0 + 20);
    b.markets.set("0xc0nd1", synthMarket("0xc0nd1", { closed: true, resolved: true, prices: [1, 0], closedTs: T0 + 9000 }));
    b.recompute();
    const out = b.tick(T0 + 9100);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("RESULT");
    expect(out[0].result).toEqual({ status: "won", payout: 100, pnl: 48, roi: 48 / 52, settle: 1 });
    expect(out[0].usdc).toBeCloseTo(52, 9);
    expect(b.tick(T0 + 9200)).toHaveLength(0);
    expect(b.tick(T0 + 99999)).toHaveLength(0);
  });

  it("position déjà close au backfill : jamais d'alerte RESULT", () => {
    const b = new Bench();
    b.markets.set("0xc0nd1", synthMarket("0xc0nd1", { closed: true, resolved: true, prices: [0, 1] }));
    b.feed([trade({ ts: T0, size: 100, price: 0.5 })], T0, "backfill");
    b.open = openTokens(b.positions.values());
    expect(b.tick(T0 + 100)).toHaveLength(0);
  });

  it("position ouverte au backfill puis résolue en direct : alerte RESULT", () => {
    const b = new Bench();
    b.feed([trade({ ts: T0, size: 100, price: 0.5 })], T0, "backfill");
    b.open = openTokens(b.positions.values());
    b.markets.set("0xc0nd1", synthMarket("0xc0nd1", { closed: true, resolved: true, prices: [0, 1] }));
    b.recompute();
    const out = b.tick(T0 + 100);
    expect(out.map((d) => d.kind)).toEqual(["RESULT"]);
    expect(out[0].result?.status).toBe("lost");
    expect(out[0].result?.pnl).toBeCloseTo(-50, 9);
  });

  it("les fills encore en attente à la résolution sont rattachés au RESULT (jamais perdus, jamais doublés)", () => {
    const b = new Bench();
    b.feed([trade({ ts: T0, size: 2000, price: 0.5 })], T0);
    b.tick(T0 + 20);
    b.feed([trade({ ts: T0 + 100, size: 20, price: 0.5 })], T0 + 100); // 10 $ : sous le seuil
    b.markets.set("0xc0nd1", synthMarket("0xc0nd1", { closed: true, resolved: true, prices: [1, 0] }));
    b.recompute();
    const out = b.tick(T0 + 200);
    expect(out.map((d) => d.kind)).toEqual(["RESULT"]);
    expect(out[0].fills).toEqual([1]);
    expect(out[0].usdc).toBeCloseTo(1010, 9);
    expect(pendingCount(b.st)).toBe(0);
  });
});

describe("alertes : invariants", () => {
  it("jamais deux alertes pour le même fill ; aucun fill perdu (simulation aléatoire reproductible)", () => {
    let seed = 12345;
    const rnd = (): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const b = new Bench();
    b.markets.set("0xc0nd2", synthMarket("0xc0nd2", { tokens: ["tokC", "tokD"] }));
    let t = T0;
    let n = 0;
    for (let step = 0; step < 400; step++) {
      t += Math.floor(rnd() * 90);
      if (rnd() < 0.6) {
        const which = rnd() < 0.5 ? { cond: "0xc0nd1", token: "tokA" } : { cond: "0xc0nd2", token: "tokC" };
        b.feed([trade({ ts: t - 3, size: Math.round(5 + rnd() * 800), price: 0.5, ...which })], t);
        n++;
      }
      if (rnd() < 0.2) b.reload();
      b.tick(t);
    }
    b.markets.set("0xc0nd1", synthMarket("0xc0nd1", { closed: true, resolved: true, prices: [1, 0] }));
    b.markets.set("0xc0nd2", synthMarket("0xc0nd2", { tokens: ["tokC", "tokD"], closed: true, resolved: true, prices: [0, 1] }));
    b.recompute();
    b.tick(t + 1000);
    const seen = new Map<number, number>();
    for (const d of b.all) for (const i of d.fills) seen.set(i, (seen.get(i) ?? 0) + 1);
    expect([...seen.values()].every((c) => c === 1)).toBe(true);
    expect(seen.size).toBe(n);                  // chaque fill est dans exactement une alerte
    expect(b.all.filter((d) => d.kind === "NEW")).toHaveLength(2);
    expect(b.all.filter((d) => d.kind === "RESULT")).toHaveLength(2);
    // Le total annoncé par la dernière alerte de renfort est exact.
    const lastInc = [...b.all].reverse().find((d) => d.kind === "INCREASE" && d.token_id === "tokA")!;
    const cashUpTo = b.ledger.fills.filter((f) => f.token_id === "tokA" && f.i <= Math.max(...lastInc.fills)).reduce((s, f) => s + f.usdc_size, 0);
    expect(lastInc.posCash).toBeGreaterThanOrEqual(cashUpTo - 1e-6);
  });

  it("présenter deux fois le même fill est sans effet (idempotence)", () => {
    const b = new Bench();
    b.feed([trade({ ts: T0, size: 100, price: 0.5 })], T0);
    const f = b.ledger.fills[0];
    expect(ingestFill(b.st, f, { nFills: 0, cash: 0 }, T0)).toBe(false);
    expect(pendingCount(b.st)).toBe(1);
  });

  it("reprise après interruption : état sérialisé au milieu d'une rafale, puis rechargé → une seule alerte NEW complète", () => {
    const b = new Bench();
    b.feed([trade({ ts: T0, size: 100, price: 0.5 })], T0 + 2);
    b.tick(T0 + 5);
    const saved = JSON.stringify(b.st);
    // « Redémarrage » : nouvel objet d'état, même registre.
    b.st = JSON.parse(saved) as AlertState;
    b.feed([trade({ ts: T0 + 6, size: 300, price: 0.5 })], T0 + 9);
    const out = b.tick(T0 + 22);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("NEW");
    expect(out[0].fills).toEqual([0, 1]);
    expect(out[0].usdc).toBeCloseTo(200, 9);
    expect(JSON.parse(JSON.stringify(b.st))).toEqual(b.st); // l'état reste du JSON pur
  });

  it("retard de détection : le lot garde le retard maximal de ses fills", () => {
    const b = new Bench();
    b.feed([trade({ ts: T0, size: 100, price: 0.5 })], T0 + 7500);
    const out = b.tick(T0 + 7520);
    expect(out[0].maxLagS).toBe(7500);
    expect(out[0].firstDetTs).toBe(T0 + 7500);
  });
});

describe("carnet : prix disponible au moment de l'envoi", () => {
  it("meilleur ask = dernier niveau ; $ disponibles jusqu'au prix limite", () => {
    const book = { asks: [{ price: "0.40", size: "1000" }, { price: "0.36", size: "500" }, { price: "0.34", size: "200" }, { price: "0.33", size: "100" }] };
    const s = bookSnapshot(book, 0.35, T0)!;
    expect(s.bestAsk).toBe(0.33);
    expect(s.bestAskSize).toBe(100);
    expect(s.usdAvail).toBeCloseTo(0.33 * 100 + 0.34 * 200, 9);
    expect(s.sharesAvail).toBe(300);
  });
  it("carnet vide ou illisible", () => {
    expect(bookSnapshot({ asks: [] }, 0.5, T0)).toMatchObject({ bestAsk: null, usdAvail: 0 });
    expect(bookSnapshot({}, 0.5, T0)).toBeNull();
    expect(bookSnapshot(null, 0.5, T0)).toBeNull();
  });
});
