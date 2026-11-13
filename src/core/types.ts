// Types partagés. Tout le code de src/core est PUR (aucun accès réseau, aucun
// accès disque) : il tourne à l'identique dans Node (tests) et dans le Worker.

/** Métadonnées d'un marché, issues de Gamma (GET /markets ou /events). */
export interface MarketMeta {
  conditionId: string;
  question: string;
  slug: string;
  eventSlug: string;
  eventTitle: string;            // ex. "Counter-Strike: ex-RUSTEC vs Nexus (BO3) - CCT Europe Group Stage"
  seriesSlug: string | null;     // ex. "counter-strike"
  sportsMarketType: string | null; // ex. moneyline, child_moneyline, totals, map_handicap, round_over_under_game_1 ...
  line: number | null;
  outcomes: string[];            // ordre = outcome_index
  tokenIds: string[];            // ordre = outcome_index
  groupItemTitle: string | null;
  gameStartTime: string | null;  // ISO UTC
  negRisk: boolean;
}

/** Résultat de la traduction d'un pari (marché + issue choisie). */
export interface BetDescription {
  match: string;          // "ex-RUSTEC vs Nexus"
  format: string | null;  // "BO3"
  tournament: string;     // "CCT Europe Group Stage"
  marketTypeKey: string;  // clé stable pour les stats : match_winner | map_winner | map_handicap | total_maps | total_rounds_map | round_handicap_map | ... | unknown
  marketTypeFr: string;   // libellé FR du type : "Vainqueur du match"
  betFr: string;          // phrase courte : "Nexus -1,5 carte" / "Plus de 2,5 cartes"
  winConditionFr: string; // ce qu'il faut pour gagner : "Nexus doit gagner 2-0"
  exact: boolean;         // false si le type n'est pas reconnu : betFr reprend alors l'intitulé brut, sans interprétation
}

// ─────────────────────────────────────────────────────────────────────────────
// Registre, positions, alertes, état du runner, données du dashboard
// ─────────────────────────────────────────────────────────────────────────────

/** Ligne brute de `GET /v2/activity` (seuls les champs utilisés sont typés). */
export interface RawActivity {
  timestamp: number;
  type: string;                 // TRADE, REDEEM, MAKER_REBATE, TAKER_REBATE, DEPOSIT, WITHDRAWAL, MERGE, SPLIT, CONVERSION…
  transaction_hash: string;
  condition_id: string;
  token_id: string;
  side: string;                 // BUY | SELL | "" (hors TRADE)
  outcome_index: number;        // 999 = non renseigné
  size: number;
  price: number;
  usdc_size: number;
  title?: string;
  slug?: string;
  event_slug?: string;
  outcome?: string;
  [k: string]: unknown;
}

export type FillSource = "live" | "backfill" | "reconcile";
export type Phase = "PRE" | "LIVE";

/**
 * Une exécution (ligne TRADE) du registre `ledger/fills.jsonl`.
 * Champs bruts de l'API sous leur nom d'origine (les champs de profil constants
 * et `title`/`icon` sont omis : le titre vit dans `ledger/markets.json`) + champs dérivés.
 */
export interface Fill {
  /** Numéro d'ordre dans le registre (0, 1, 2…) : identifiant stable, le registre n'étant jamais réécrit. */
  i: number;
  timestamp: number;            // horodatage du bloc (s)
  transaction_hash: string;
  token_id: string;
  condition_id: string;
  outcome_index: number;
  side: "BUY" | "SELL";
  size: number;                 // parts
  price: number;                // $ par part, hors frais
  /** `usdc_size` de l'API : cash réellement sorti (achat, frais inclus) ou reçu (vente). */
  usdc_size: number;
  slug: string;
  event_slug: string;
  outcome: string;
  // ── dérivés ──
  /** Frais = |usdc_size − size×price| (0 pour un fill maker). */
  fee: number;
  /** true si preneur (usdc_size > size×price + 1e-6 à l'achat). */
  taker: boolean;
  /** PRE si timestamp < gameStartTime prévu ; null si l'heure du match est inconnue. */
  phase: Phase | null;
  cs2: boolean;
  src: FillSource;
  /** Horloge murale à la détection (s) ; null pour un fill de backfill. */
  detected_ts: number | null;
  /** detected_ts − timestamp ; null pour un fill de backfill. */
  lag_s: number | null;
}

/** Ligne non-TRADE du registre `ledger/events.jsonl` (REDEEM, rebates, dépôts, retraits, MERGE…). */
export interface LedgerEvent {
  type: string;
  timestamp: number;
  transaction_hash: string;
  condition_id: string;
  token_id: string;
  outcome_index: number;
  size: number;
  usdc_size: number;
  src: FillSource;
  detected_ts: number | null;
}

