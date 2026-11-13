// Réglages du moniteur. Les valeurs par défaut ci-dessous sont celles de l'architecture ;
// `config.json` (racine du dépôt) les remplace, et quelques variables d'environnement
// (MAX_RUN_S, POLL_SECONDS) remplacent `config.json` pour les essais locaux. Code pur.

export interface Config {
  WALLET: string;
  TZ: string;
  /** Intervalle entre deux lectures de /v2/activity (s). */
  POLL_SECONDS: number;
  POLL_LIMIT: number;
  /** Recouvrement relu à chaque lecture (s) : une ligne indexée en retard est quand même vue. */
  POLL_OVERLAP_S: number;
  /** Recul au démarrage d'un run (s). */
  RESUME_REWIND_S: number;
  HTTP_TIMEOUT_MS: number;
  BACKOFF_MAX_S: number;
  /** Au-delà de ce retard de détection (s), l'alerte porte la mention « détecté en retard ». */
  LATE_LAG_S: number;
  /** NEW : délai d'agrégation de la rafale après la première détection (s). */
  NEW_SETTLE_S: number;
  /** INCREASE : cumul minimal ($) pour notifier un renfort. */
  INCREASE_MIN_USD: number;
  /** INCREASE : délai minimal depuis la dernière alerte de la position (s). */
  INCREASE_MIN_GAP_S: number;
  /** INCREASE : un renfort ≥ ce ratio de la position à la dernière alerte part sans attendre le délai. */
  INCREASE_BIG_RATIO: number;
  /** INCREASE (gros renfort) : secondes de calme exigées avant l'envoi. */
  INCREASE_SETTLE_S: number;
  /** REDUCE / CLOSE : délai d'agrégation (s). */
  SELL_SETTLE_S: number;
  /** « $ disponibles jusqu'à prix d'entrée + marge ». */
  BOOK_PRICE_MARGIN: number;
  /** Intervalle de vérification des résolutions sur Gamma (s). */
  RESOLVE_POLL_S: number;
  /** Nouvel essai Gamma pour un marché sans métadonnées (s). */
  MARKET_RETRY_S: number;
  /** Intervalle d'écriture de site/heartbeat.json (s). */
  HEARTBEAT_S: number;
  /** Intervalle du battement du bail (commit de state.json) ; doit rester bien inférieur à LEASE_STALE_S. */
  LEASE_HEARTBEAT_S: number;
  /** Un bail dont le battement est plus vieux est considéré mort (s). */
  LEASE_STALE_S: number;
  /** Durée d'un run (s) ; 19200 = 5 h 20. */
  MAX_RUN_S: number;
  /** Le successeur est lancé ce nombre de secondes avant la fin du run. */
  HANDOVER_BEFORE_END_S: number;
  HANDOVER_POLL_S: number;
  /** Attente maximale d'un successeur avant d'abandonner (s). */
  SUCCESSOR_MAX_WAIT_S: number;
  /** Réconciliation : un fill manquant plus vieux que cela est ajouté sans alerte (s). */
  RECONCILE_ALERT_MAX_AGE_S: number;
  RECONCILE_ON_START: boolean;
  /** daily.yml : attente maximale de la réponse du moniteur à une demande de réconciliation (s). */
  RECONCILE_WAIT_S: number;
  /** Dashboard : les fills dans cette fenêtre après le premier forment la « mise initiale » (s). */
  INITIAL_WINDOW_S: number;
  /** Bornes des tranches de mise ($). */
  STAKE_BUCKETS: number[];
  /** Nombre d'alertes gardées dans site/data.json. */
  ALERT_LOG_MAX: number;
}

export const DEFAULT_CONFIG: Config = {
  WALLET: "0xc9bfc7986767173b4f1c3fc9b2c6b255fc7381c0",
  TZ: "Europe/Zurich",
  POLL_SECONDS: 3,
  POLL_LIMIT: 200,
  POLL_OVERLAP_S: 600,
  RESUME_REWIND_S: 3600,
  HTTP_TIMEOUT_MS: 8000,
  BACKOFF_MAX_S: 60,
  LATE_LAG_S: 120,
  NEW_SETTLE_S: 20,
  INCREASE_MIN_USD: 100,
  INCREASE_MIN_GAP_S: 600,
  INCREASE_BIG_RATIO: 0.5,
  INCREASE_SETTLE_S: 20,
  SELL_SETTLE_S: 20,
  BOOK_PRICE_MARGIN: 0.02,
  RESOLVE_POLL_S: 120,
  MARKET_RETRY_S: 30,
  HEARTBEAT_S: 300,
  LEASE_HEARTBEAT_S: 45,
  LEASE_STALE_S: 120,
  MAX_RUN_S: 19200,
  HANDOVER_BEFORE_END_S: 300,
  HANDOVER_POLL_S: 10,
  SUCCESSOR_MAX_WAIT_S: 900,
  RECONCILE_ALERT_MAX_AGE_S: 86400,
  RECONCILE_ON_START: true,
  RECONCILE_WAIT_S: 600,
  INITIAL_WINDOW_S: 60,
  STAKE_BUCKETS: [100, 500, 2000, 10000, 50000],
  ALERT_LOG_MAX: 300,
};

/** Fusionne des réglages partiels sur les défauts, en ignorant les clés inconnues ou de mauvais type. */
export function mergeConfig(...parts: Array<Record<string, unknown> | null | undefined>): Config {
  const out: Record<string, unknown> = { ...DEFAULT_CONFIG };
  for (const p of parts) {
    if (!p) continue;
    for (const [k, v] of Object.entries(p)) {
      if (!(k in DEFAULT_CONFIG)) continue;
      const def = (DEFAULT_CONFIG as unknown as Record<string, unknown>)[k];
      if (typeof def === "number") {
        const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
        if (typeof n === "number" && Number.isFinite(n)) out[k] = n;
      } else if (typeof def === "boolean") {
        if (typeof v === "boolean") out[k] = v;
        else if (v === "1" || v === "true") out[k] = true;
        else if (v === "0" || v === "false") out[k] = false;
      } else if (Array.isArray(def)) {
        if (Array.isArray(v) && v.every((x) => typeof x === "number")) out[k] = v;
      } else if (typeof v === typeof def) out[k] = v;
    }
  }
  return out as unknown as Config;
}
