// Formatage français des nombres, heures et messages d'alerte. Code pur.
import type { BetDescription } from "./types.ts";

const NBSP = " "; // espace fine insécable, séparateur de milliers

/** 12500 -> "12 500", 12500.5 -> "12 500,50" (décimales seulement si utiles ou forcées). */
export function frNumber(n: number, decimals?: number): string {
  const d = decimals ?? (Math.abs(n) >= 100 || Number.isInteger(n) ? 0 : 2);
  const fixed = Math.abs(n).toFixed(d);
  const [int, frac] = fixed.split(".");
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);
  const sign = n < 0 && Number(fixed) !== 0 ? "-" : "";
  return sign + grouped + (frac ? "," + frac : "");
}

export function frUsd(n: number, decimals?: number): string {
  return `${frNumber(n, decimals)}${NBSP}$`;
}

/** Prix Polymarket (0..1) : "0,63" ; garde 3 décimales si le tick est plus fin. */
export function frPrice(p: number): string {
  const r3 = Math.round(p * 1000) / 1000;
  const twoOk = Math.abs(r3 * 100 - Math.round(r3 * 100)) < 1e-9;
  return r3.toFixed(twoOk ? 2 : 3).replace(".", ",");
}

/** Cote décimale équivalente à un prix : 0,63 -> "1,59". */
export function decimalOdds(p: number): number | null {
  return p > 0 && p <= 1 ? 1 / p : null;
}
export function frOdds(p: number): string {
  const o = decimalOdds(p);
  if (o === null) return "—";
  return (o >= 10 ? o.toFixed(1) : o.toFixed(2)).replace(".", ",");
}

/** Heure locale (Europe/Zurich par défaut) : "14:32" ou "13/11 14:32". */
export function frTime(tsSec: number, tz = "Europe/Zurich", withDate = false): string {
  const d = new Date(tsSec * 1000);
  const time = new Intl.DateTimeFormat("fr-FR", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
  if (!withDate) return time;
  const date = new Intl.DateTimeFormat("fr-FR", { timeZone: tz, day: "2-digit", month: "2-digit" }).format(d);
  return `${date} ${time}`;
}

export type AlertKind = "NEW" | "INCREASE" | "REDUCE" | "CLOSE";

export interface AlertInput {
  kind: AlertKind;
  bet: BetDescription;
  /** Dollars réellement échangés dans ce lot de fills (achat : payés ; vente : reçus), hors frais. */
  usdc: number;
  /** Frais payés sur ce lot, si connus. */
  fees: number | null;
  shares: number;
  /** Prix moyen pondéré du lot. */
  avgPrice: number;
  fillCount: number;
  firstTs: number;
  lastTs: number;
  /** Position après ce lot. */
  positionShares: number;
  positionCost: number;      // coût d'acquisition restant engagé (hors frais)
  positionAvgPrice: number | null;
  /** PnL réalisé par ce lot (ventes uniquement). */
  realizedPnl: number | null;
  /** "PRÉ-MATCH" | "LIVE" | null si non vérifiable. */
  phase: "PRE" | "LIVE" | null;
  /** Minutes avant (+) le début prévu du match, si connu. */
  minutesToStart: number | null;
  url: string;
  isTest?: boolean;
  tz?: string;
}

const KIND_TITLE: Record<AlertKind, string> = {
  NEW: "🎯 NOUVEAU PARI CS2",
  INCREASE: "➕ RENFORT DE POSITION CS2",
  REDUCE: "➖ VENTE PARTIELLE CS2",
  CLOSE: "✅ POSITION FERMÉE CS2",
};

export interface AlertMessage { title: string; body: string; url: string; priority: "high" | "default"; tags: string }

export function formatAlert(a: AlertInput): AlertMessage {
  const buy = a.kind === "NEW" || a.kind === "INCREASE";
  const lines: string[] = [];
  lines.push(`${a.bet.match}${a.bet.format ? ` (${a.bet.format})` : ""}`);
  if (a.bet.tournament) lines.push(a.bet.tournament);
  lines.push(`Pari : ${a.bet.betFr}`);
  if (a.bet.winConditionFr) lines.push(`Pour gagner : ${a.bet.winConditionFr}`);
  if (!a.bet.exact) lines.push("⚠️ Type de marché non reconnu : intitulé brut, non interprété");
  const feeTxt = a.fees && a.fees > 0.005 ? ` (+ ${frUsd(a.fees, 2)} de frais)` : "";
  if (buy) {
    lines.push(`${a.kind === "NEW" ? "Mise" : "Ajout"} : ${frUsd(a.usdc)}${feeTxt}`);
    lines.push(`Prix d'entrée : ${frPrice(a.avgPrice)} — cote ${frOdds(a.avgPrice)}`);
    if (a.kind === "INCREASE" && a.positionAvgPrice !== null) {
      lines.push(`Position totale : ${frUsd(a.positionCost)} à ${frPrice(a.positionAvgPrice)} (cote ${frOdds(a.positionAvgPrice)})`);
    }
  } else {
    lines.push(`Vendu : ${frNumber(a.shares)} parts à ${frPrice(a.avgPrice)} = ${frUsd(a.usdc)}${feeTxt}`);
    if (a.realizedPnl !== null) lines.push(`PnL réalisé : ${a.realizedPnl >= 0 ? "+" : ""}${frUsd(a.realizedPnl)}`);
    lines.push(a.kind === "CLOSE" ? "Position restante : 0" : `Position restante : ${frUsd(a.positionCost)} engagés`);
  }
  if (a.phase === "PRE") {
    lines.push(a.minutesToStart !== null ? `Pré-match (début prévu dans ${frDuration(a.minutesToStart)})` : "Pré-match");
  } else if (a.phase === "LIVE") {
    lines.push("🔴 LIVE (match commencé)");
  }
  const t = a.fillCount > 1 && a.lastTs - a.firstTs >= 60
    ? `${frTime(a.firstTs, a.tz)}–${frTime(a.lastTs, a.tz)}`
    : frTime(a.lastTs, a.tz);
  lines.push(`Heure : ${t}${a.fillCount > 1 ? ` (${a.fillCount} exécutions)` : ""}`);
  const title = (a.isTest ? "🧪 TEST (rejeu historique) — " : "") + KIND_TITLE[a.kind];
  return { title, body: lines.join("\n"), url: a.url, priority: a.kind === "NEW" ? "high" : "default", tags: a.kind };
}

export function frDuration(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ${String(m % 60).padStart(2, "0")}`;
  return `${Math.floor(h / 24)} j`;
}