/** Entrée du cache `ledger/markets.json`, par condition_id. */
export interface MarketEntry {
  meta: MarketMeta;
  /** Événement parent : id Gamma, ligue et tournoi (eventMetadata), si connus. */
  eventId: string | null;
  league: string | null;
  /** Marché fermé ET résolu (umaResolutionStatus == "resolved"). */
  resolved: boolean;
  closed: boolean;
  /** outcomePrices décodés (prix de règlement si résolu, sinon dernier prix Gamma connu). */
  prices: number[] | null;
  closedTs: number | null;
  /** Dernière lecture Gamma (s). */
  fetched_ts: number;
  /** true : Gamma indisponible, entrée minimale construite depuis la ligne du flux (à rafraîchir). */
  stub?: boolean;
}

export type PositionStatus = "open" | "won" | "lost" | "void" | "sold";

/** Position reconstruite pour un token (une issue d'un marché). Tous les montants dérivent des champs API. */
export interface Position {
  token_id: string;
  condition_id: string;
  outcome_index: number;
  outcome: string;
  slug: string;
  event_slug: string;
  cs2: boolean;
  /** Parts achetées (cumul) / encore détenues / vendues ou fusionnées. */
  bought: number;
  held: number;
  sold: number;
  /** Σ size×price des achats (hors frais). */
  cost: number;
  /** Σ frais des achats. */
  fees: number;
  /** Σ usdc_size des achats = cash réellement sorti, frais inclus (la « mise »). */
  cash: number;
  /** Cash reçu des ventes / fusions. */
  proceeds: number;
  /** PnL réalisé par les ventes : produit − coût moyen (frais inclus) × parts vendues. */
  realized: number;
  /** Coût (frais inclus) encore engagé sur les parts détenues. */
  basis: number;
  /** Prix d'entrée moyen pondéré hors frais : Σ size×price / Σ size (achats). */
  avgPrice: number | null;
  nFills: number;
  firstTs: number;
  lastTs: number;
  status: PositionStatus;
  /** Prix de règlement (1, 0, 0,5) ; null si non résolu. */
  settle: number | null;
  /** Parts détenues × prix de règlement ; 0 si non résolu. */
  payout: number;
  resolvedTs: number | null;
  /** Clos : payout + ventes − cash. Ouvert : PnL réalisé par les ventes à ce jour. */
  pnl: number;
  /** pnl / cash ; null si position ouverte ou cash nul. */
  roi: number | null;
  /** Numéros (`Fill.i`) des fills de la position, par ordre chronologique. */
  fills: number[];
  /** Opération non interprétée rencontrée (CONVERSION…) : montants à vérifier. */
  warn?: string;
}

export type AlertKind = "NEW" | "INCREASE" | "REDUCE" | "CLOSE" | "RESULT";

/** Agrégat d'un lot de fills en attente / d'une alerte à envoyer (sérialisable). */
export interface AlertDraft {
  id: string;                   // "a<seq>"
  kind: AlertKind;
  token_id: string;
  condition_id: string;
  outcome_index: number;
  /** Numéros des fills couverts (un fill n'appartient qu'à une alerte). */
  fills: number[];
  shares: number;
  /** Cash du lot (achat : sorti, frais inclus ; vente : reçu). */
  usdc: number;
  fees: number;
  /** Prix moyen pondéré hors frais du lot. */
  avgPrice: number;
  takerCount: number;
  makerCount: number;
  firstTs: number;              // horodatage bloc du premier fill
  lastTs: number;
  firstDetTs: number;           // première détection (horloge murale)
  maxLagS: number;              // retard de détection maximal du lot
  phase: Phase | null;          // phase du dernier fill du lot
  /** Position après le lot. */
  posShares: number;
  posCash: number;
  posAvgPrice: number | null;
  realizedPnl: number | null;
  /** RESULT uniquement. */
  result?: { status: "won" | "lost" | "void"; payout: number; pnl: number; roi: number | null; settle: number };
  created_ts: number;
  /** Essais d'envoi échoués et instant du dernier (pour espacer les nouveaux essais). */
  tries: number;
  last_try_ts?: number;
}

/** Mesure du carnet au moment de l'envoi (étude de copiabilité). */
export interface BookSnapshot {
  ts: number;
  bestAsk: number | null;
  bestAskSize: number | null;
  /** Prix limite retenu = prix d'entrée du lot + marge (0,02 par défaut). */
  limit: number;
  /** $ disponibles à l'achat jusqu'au prix limite. */
  usdAvail: number;
  sharesAvail: number;
}

