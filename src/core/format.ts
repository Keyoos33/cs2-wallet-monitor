// Formatage français des nombres, heures et messages d'alerte. Code pur.
import type { AlertKind, BetDescription, BookSnapshot } from "./types.ts";
export type { AlertKind } from "./types.ts";

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

export interface AlertInput {
  kind: AlertKind;
  bet: BetDescription;
  /**
   * Cash du lot de fills, tel que donné par l'API (`usdc_size`) :
   * achat = cash réellement sorti, FRAIS INCLUS ; vente = cash reçu.
   */
  usdc: number;
  /** Frais compris dans `usdc` (achat), si connus. */
  fees: number | null;
  shares: number;
  /** Prix moyen pondéré du lot, hors frais. */
  avgPrice: number;
  fillCount: number;
  firstTs: number;
  lastTs: number;
  /** Position après ce lot. */
  positionShares: number;
  positionCost: number;      // cash engagé sur la position, frais inclus
  positionAvgPrice: number | null; // prix d'entrée moyen hors frais
  /** PnL réalisé par ce lot (ventes uniquement). */
  realizedPnl: number | null;
  /** "PRÉ-MATCH" | "LIVE" | null si non vérifiable. */
  phase: "PRE" | "LIVE" | null;
  /** Minutes avant (+) le début prévu du match au moment de l'envoi, si connu. */
  minutesToStart: number | null;
  url: string;
  isTest?: boolean;
  tz?: string;
  /** Nombre de fills preneur / maker du lot (ligne « Exécution » si renseigné). */
  takerCount?: number;
  makerCount?: number;
  /** Carnet au moment de l'envoi (NEW / INCREASE) ; null = carnet indisponible ; undefined = pas de ligne. */
  book?: BookSnapshot | null;
  /** Retard de détection (s) et heure de détection, si le lot a été détecté en retard. */
  lateLagS?: number | null;
  detectedTs?: number | null;
  /** RESULT : issue du pari. `usdc` = mise totale, `fees` = frais totaux, `avgPrice` = prix d'entrée moyen. */
  result?: { status: "won" | "lost" | "void"; payout: number; pnl: number; roi: number | null } | null;
}

const KIND_TITLE: Record<AlertKind, string> = {
  NEW: "🎯 NOUVEAU PARI CS2",
  INCREASE: "➕ RENFORT DE POSITION CS2",
  REDUCE: "➖ VENTE PARTIELLE CS2",
  CLOSE: "✅ POSITION FERMÉE CS2",
  RESULT: "🏁 RÉSULTAT CS2",
};

const RESULT_LABEL = { won: "✅ GAGNÉ", lost: "❌ PERDU", void: "↩️ REMBOURSÉ 50-50" } as const;

export const TEST_PREFIX = "🧪 TEST (rejeu historique) — ";

export interface AlertMessage { title: string; body: string; url: string; priority: "high" | "default"; tags: string }

function signedUsd(n: number): string {
  return `${n > 0 ? "+" : ""}${frUsd(n)}`;
}

/** "+12,3 %" */
export function frPct(ratio: number, decimals = 1): string {
  const v = ratio * 100;
  return `${v > 0 ? "+" : ""}${frNumber(v, decimals)}${NBSP}%`;
}

/** Ligne « prix disponible au moment de l'envoi » (copiabilité). */
export function formatBookLine(b: BookSnapshot | null): string {
  if (b === null) return "Dispo maintenant : carnet indisponible";
  if (b.bestAsk === null) return "Dispo maintenant : aucune offre à la vente";
  const best = `${frPrice(b.bestAsk)} (cote ${frOdds(b.bestAsk)})${b.bestAskSize !== null ? ` × ${frNumber(b.bestAskSize, 0)} parts` : ""}`;
  return b.usdAvail > 0
    ? `Dispo maintenant : ${best} — ${frUsd(b.usdAvail, 0)} jusqu'à ${frPrice(b.limit)}`
    : `Dispo maintenant : ${best} — rien jusqu'à ${frPrice(b.limit)}`;
}

