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