/** Ligne de `ledger/alerts.jsonl` : une alerte envoyée. */
export interface AlertRecord {
  id: string;
  kind: AlertKind;
  token_id: string;
  condition_id: string;
  fills: number[];
  usdc: number;
  title: string;
  text: string;
  url: string;
  created_ts: number;
  /** Horodatage bloc du premier et du dernier fill du lot (RESULT : premier fill de la position, résolution). */
  fill_ts: number;
  last_fill_ts: number;
  /** Première détection du lot par le moniteur (horloge murale). */
  detected_ts: number;
  /** Confirmation d'envoi par Telegram (horloge murale). */
  sent_ts: number;
  /** Détection : première détection − horodatage bloc du premier fill du lot (s). */
  lat_detect_s: number;
  /** Envoi : sent_ts − première détection (s) ; inclut le délai de regroupement. */
  lat_send_s: number;
  /** "ok" (Telegram ok:true) ou "dry" (DRY_RUN). Une alerte en échec n'est jamais écrite ici. */
  status: "ok" | "dry";
  tries: number;
  is_test: boolean;
  book: BookSnapshot | null;
}

/** État d'alerte d'une position (par token). */
export interface PosAlertState {
  /** Une alerte NEW a été émise, ou la position préexistait (backfill). */
  alerted: boolean;
  /** Horloge murale de la dernière alerte de cette position (0 = jamais). */
  lastAlertTs: number;
  /** Cash de la position au moment de la dernière alerte. */
  cashAtLastAlert: number;
  /** Fills d'achat / de vente en attente d'alerte. */
  buys: number[];
  sells: number[];
  /** Première et dernière détection du lot en attente. */
  firstDetTs: number;
  lastDetTs: number;
}

export interface AlertState {
  seq: number;
  pos: Record<string, PosAlertState>;
  /** Alertes construites, pas encore confirmées par Telegram. */
  outbox: AlertDraft[];
}

export interface Lease {
  run_id: string;
  acquired_ts: number;
  heartbeat_ts: number;
  released: boolean;
  /** Le détenteur a demandé un successeur à cet instant (null sinon). */
  handover_wanted_ts: number | null;
}

/** `state/handover.json` : écrit par le successeur pour dire « je suis prêt ». */
export interface Handover { run_id: string; ready_ts: number }

/** `site/heartbeat.json`. */
export interface Heartbeat {
  ts: number;
  run_id: string;
  started_ts: number;
  last_poll_ok_ts: number;
  last_fill_ts: number;
  polls: number;
  errors: number;
  /** Alertes en attente d'envoi (Telegram en échec) et lots en cours de regroupement. */
  outbox: number;
  pending: number;
}

/** `state/state.json`. */
export interface RunnerState {
  v: 1;
  /** Plus grand horodatage de bloc vu dans le flux. */
  cursor: number;
  lease: Lease | null;
  alerts: AlertState;
  /** Tokens dont la position est ouverte (sert à détecter les résolutions → alerte RESULT). */
  open: string[];
  /** Nombre de fills du registre déjà présentés à la machine d'alertes. */
  ledger_n: number;
  bootstrapped_ts: number | null;
  last_reconcile_ts: number | null;
  last_fill_ts: number;
}

// ── Dashboard ────────────────────────────────────────────────────────────────
// JSON compact : clés courtes et stables, documentées ici. Montants en $ arrondis
// au centième, prix à 4 décimales, horodatages en secondes epoch (UTC).

/**
 * Un fill, sous forme de tuple :
 * [0] ts bloc · [1] parts · [2] prix hors frais · [3] cash (frais inclus à l'achat ; reçu à la vente)
 * [4] frais · [5] drapeaux (bits) · [6] hash de transaction · [7] retard de détection en s (null si backfill)
 * Drapeaux : 1 = taker (sinon maker) · 2 = LIVE · 4 = phase inconnue (ni PRE ni LIVE) · 8 = vente (sinon achat)
 *            16 = hors mise initiale (renfort) · 32 = src backfill · 64 = src reconcile
 */
export type DashFill = [number, number, number, number, number, number, string, number | null];

