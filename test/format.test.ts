import { describe, expect, it } from "vitest";
import { escapeHtml, formatAlert, formatBookLine, frDuration, frOdds, frPct, frPrice, frUsd, TEST_PREFIX, toPlainText, toTelegramHtml } from "../src/core/format.ts";
import type { AlertInput } from "../src/core/format.ts";
import type { BetDescription } from "../src/core/types.ts";

const bet: BetDescription = {
  match: "G2 vs Falcons", format: "BO3", tournament: "BLAST Rivals", marketTypeKey: "map_handicap", marketTypeFr: "Handicap de cartes",
  betFr: "G2 -1,5 carte", winConditionFr: "G2 doit gagner 2-0", exact: true,
};
// 2026-11-13 13:32:00Z = 14:32 à Zurich (heure d'hiver)
const TS = Date.UTC(2026, 10, 13, 13, 32, 0) / 1000;

const base: AlertInput = {
  kind: "NEW", bet, usdc: 1234.56, fees: 12.3, shares: 3700, avgPrice: 0.33, fillCount: 3, firstTs: TS - 90, lastTs: TS,
  positionShares: 3700, positionCost: 1234.56, positionAvgPrice: 0.33, realizedPnl: null, phase: "PRE", minutesToStart: 125,
  url: "https://polymarket.com/event/cs2-g2-fal2-2026-11-13", takerCount: 2, makerCount: 1,
};
const plain = (s: string): string => s.replace(/ /g, " ");