export function formatAlert(a: AlertInput): AlertMessage {
  const buy = a.kind === "NEW" || a.kind === "INCREASE";
  const lines: string[] = [];
  lines.push(`${a.bet.match}${a.bet.format ? ` (${a.bet.format})` : ""}`);
  if (a.bet.tournament) lines.push(a.bet.tournament);
  lines.push(`Pari : ${a.bet.betFr}`);
  if (a.bet.winConditionFr) lines.push(`Pour gagner : ${a.bet.winConditionFr}`);
  if (!a.bet.exact) lines.push("⚠️ Type de marché non reconnu : intitulé brut, non interprété");
  const feeTxt = a.fees && a.fees > 0.005 ? ` (dont ${frUsd(a.fees, 2)} de frais)` : "";
  let title = KIND_TITLE[a.kind];
  if (a.kind === "RESULT") {
    const r = a.result ?? null;
    if (r) title += ` : ${RESULT_LABEL[r.status]}`;
    lines.push(`Mise totale : ${frUsd(a.usdc)}${feeTxt}`);
    lines.push(`Prix d'entrée moyen : ${frPrice(a.avgPrice)} — cote ${frOdds(a.avgPrice)}`);
    if (r) {
      lines.push(`Encaissé : ${frUsd(r.payout)}`);
      lines.push(`PnL : ${signedUsd(r.pnl)}${r.roi !== null ? ` (ROI ${frPct(r.roi)})` : ""}`);
    }
  } else if (buy) {
    lines.push(`${a.kind === "NEW" ? "Mise" : "Ajout"} : ${frUsd(a.usdc)}${feeTxt}`);
    lines.push(`Prix d'entrée : ${frPrice(a.avgPrice)} — cote ${frOdds(a.avgPrice)}`);
    if (a.kind === "INCREASE" && a.positionAvgPrice !== null) {
      lines.push(`Position totale : ${frUsd(a.positionCost)} à ${frPrice(a.positionAvgPrice)} (cote ${frOdds(a.positionAvgPrice)})`);
    }
  } else {
    lines.push(`Vendu : ${frNumber(a.shares)} parts à ${frPrice(a.avgPrice)} = ${frUsd(a.usdc)}`);
    if (a.realizedPnl !== null) lines.push(`PnL réalisé : ${signedUsd(a.realizedPnl)}`);
    lines.push(a.kind === "CLOSE" ? "Position restante : 0" : `Position restante : ${frUsd(a.positionCost)} engagés`);
  }
  if (a.kind !== "RESULT") {
    if (a.phase === "PRE") {
      lines.push(a.minutesToStart !== null && a.minutesToStart > 0
        ? `Pré-match (début prévu dans ${frDuration(a.minutesToStart)})`
        : a.minutesToStart !== null ? "Pré-match au moment du pari (début prévu dépassé depuis)" : "Pré-match");
    } else if (a.phase === "LIVE") {
      lines.push("🔴 LIVE (match commencé)");
    }
    const tk = a.takerCount ?? 0, mk = a.makerCount ?? 0;
    if (tk + mk > 0) {
      lines.push(`Exécution : ${mk === 0 ? "ordre au marché (taker)" : tk === 0 ? "ordre limite exécuté (maker)" : `${tk} taker + ${mk} maker`}`);
    }
    const t = a.fillCount > 1 && a.lastTs - a.firstTs >= 60
      ? `${frTime(a.firstTs, a.tz)}–${frTime(a.lastTs, a.tz)}`
      : frTime(a.lastTs, a.tz);
    lines.push(`Heure : ${t}${a.fillCount > 1 ? ` (${a.fillCount} exécutions)` : ""}`);
    if (buy && a.book !== undefined) lines.push(formatBookLine(a.book));
    if (a.lateLagS != null && a.lateLagS > 0) {
      const hhmm = a.detectedTs != null ? ` à ${frTime(a.detectedTs, a.tz)}` : "";
      lines.push(`⏱ Détecté en retard${hhmm} (${frDuration(a.lateLagS / 60)} après le pari de ${frTime(a.lastTs, a.tz, true)})`);
    }
  }
  if (a.isTest) title = TEST_PREFIX + title;
  return { title, body: lines.join("\n"), url: a.url, priority: a.kind === "NEW" ? "high" : "default", tags: a.kind };
}

/** Échappe le texte pour Telegram parse_mode=HTML. */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Message Telegram (HTML) : titre en gras, corps, lien vers l'événement. */
export function toTelegramHtml(m: AlertMessage): string {
  const link = /^https:\/\/polymarket\.com\//.test(m.url) ? `\n<a href="${escapeHtml(m.url).replace(/"/g, "%22")}">Voir sur Polymarket</a>` : "";
  return `<b>${escapeHtml(m.title)}</b>\n${escapeHtml(m.body)}${link}`;
}

/** Version texte brut (journal, alerts.jsonl). */
export function toPlainText(m: AlertMessage): string {
  return `${m.title}\n${m.body}\n${m.url}`;
}

export function frDuration(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ${String(m % 60).padStart(2, "0")}`;
  return `${Math.floor(h / 24)} j`;
}