export interface DashPosition {
  id: string;                   // token_id
  m: number;                    // index dans DashboardData.matches
  q: string;                    // question du marché (anglais, brut)
  slug: string;                 // slug du marché
  out: string;                  // issue achetée (brut)
  tk: string;                   // marketTypeKey (clé stable de stats)
  tf: string;                   // libellé FR du type de marché
  bet: string;                  // pari en français
  win: string;                  // condition de gain en français
  ex: 0 | 1;                    // 1 = traduction exacte ; 0 = type non reconnu (intitulé brut)
  st: PositionStatus;           // open | won | lost | void (remboursé 50-50) | sold
  sh: number;                   // parts achetées
  held: number;                 // parts détenues
  cash: number;                 // mise = cash sorti, frais inclus
  fee: number;                  // dont frais
  px: number | null;            // prix d'entrée moyen hors frais
  odds: number | null;          // cote décimale = 1 / px
  init: number;                 // mise initiale (fills dans cfg.initial_window_s après le premier)
  add: number;                  // renforts ultérieurs (cash − init)
  nf: number;                   // nombre de fills
  t0: number;                   // premier fill
  t1: number;                   // dernier fill
  tr: number | null;            // résolution / clôture
  set: number | null;           // prix de règlement
  pay: number;                  // encaissé à la résolution
  sold: number;                 // cash reçu des ventes
  pnl: number | null;           // PnL net de frais (null si ouverte sans vente)
  roi: number | null;           // pnl / cash
  mk: number | null;            // position ouverte : dernier prix Gamma connu (indicatif, peut dater)
  warn?: string;
  f: DashFill[];
}

export interface DashMatch {
  slug: string;                 // slug de l'événement → https://polymarket.com/event/<slug>
  title: string;                // titre brut de l'événement
  match: string;                // "G2 vs Falcons"
  fmt: string | null;           // "BO3"
  tour: string;                 // tournoi
  start: number | null;         // début prévu (s)
  cs2: 0 | 1;
  p: number[];                  // index dans DashboardData.pos
  cash: number;                 // mise totale sur le match
  pnl: number;                  // PnL des positions closes du match
  open: number;                 // nombre de positions ouvertes
}

/** Ligne de ventilation (positions closes uniquement). */
export interface DashBreakdownRow {
  k: string;                    // clé (type de marché, PRE/LIVE/?, taker/maker, tranche, mois AAAA-MM)
  l: string;                    // libellé FR
  n: number;                    // positions concernées
  st: number;                   // mise (cash) attribuée
  pnl: number;                  // PnL attribué (au prorata du cash pour PRE/LIVE et maker/taker)
  roi: number | null;
  w: number; lo: number; v: number; // gagnées / perdues / remboursées (non renseigné au prorata : positions touchées)
}

export interface DashStats {
  n_pos: number; n_open: number; n_closed: number; n_fills: number; n_matches: number;
  won: number; lost: number; void: number; sold: number;
  /** Mise totale (cash, frais inclus), positions ouvertes comprises. */
  staked: number;
  /** Mise des positions closes / des positions ouvertes. */
  staked_closed: number; staked_open: number;
  fees: number;
  /** PnL des positions closes, net de frais, hors rebates. */
  pnl: number;
  /** pnl / staked_closed. */
  roi: number | null;
  /** won / (won + lost). */
  win_rate: number | null;
  /** Rebates, comptés à part (jamais attribués à un pari). */
  rebates_taker: number; rebates_maker: number;
  pnl_with_rebates: number;
  deposits: number; withdrawals: number;
  first_ts: number | null; last_ts: number | null;
}

export interface DashAlert {
  id: string;
  k: AlertKind;
  tok: string;                  // token_id (→ DashPosition.id)
  ts: number;                   // envoi confirmé par Telegram
  tf: number;                   // horodatage bloc du premier fill du lot (RESULT : résolution)
  td: number;                   // première détection par le moniteur
  n: number;                    // fills couverts
  usd: number;                  // cash du lot
  ld: number;                   // latence fill → détection (s)
  ls: number;                   // latence détection → envoi (s), regroupement inclus
  ok: 0 | 1;                    // 1 = Telegram ok ; 0 = DRY_RUN
  test: 0 | 1;
  title: string;
  text: string;
  ask: number | null;           // meilleur ask à l'envoi
  avail: number | null;         // $ disponibles jusqu'au prix limite
}

export interface DashboardData {
  v: 1;
  gen: number;                  // génération (s)
  wallet: string;
  tz: string;
  cfg: { initial_window_s: number; buckets: number[] };
  /** Santé du moniteur à la génération ; `site/heartbeat.json` est plus frais (toutes les 5 min). */
  health: Heartbeat | null;
  stats: DashStats;
  by: { type: DashBreakdownRow[]; phase: DashBreakdownRow[]; role: DashBreakdownRow[]; bucket: DashBreakdownRow[]; month: DashBreakdownRow[] };
  /** Courbe de PnL cumulé : [ts de résolution, PnL cumulé hors rebates, PnL cumulé rebates inclus]. */
  eq: [number, number, number][];
  matches: DashMatch[];         // du plus récent au plus ancien
  pos: DashPosition[];          // du plus récent (dernier fill) au plus ancien
  alerts: DashAlert[];          // les plus récentes d'abord (cfg ALERT_LOG_MAX)
}