describe("format des alertes (français, Europe/Zurich)", () => {
  it("NOUVEAU PARI : mise frais inclus avec frais à part, prix, cote, pré-match, heure, exécution", () => {
    const m = formatAlert(base);
    expect(m.title).toBe("🎯 NOUVEAU PARI CS2");
    expect(m.priority).toBe("high");
    const body = plain(m.body).split("\n");
    expect(body).toEqual([
      "G2 vs Falcons (BO3)",
      "BLAST Rivals",
      "Pari : G2 -1,5 carte",
      "Pour gagner : G2 doit gagner 2-0",
      "Mise : 1 235 $ (dont 12,30 $ de frais)",
      "Prix d'entrée : 0,33 — cote 3,03",
      "Pré-match (début prévu dans 2 h 05)",
      "Exécution : 2 taker + 1 maker",
      "Heure : 14:30–14:32 (3 exécutions)",
    ]);
  });

  it("RENFORT : ajout ET total de la position", () => {
    const m = formatAlert({ ...base, kind: "INCREASE", usdc: 300, fees: 0, fillCount: 1, positionCost: 1534.56, positionAvgPrice: 0.335, takerCount: 0, makerCount: 1 });
    const body = plain(m.body);
    expect(m.title).toBe("➕ RENFORT DE POSITION CS2");
    expect(body).toContain("Ajout : 300 $\n");
    expect(body).toContain("Position totale : 1 535 $ à 0,335 (cote 2,99)");
    expect(body).toContain("Exécution : ordre limite exécuté (maker)");
    expect(body).toContain("Heure : 14:32");
    expect(m.priority).toBe("default");
  });

  it("prix disponible au moment de l'envoi", () => {
    const b = { ts: TS, bestAsk: 0.34, bestAskSize: 1200, limit: 0.35, usdAvail: 2300, sharesAvail: 6700 };
    expect(plain(formatBookLine(b))).toBe("Dispo maintenant : 0,34 (cote 2,94) × 1 200 parts — 2 300 $ jusqu'à 0,35");
    expect(plain(formatBookLine({ ...b, bestAsk: 0.4, usdAvail: 0 }))).toBe("Dispo maintenant : 0,40 (cote 2,50) × 1 200 parts — rien jusqu'à 0,35");
    expect(formatBookLine(null)).toBe("Dispo maintenant : carnet indisponible");
    expect(formatBookLine({ ...b, bestAsk: null, bestAskSize: null, usdAvail: 0 })).toBe("Dispo maintenant : aucune offre à la vente");
    expect(plain(formatAlert({ ...base, book: b }).body)).toContain("Dispo maintenant : 0,34");
    expect(formatAlert({ ...base, book: undefined }).body).not.toContain("Dispo maintenant");
    // Pas de ligne carnet sur une vente ou un résultat.
    expect(formatAlert({ ...base, kind: "REDUCE", book: b }).body).not.toContain("Dispo maintenant");
  });

  it("mention de détection tardive", () => {
    const m = formatAlert({ ...base, lateLagS: 2 * 3600 + 8 * 60, detectedTs: TS + 2 * 3600 + 8 * 60 });
    expect(plain(m.body)).toContain("⏱ Détecté en retard à 16:40 (2 h 08 après le pari de 13/11 14:30)");
    expect(formatAlert({ ...base, lateLagS: null }).body).not.toContain("retard");
  });

  it("LIVE, et pré-match dont l'heure prévue est dépassée à l'envoi", () => {
    expect(formatAlert({ ...base, phase: "LIVE" }).body).toContain("🔴 LIVE (match commencé)");
    expect(formatAlert({ ...base, minutesToStart: -30 }).body).toContain("Pré-match au moment du pari");
    expect(formatAlert({ ...base, phase: null }).body).not.toMatch(/Pré-match|LIVE/);
  });

  it("RÉSULTAT : gagné / perdu / remboursé, mise totale, PnL, ROI", () => {
    const won = formatAlert({ ...base, kind: "RESULT", usdc: 34991.31, fees: 1136.79, avgPrice: 0.3284, result: { status: "won", payout: 103094.01, pnl: 68102.7, roi: 1.9463 } });
    expect(won.title).toBe("🏁 RÉSULTAT CS2 : ✅ GAGNÉ");
    const body = plain(won.body);
    expect(body).toContain("Mise totale : 34 991 $ (dont 1 136,79 $ de frais)");
    expect(body).toContain("Prix d'entrée moyen : 0,328 — cote 3,05");
    expect(body).toContain("Encaissé : 103 094 $");
    expect(body).toContain("PnL : +68 103 $ (ROI +194,6 %)");
    expect(body).not.toContain("Heure :");
    const lost = formatAlert({ ...base, kind: "RESULT", usdc: 500, fees: 0, result: { status: "lost", payout: 0, pnl: -500, roi: -1 } });
    expect(lost.title).toBe("🏁 RÉSULTAT CS2 : ❌ PERDU");
    expect(plain(lost.body)).toContain("PnL : -500 $ (ROI -100,0 %)");
    expect(formatAlert({ ...base, kind: "RESULT", result: { status: "void", payout: 617, pnl: -617, roi: -0.5 } }).title).toContain("REMBOURSÉ 50-50");
  });

  it("ventes : parts, prix, cash reçu, PnL réalisé, reste", () => {
    const m = formatAlert({ ...base, kind: "REDUCE", usdc: 280, shares: 400, avgPrice: 0.7, realizedPnl: 72, positionCost: 312 });
    const body = plain(m.body);
    expect(body).toContain("Vendu : 400 parts à 0,70 = 280 $");
    expect(body).toContain("PnL réalisé : +72 $");
    expect(body).toContain("Position restante : 312 $ engagés");
    expect(formatAlert({ ...base, kind: "CLOSE", realizedPnl: -10 }).body).toContain("Position restante : 0");
  });

  it("type de marché non reconnu : avertissement explicite, intitulé brut", () => {
    const m = formatAlert({ ...base, bet: { ...bet, exact: false, betFr: "Will X happen? → Yes", winConditionFr: "" } });
    expect(m.body).toContain("⚠️ Type de marché non reconnu");
    expect(m.body).not.toContain("Pour gagner");
  });

  it("rejeu : titre préfixé « 🧪 TEST (rejeu historique) »", () => {
    const m = formatAlert({ ...base, isTest: true });
    expect(m.title.startsWith("🧪 TEST (rejeu historique)")).toBe(true);
    expect(m.title).toBe(TEST_PREFIX + "🎯 NOUVEAU PARI CS2");
  });

  it("Telegram HTML : < > & échappés, titre en gras, lien", () => {
    const m = formatAlert({ ...base, bet: { ...bet, match: "A&B <x> vs C" } });
    const html = toTelegramHtml(m);
    expect(html).toContain("<b>🎯 NOUVEAU PARI CS2</b>");
    expect(html).toContain("A&amp;B &lt;x&gt; vs C");
    expect(html).toContain('<a href="https://polymarket.com/event/cs2-g2-fal2-2026-11-13">Voir sur Polymarket</a>');
    expect(escapeHtml("<&>")).toBe("&lt;&amp;&gt;");
    expect(toPlainText(m).split("\n").pop()).toBe(base.url);
    // Une URL inattendue n'est jamais transformée en lien.
    expect(toTelegramHtml({ ...m, url: "javascript:alert(1)" })).not.toContain("<a ");
  });

  it("nombres : séparateur de milliers, prix, cotes, pourcentages, durées", () => {
    expect(plain(frUsd(12500))).toBe("12 500 $");
    expect(plain(frUsd(41.7))).toBe("41,70 $");
    expect(frPrice(0.63)).toBe("0,63");
    expect(frPrice(0.7373603431)).toBe("0,737");
    expect(frOdds(0.5)).toBe("2,00");
    expect(plain(frPct(0.1912))).toBe("+19,1 %");
    expect(frDuration(45)).toBe("45 min");
    expect(frDuration(125)).toBe("2 h 05");
  });
});
