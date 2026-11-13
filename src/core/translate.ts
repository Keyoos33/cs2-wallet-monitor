// Traduction FR exacte d'un pari Polymarket Counter-Strike 2 (marché + issue).
//
// Règle d'or : on ne devine JAMAIS. Chaque type de marché est reconnu par la
// conjonction de `sportsMarketType`, d'un motif strict sur `question`, de la
// forme de `outcomes` et (quand il y en a une) de la cohérence de `line`.
// Si un seul de ces contrôles échoue, on retombe sur l'intitulé brut anglais
// avec `exact:false`.
//
// La taxonomie, les preuves (marchés clos : score final vs résolution) et les
// ambiguïtés tranchées sont documentées dans docs/MARKET_TYPES.md.
//
// Code PUR : aucun accès réseau ni disque.

import type { BetDescription, MarketMeta } from './types.ts';

/** Libellés FR des clés de type (`BetDescription.marketTypeKey`). */
export const MARKET_TYPE_LABELS_FR: Record<string, string> = {
  match_winner: 'Vainqueur du match',
  map_winner: "Vainqueur d'une carte",
  map_handicap: 'Handicap de cartes',
  total_maps: 'Nombre de cartes (plus/moins)',
  total_rounds_map: 'Total de rounds sur une carte (plus/moins)',
  round_handicap_map: 'Handicap de rounds sur une carte',
  odd_even_rounds_map: 'Total de rounds pair/impair sur une carte',
  odd_even_kills_map: 'Total de kills pair/impair sur une carte',
  total_rounds_match: 'Total de rounds sur le match entier (plus/moins)',
  round_handicap_match: 'Handicap de rounds sur le match entier',
  exact_maps_won: 'Nombre exact de cartes gagnées',
  match_result_bo2: 'Résultat du match (BO2)',
  outright: 'Vainqueur du tournoi',
  other: 'Autre marché (non traduit)',
  unknown: 'Marché non reconnu',
};

// ───────────────────────── utilitaires ─────────────────────────

/** Espaces normalisés (Gamma contient des doubles espaces et des espaces en tête). */
function norm(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Clé de comparaison de noms : espaces normalisés, casse ignorée. */
function key(s: string): string {
  return norm(s).toLowerCase();
}

/** Nombre au format français : 1.5 → "1,5". */
function frNum(n: number): string {
  return String(n).replace('.', ',');
}

/** Nombre signé au format français : -1.5 → "-1,5" ; 1.5 → "+1,5". */
function frSigned(n: number): string {
  return (n < 0 ? '-' : '+') + frNum(Math.abs(n));
}

/** "carte" jusqu'à 1,5 inclus, "cartes" à partir de 2 (règle française). */
function cartes(n: number): string {
  return Math.abs(n) >= 2 ? 'cartes' : 'carte';
}

const NUM = String.raw`\d+(?:\.\d+)?`;
const SIGNED = String.raw`[+-]\d+(?:\.\d+)?`;

/** Vrai pour x,5 (pas de remboursement possible : la ligne ne peut pas tomber pile). */
function isHalf(n: number): boolean {
  return Number.isFinite(n) && Math.abs(n * 2) % 2 === 1;
}

const RESERVED = new Set(['yes', 'no', 'over', 'under', 'odd', 'even']);

/** Les deux issues sont-elles deux noms d'équipes distincts (et pas Yes/No, Over/Under…) ? */
function teamOutcomes(outcomes: string[]): [string, string] | null {
  if (outcomes.length !== 2) return null;
  const a = norm(outcomes[0] ?? '');
  const b = norm(outcomes[1] ?? '');
  if (!a || !b || key(a) === key(b)) return null;
  if (RESERVED.has(key(a)) || RESERVED.has(key(b))) return null;
  return [a, b];
}

function outcomesAre(outcomes: string[], a: string, b: string): boolean {
  return outcomes.length === 2 && outcomes[0] === a && outcomes[1] === b;
}

/** Préfixe de jeu des titres/questions Gamma ("Counter-Strike: …"). */
const GAME_PREFIX = /^(?:Counter-Strike(?: 2)?|CS2|CS:GO)\s*:\s*/i;

const VS = /\s+vs\.?\s+/g;

// ───────────────────────── titre d'événement ─────────────────────────

export interface ParsedEventTitle {
  /** "ex-RUSTEC vs Nexus" (ou le titre entier si ce n'est pas un match A vs B). */
  match: string;
  /** Les deux équipes dans l'ordre du titre ; null si non déterminable avec certitude. */
  teams: [string, string] | null;
  /** "BO3" ; null si absent du titre. */
  format: string | null;
  /** "CCT Europe Group Stage" ; "" si absent. */
  tournament: string;
}

/**
 * Découpe le titre en toutes les paires (gauche, droite) possibles autour de
 * chaque " vs ". Un seul " vs " → une seule paire, donc aucune ambiguïté.
 */
function vsSplits(matchPart: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  VS.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = VS.exec(matchPart)) !== null) {
    const left = matchPart.slice(0, m.index).trim();
    const right = matchPart.slice(m.index + m[0].length).trim();
    if (left && right) out.push([left, right]);
  }
  return out;
}

/**
 * Analyse un titre d'événement Gamma, p. ex.
 * "Counter-Strike: ex-RUSTEC vs Nexus (BO3) - CCT Europe Group Stage".
 *
 * - le format est le "(BOx)" qui clôt la partie match (suivi de " - " ou de la fin) ;
 * - le tournoi est TOUT ce qui suit le premier " - " après "(BOx)" (il peut
 *   lui-même contenir " - ") ;
 * - sans "(BOx)", le séparateur est le premier " - " situé après le premier " vs " ;
 * - `teams` vaut null si le découpage autour de " vs " n'est pas unique
 *   (nom d'équipe contenant " vs ") ou si le titre n'est pas un match.
 */
export function parseEventTitle(title: string): ParsedEventTitle {
  const full = norm(title ?? '');
  const body = full.replace(GAME_PREFIX, '');

  VS.lastIndex = 0;
  const firstVs = VS.exec(body);
  if (!firstVs) {
    // Pas un match "A vs B" (vainqueur de tournoi, prop, etc.).
    return { match: full, teams: null, format: null, tournament: '' };
  }

  let matchPart: string;
  let format: string | null = null;
  let tournament = '';

  const bo = /\s*\((BO\d+)\)(?=\s+-\s+|$)/i.exec(body);
  if (bo && bo.index > firstVs.index) {
    matchPart = body.slice(0, bo.index).trim();
    format = (bo[1] as string).toUpperCase();
    tournament = body.slice(bo.index + bo[0].length).replace(/^\s+-\s+/, '').trim();
  } else {
    const from = firstVs.index + firstVs[0].length;
    const sep = body.indexOf(' - ', from);
    if (sep >= 0) {
      matchPart = body.slice(0, sep).trim();
      tournament = body.slice(sep + 3).trim();
    } else {
      matchPart = body.trim();
    }
  }
  // Événements annexes Polymarket : "A vs B - More Markets" n'est pas un tournoi.
  if (/^more markets$/i.test(tournament)) tournament = '';

  const splits = vsSplits(matchPart);
  const teams = splits.length === 1 ? (splits[0] as [string, string]) : null;
  return { match: matchPart, teams, format, tournament };
}

/** "A vs B" correspond-il exactement aux deux issues, dans cet ordre ? */
function isPairing(text: string, a: string, b: string): boolean {
  return vsSplits(norm(text)).some(([l, r]) => key(l) === key(a) && key(r) === key(b));
}

// ───────────────────────── contexte commun ─────────────────────────

interface Ctx {
  meta: MarketMeta;
  question: string; // espaces normalisés
  outcomes: string[];
  idx: number;
  base: Pick<BetDescription, 'match' | 'format' | 'tournament'>;
  /** Nombre de cartes du BO (1, 3, 5, 7) si connu, impair et non contradictoire. */
  bo: number | null;
  /** Cartes à gagner pour remporter le match. */
  need: number | null;
  isMatchEvent: boolean;
}

function exact(c: Ctx, marketTypeKey: string, betFr: string, winConditionFr: string): BetDescription {
  return {
    ...c.base,
    marketTypeKey,
    marketTypeFr: MARKET_TYPE_LABELS_FR[marketTypeKey] as string,
    betFr,
    winConditionFr,
    exact: true,
  };
}

/** Repli : intitulé brut anglais, aucune interprétation. */
function fallback(c: Ctx): BetDescription {
  const marketTypeKey = c.isMatchEvent ? 'unknown' : 'other';
  const raw = c.outcomes[c.idx];
  const outcome = raw === undefined ? `issue n°${c.idx}` : norm(raw);
  const question = c.question || norm(c.meta.eventTitle ?? '');
  return {
    ...c.base,
    marketTypeKey,
    marketTypeFr: MARKET_TYPE_LABELS_FR[marketTypeKey] as string,
    betFr: `${question} → ${outcome}`,
    winConditionFr: `Marché non traduit automatiquement : le pari est gagné si le marché se résout sur « ${outcome} ».`,
    exact: false,
  };
}

/** Note de règlement quand la carte N peut ne pas être jouée. */
function mapMayNotBePlayed(c: Ctx, mapNo: number): string {
  // Format connu : les `need` premières cartes sont toujours jouées.
  // Format inconnu : seule la carte 1 est certaine.
  if (c.need !== null ? mapNo <= c.need : mapNo === 1) return '';
  return ` Si la carte ${mapNo} n'est pas jouée, le marché est réglé à 50-50.`;
}

/** Numéro de carte plausible pour le format ? (1..7, et ≤ BO si connu). */
function mapNoOk(c: Ctx, mapNo: number): boolean {
  if (!Number.isInteger(mapNo) || mapNo < 1 || mapNo > 7) return false;
  return c.bo === null || mapNo <= c.bo;
}

/** Scores finaux possibles "g-p" du vainqueur, pour p dans [from..to]. */
function scores(need: number, from: number, to: number, flip = false): string {
  const list: string[] = [];
  for (let l = from; l <= to; l++) list.push(flip ? `${l}-${need}` : `${need}-${l}`);
  return list.join(' ou ');
}

// ───────────────────────── handicaps (cartes / rounds) ─────────────────────────

interface HandicapSides {
  /** Équipe qui REND le handicap (signe −). */
  fav: string;
  /** Équipe qui REÇOIT le handicap (signe +). */
  dog: string;
  /** Valeur absolue de la ligne (1.5, 3.5…). */
  abs: number;
  /** L'issue choisie est-elle le côté − ? */
  pickedFav: boolean;
}

/**
 * Associe de façon CERTAINE chaque issue à son signe.
 *
 * Constat sur 40 000+ marchés (voir docs) : la question est toujours
 * "<A> (-x.5) vs <B> (+x.5)", `line` = -x.5, `outcomes` = [A, B]. <A> est souvent
 * une ABRÉVIATION (NXS, M8, TS…) sans rapport orthographique fiable avec le nom
 * complet, alors que <B> est toujours le nom complet, identique à outcomes[1].
 *
 * On exige donc : signes (−, +) dans cet ordre, mêmes valeurs absolues, x,5,
 * `line` égale à la valeur négative, <B> strictement égal à outcomes[1] et
 * différent de outcomes[0], et <A> qui ne désigne pas outcomes[1]. L'issue 0 est
 * alors le côté − par élimination (marché binaire). Sinon : null → repli.
 */
function handicapSides(
  c: Ctx,
  qFirst: string,
  sFirst: string,
  qSecond: string | null,
  sSecond: string | null,
): HandicapSides | null {
  const teams = teamOutcomes(c.outcomes);
  if (!teams || (c.idx !== 0 && c.idx !== 1)) return null;
  const [o0, o1] = teams;
  const first = Number(sFirst);
  if (!(first < 0) || !isHalf(first)) return null;
  if (c.meta.line === null || c.meta.line !== first) return null;
  const a = key(qFirst);
  if (qSecond !== null && sSecond !== null) {
    const second = Number(sSecond);
    if (!(second > 0) || second !== -first) return null;
    const b = key(qSecond);
    if (b !== key(o1) || b === key(o0)) return null; // <B> doit être exactement l'issue 1
    if (a === key(o1) || a === b) return null; // <A> ne doit pas désigner l'issue 1
  } else {
    // Ancienne forme à un seul nom ("Map Handicap: X (-1.5)") : pas d'élimination
    // possible, on exige donc le nom complet exact de l'issue 0.
    if (a !== key(o0)) return null;
  }
  return { fav: o0, dog: o1, abs: -first, pickedFav: c.idx === 0 };
}

function describeMapHandicap(c: Ctx): BetDescription | null {
  const two = new RegExp(`^Map Handicap: (.+) \\((${SIGNED})\\) vs\\.? (.+) \\((${SIGNED})\\)$`).exec(c.question);
  const one = two ? null : new RegExp(`^Map Handicap: (.+) \\((${SIGNED})\\)$`).exec(c.question);
  const m = two ?? one;
  if (!m) return null;
  const s = handicapSides(c, m[1] as string, m[2] as string, two ? (m[3] as string) : null, two ? (m[4] as string) : null);
  if (!s) return null;

  const margin = Math.floor(s.abs) + 1; // écart de cartes minimal pour couvrir le −
  // Le format n'est exploité que s'il est compatible avec la ligne.
  const need = c.need !== null && margin <= c.need ? c.need : null;
  const unit = cartes(s.abs);

  if (s.pickedFav) {
    const betFr = `${s.fav} ${frSigned(-s.abs)} ${unit}`;
    const win =
      need !== null
        ? `${s.fav} doit gagner ${scores(need, 0, need - margin)} (${c.base.format} : victoire avec au moins ${margin} cartes d'écart).`
        : `${s.fav} doit gagner le match avec au moins ${margin} cartes d'écart.`;
    return exact(c, 'map_handicap', betFr, win);
  }
  const betFr = `${s.dog} ${frSigned(s.abs)} ${unit}`;
  let win: string;
  if (need !== null) {
    const minMaps = need - margin + 1; // cartes que le + doit gagner au minimum
    const qty = minMaps === 1 ? 'au moins une carte' : `au moins ${minMaps} cartes`;
    const detail =
      minMaps < need
        ? ` (victoire, ou défaite ${scores(need, minMaps, need - 1, true)})`
        : '';
    win = `${s.dog} doit gagner ${qty}${detail} : pari perdu seulement si ${s.fav} gagne ${scores(need, 0, need - margin)}.`;
  } else {
    win = `${s.dog} doit gagner le match, ou le perdre avec moins de ${margin} cartes d'écart.`;
  }
  return exact(c, 'map_handicap', betFr, win);
}

function describeRoundHandicapMap(c: Ctx, typeMapNo: number): BetDescription | null {
  const m = new RegExp(
    `^Map (\\d+) Rounds Handicap: (.+) \\((${SIGNED})\\) vs\\.? (.+) \\((${SIGNED})\\)$`,
  ).exec(c.question);
  if (!m) return null;
  const mapNo = Number(m[1]);
  if (mapNo !== typeMapNo || !mapNoOk(c, mapNo)) return null;
  const s = handicapSides(c, m[2] as string, m[3] as string, m[4] as string, m[5] as string);
  if (!s) return null;
  const margin = Math.floor(s.abs) + 1; // écart de rounds minimal pour couvrir le −
  const note = mapMayNotBePlayed(c, mapNo);
  if (s.pickedFav) {
    // Exemple en temps réglementaire (MR12 : 13 rounds gagnants).
    const ex = margin <= 13 ? ` (ex. 13-${13 - margin} ou mieux)` : '';
    return exact(
      c,
      'round_handicap_map',
      `${s.fav} ${frSigned(-s.abs)} rounds (carte ${mapNo})`,
      `${s.fav} doit gagner la carte ${mapNo} avec au moins ${margin} rounds d'écart${ex}, prolongations incluses.${note}`,
    );
  }
  const ex = margin <= 13 ? ` (ex. défaite ${14 - margin}-13 ou plus serrée)` : '';
  return exact(
    c,
    'round_handicap_map',
    `${s.dog} ${frSigned(s.abs)} rounds (carte ${mapNo})`,
    `${s.dog} doit gagner la carte ${mapNo}, ou la perdre avec au plus ${margin - 1} rounds d'écart${ex}, prolongations incluses.${note}`,
  );
}

function describeRoundHandicapMatch(c: Ctx): BetDescription | null {
  const two = new RegExp(
    `^Series (.+) Rounds Handicap \\((${SIGNED})\\) vs\\.? (.+) \\((${SIGNED})\\)$`,
  ).exec(c.question);
  // Anciennes formes à un seul nom : "Series X Rounds Handicap (-4.5)" / "X Rounds Handicap (-7.5)".
  const one = two ? null : new RegExp(`^(?:Series )?(.+) Rounds Handicap \\((${SIGNED})\\)$`).exec(c.question);
  const m = two ?? one;
  if (!m) return null;
  const s = handicapSides(c, m[1] as string, m[2] as string, two ? (m[3] as string) : null, two ? (m[4] as string) : null);
  if (!s) return null;
  const margin = Math.floor(s.abs) + 1;
  if (s.pickedFav) {
    return exact(
      c,
      'round_handicap_match',
      `${s.fav} ${frSigned(-s.abs)} rounds (match entier)`,
      `${s.fav} doit totaliser au moins ${margin} rounds de plus que ${s.dog} sur l'ensemble des cartes du match.`,
    );
  }
  return exact(
    c,
    'round_handicap_match',
    `${s.dog} ${frSigned(s.abs)} rounds (match entier)`,
    `Sur l'ensemble des cartes du match, ${s.fav} ne doit pas totaliser ${margin} rounds ou plus d'avance sur ${s.dog}.`,
  );
}

// ───────────────────────── plus / moins ─────────────────────────

/** Ligne x,5 lue dans la question et identique à `meta.line` ; null sinon. */
function ouLine(c: Ctx, raw: string): number | null {
  const n = Number(raw);
  if (!isHalf(n) || n <= 0) return null;
  if (c.meta.line === null || c.meta.line !== n) return null;
  if (!outcomesAre(c.outcomes, 'Over', 'Under')) return null;
  if (c.idx !== 0 && c.idx !== 1) return null;
  return n;
}

function describeTotalMaps(c: Ctx): BetDescription | null {
  const m = new RegExp(`^Games Total: O/U (${NUM})$`).exec(c.question);
  if (!m) return null;
  const line = ouLine(c, m[1] as string);
  if (line === null) return null;
  const over = c.idx === 0;
  const k = Math.floor(line) + 1; // nombre de cartes minimal pour "Plus"
  const betFr = `${over ? 'Plus' : 'Moins'} de ${frNum(line)} cartes`;
  // Le format n'est exploité que si la ligne partage réellement les durées possibles.
  const usable = c.bo !== null && c.need !== null && k > c.need && k <= c.bo;
  let win: string;
  if (usable) {
    const need = c.need as number;
    const bo = c.bo as number;
    if (over) {
      const sc = scores(need, k - need, bo - need);
      win =
        k === bo
          ? `Le match doit aller en ${bo} cartes (score final ${sc}, peu importe le vainqueur).`
          : `Il faut au moins ${k} cartes jouées (score final ${sc}, peu importe le vainqueur).`;
    } else {
      const sc = scores(need, 0, k - 1 - need);
      win =
        k - 1 === need
          ? `Le match doit se terminer en ${need} cartes (score final ${sc}, peu importe le vainqueur).`
          : `Il faut au plus ${k - 1} cartes jouées (score final ${sc}, peu importe le vainqueur).`;
    }
  } else {
    win = over
      ? `Il faut au moins ${k} cartes jouées dans le match.`
      : `Il faut au plus ${k - 1} cartes jouées dans le match.`;
  }
  return exact(c, 'total_maps', betFr, win);
}

function describeTotalRoundsMap(c: Ctx, typeMapNo: number): BetDescription | null {
  const m = new RegExp(`^Map (\\d+) Total Rounds: Over/Under (${NUM})$`).exec(c.question);
  if (!m) return null;
  const mapNo = Number(m[1]);
  if (mapNo !== typeMapNo || !mapNoOk(c, mapNo)) return null;
  const line = ouLine(c, m[2] as string);
  if (line === null) return null;
  const over = c.idx === 0;
  const k = Math.floor(line) + 1; // rounds minimum pour "Plus"
  const note = mapMayNotBePlayed(c, mapNo);
  let win: string;
  if (over) {
    // MR12 : 13 rounds gagnants, 24 rounds max sans prolongation, 28 min avec.
    let ex = '';
    if (k >= 13 && k <= 24) ex = ` (ex. 13-${k - 13} ou plus serré)`;
    else if (k >= 25 && k <= 28) ex = ' (la carte doit aller en prolongation)';
    win = `Il faut au moins ${k} rounds joués sur la carte ${mapNo}, prolongations incluses${ex}.${note}`;
  } else {
    let ex = '';
    if (k - 1 >= 13 && k - 1 <= 23) ex = ` (ex. 13-${k - 14} ou plus large)`;
    else if (k - 1 >= 24 && k - 1 <= 27) ex = ' (la carte doit se terminer sans prolongation)';
    win = `Il faut au plus ${k - 1} rounds joués sur la carte ${mapNo}, prolongations incluses${ex}.${note}`;
  }
  return exact(
    c,
    'total_rounds_map',
    `${over ? 'Plus' : 'Moins'} de ${frNum(line)} rounds sur la carte ${mapNo}`,
    win,
  );
}

function describeTotalRoundsMatch(c: Ctx): BetDescription | null {
  const m = new RegExp(`^Total Rounds Over/Under (${NUM})$`).exec(c.question);
  if (!m) return null;
  const line = ouLine(c, m[1] as string);
  if (line === null) return null;
  const over = c.idx === 0;
  const k = Math.floor(line) + 1;
  return exact(
    c,
    'total_rounds_match',
    `${over ? 'Plus' : 'Moins'} de ${frNum(line)} rounds sur le match entier`,
    over
      ? `Il faut au moins ${k} rounds joués au total sur l'ensemble des cartes du match.`
      : `Il faut au plus ${k - 1} rounds joués au total sur l'ensemble des cartes du match.`,
  );
}

// ───────────────────────── pair / impair ─────────────────────────

function describeOddEven(c: Ctx, what: 'rounds' | 'kills'): BetDescription | null {
  const m = /^Map (\d+): Odd\/Even Total (Rounds|Kills)\?$/.exec(c.question);
  if (!m) return null;
  if ((m[2] as string).toLowerCase() !== what) return null;
  const mapNo = Number(m[1]);
  if (!mapNoOk(c, mapNo)) return null;
  if (!outcomesAre(c.outcomes, 'Odd', 'Even') || (c.idx !== 0 && c.idx !== 1)) return null;
  const odd = c.idx === 0;
  const parity = odd ? 'impair' : 'pair';
  const note = mapMayNotBePlayed(c, mapNo);
  if (what === 'rounds') {
    const ex = odd ? '13-10 = 23 rounds' : '13-11 = 24 rounds';
    return exact(
      c,
      'odd_even_rounds_map',
      `Total de rounds ${parity} sur la carte ${mapNo}`,
      `Le nombre total de rounds joués sur la carte ${mapNo} (prolongations incluses) doit être ${parity} (ex. ${ex}).${note}`,
    );
  }
  return exact(
    c,
    'odd_even_kills_map',
    `Total de kills ${parity} sur la carte ${mapNo}`,
    `Le nombre total de kills des deux équipes sur la carte ${mapNo} (prolongations incluses) doit être ${parity}.${note}`,
  );
}

// ───────────────────────── vainqueurs ─────────────────────────

function describeMatchWinner(c: Ctx): BetDescription | null {
  const teams = teamOutcomes(c.outcomes);
  if (!teams || (c.idx !== 0 && c.idx !== 1)) return null;
  // La question doit être "[Counter-Strike: ]A vs B[ (BOx)][ - tournoi]" avec
  // A, B = les deux issues dans l'ordre (c'est le cas de 100 % des moneylines).
  const q = parseEventTitle(c.question);
  if (!isPairing(q.match, teams[0], teams[1])) return null;
  if (/ - Map \d+ Winner$/i.test(c.question)) return null;
  const team = teams[c.idx] as string;
  let win: string;
  if (c.bo === 1) win = `${team} doit gagner l'unique carte du match (BO1).`;
  else if (c.bo !== null && c.need !== null)
    win = `${team} doit remporter le match (${c.base.format} : ${c.need} cartes gagnantes).`;
  else win = `${team} doit remporter le match.`;
  return exact(c, 'match_winner', `${team} gagne le match`, win);
}

/** BO2 : trois marchés Oui/Non ("A to win 2-0?", "Draw (1-1)?", "B to win 2-0?"). */
function describeBo2(c: Ctx): BetDescription | null {
  if (!outcomesAre(c.outcomes, 'Yes', 'No') || (c.idx !== 0 && c.idx !== 1)) return null;
  if (c.base.format !== 'BO2') return null;
  const yes = c.idx === 0;
  const win20 = /^(.+) to win 2-0\?$/.exec(c.question);
  if (win20) {
    const team = norm(win20[1] as string);
    return yes
      ? exact(c, 'match_result_bo2', `${team} gagne 2-0`, `${team} doit gagner les deux cartes du match (BO2).`)
      : exact(
          c,
          'match_result_bo2',
          `${team} ne gagne pas 2-0`,
          `${team} ne doit pas gagner les deux cartes : le match doit finir sur un nul 1-1 ou une défaite 0-2.`,
        );
  }
  if (/^.+ vs\.? .+: Draw \(1-1\)\?$/.test(c.question)) {
    return yes
      ? exact(c, 'match_result_bo2', 'Match nul 1-1', 'Chaque équipe doit gagner une carte (BO2 terminé à 1-1).')
      : exact(
          c,
          'match_result_bo2',
          'Pas de match nul',
          "L'une des deux équipes doit gagner les deux cartes (score final 2-0).",
        );
  }
  return null;
}

function describeMapWinner(c: Ctx): BetDescription | null {
  const teams = teamOutcomes(c.outcomes);
  if (!teams || (c.idx !== 0 && c.idx !== 1)) return null;
  const m = /^(.+) - Map (\d+) Winner$/.exec(c.question);
  if (!m) return null;
  const mapNo = Number(m[2]);
  if (!mapNoOk(c, mapNo)) return null;
  if (!isPairing((m[1] as string).replace(GAME_PREFIX, ''), teams[0], teams[1])) return null;
  const team = teams[c.idx] as string;
  return exact(
    c,
    'map_winner',
    `${team} gagne la carte ${mapNo}`,
    `${team} doit gagner la carte ${mapNo}.${mapMayNotBePlayed(c, mapNo)}`,
  );
}

/** Ancien type : "X to win N maps?" (Oui/Non) = X gagne EXACTEMENT N cartes. */
function describeExactMapsWon(c: Ctx): BetDescription | null {
  if (!outcomesAre(c.outcomes, 'Yes', 'No') || (c.idx !== 0 && c.idx !== 1)) return null;
  const m = /^(.+) to win (\d+) maps\?$/.exec(c.question);
  if (!m) return null;
  const team = norm(m[1] as string);
  const n = Number(m[2]);
  if (c.meta.line !== null && c.meta.line !== n) return null;
  if (n > 7) return null;
  const yes = c.idx === 0;
  const unit = n >= 2 ? 'cartes' : 'carte';
  const betFr = yes ? `${team} gagne exactement ${n} ${unit}` : `${team} ne gagne pas exactement ${n} ${unit}`;
  let win: string;
  if (c.need !== null && n <= c.need) {
    const need = c.need;
    if (n === need) {
      win = yes
        ? `${team} doit remporter le match (${c.base.format} : ${need} cartes gagnées).`
        : `${team} doit perdre le match (${c.base.format}).`;
    } else {
      win = yes
        ? `${team} doit perdre le match ${n}-${need}.`
        : `${team} doit gagner le match, ou le perdre sur un autre score que ${n}-${need}.`;
    }
  } else {
    win = yes
      ? `${team} doit gagner exactement ${n} ${unit} dans le match, ni plus ni moins.`
      : `${team} doit gagner un nombre de cartes différent de ${n} dans le match.`;
  }
  return exact(c, 'exact_maps_won', betFr, win);
}

/** Hors match : "Will X win the <tournoi>?" (Oui/Non). */
function describeOutright(c: Ctx): BetDescription | null {
  if (c.isMatchEvent || c.meta.sportsMarketType) return null;
  if (!outcomesAre(c.outcomes, 'Yes', 'No') || (c.idx !== 0 && c.idx !== 1)) return null;
  const m = /^Will (.+?) win the (.+?)\?$/i.exec(c.question);
  if (!m) return null;
  const team = norm(m[1] as string);
  const tournament = norm(m[2] as string);
  // Lignes génériques ("another team", équipes fictives "A".."E") : pas de phrase exacte.
  if (/^(another|any other|other) /i.test(team) || /^(?:team )?[A-Z]$/i.test(team)) return null;
  // Uniquement un vrai marché "vainqueur du tournoi" : le titre de l'événement
  // doit être "<tournoi>: Winner" et, s'il est renseigné, groupItemTitle = l'équipe.
  const title = key(c.meta.eventTitle ?? '');
  if (title !== key(`${tournament}: Winner`) && title !== key(`${tournament} Winner`)) return null;
  const git = c.meta.groupItemTitle;
  if (git && norm(git) !== '' && key(git) !== key(team)) return null;
  const d: BetDescription = c.idx === 0
    ? exact(c, 'outright', `${team} remporte le tournoi ${tournament}`, `${team} doit remporter le tournoi ${tournament} (1re place).`)
    : exact(c, 'outright', `${team} ne remporte pas le tournoi ${tournament}`, `Toute autre équipe que ${team} doit remporter le tournoi ${tournament}.`);
  return { ...d, tournament };
}

// ───────────────────────── point d'entrée ─────────────────────────

/**
 * Décrit en français, sans ambiguïté, le pari "issue `outcomeIndex` du marché `meta`".
 * `exact:false` ⇒ `betFr` reprend la question anglaise brute + l'issue.
 */
export function describeBet(meta: MarketMeta, outcomeIndex: number): BetDescription {
  const parsed = parseEventTitle(meta.eventTitle ?? '');
  const question = norm(meta.question ?? '');
  const outcomes = Array.isArray(meta.outcomes) ? meta.outcomes : [];

  // Format : celui du titre, sauf si la question en affiche un autre (contradiction).
  let format = parsed.format;
  const qBo = /\((BO\d+)\)/i.exec(question);
  if (format && qBo && (qBo[1] as string).toUpperCase() !== format) format = null;

  let bo: number | null = null;
  if (format) {
    const n = Number(format.slice(2));
    if (n % 2 === 1 && n >= 1 && n <= 7) bo = n;
  }

  const c: Ctx = {
    meta,
    question,
    outcomes,
    idx: outcomeIndex,
    base: { match: parsed.match, format, tournament: parsed.tournament },
    bo,
    need: bo === null ? null : (bo + 1) / 2,
    isMatchEvent: vsSplits(parsed.match).length > 0,
  };

  if (!Number.isInteger(outcomeIndex) || outcomeIndex < 0 || outcomeIndex >= outcomes.length) {
    return fallback(c);
  }

  const type = (meta.sportsMarketType ?? '').toLowerCase();
  let d: BetDescription | null = null;
  let m: RegExpExecArray | null;

  if (!c.isMatchEvent) {
    d = describeOutright(c);
  } else if (type === 'moneyline') {
    d = outcomesAre(outcomes, 'Yes', 'No') ? describeBo2(c) : describeMatchWinner(c);
  } else if (type === 'child_moneyline') {
    d = describeMapWinner(c);
  } else if (type === 'map_handicap') {
    d = describeMapHandicap(c);
  } else if (type === 'totals') {
    d = describeTotalMaps(c);
  } else if ((m = /^round_over_under_game_(\d+)$/.exec(type))) {
    d = describeTotalRoundsMap(c, Number(m[1]));
  } else if ((m = /^round_handicap_game_(\d+)$/.exec(type))) {
    d = describeRoundHandicapMap(c, Number(m[1]));
  } else if (type === 'cs2_odd_even_total_rounds') {
    d = describeOddEven(c, 'rounds');
  } else if (type === 'cs2_odd_even_total_kills') {
    d = describeOddEven(c, 'kills');
  } else if (type === 'round_over_under_match' || type === 'shooter_rounds_total') {
    d = describeTotalRoundsMatch(c);
  } else if (type === 'round_handicap_match' || type === 'shooter_round_handicap') {
    d = describeRoundHandicapMatch(c);
  } else if (type === 'map_participant_win_total') {
    d = describeExactMapsWon(c);
  }

  if (!d) return fallback(c);

  // Titre d'événement périmé (équipe remplacée après la création du marché) :
  // si les issues sont deux équipes qui ne sont pas celles du titre, l'affiche
  // du match reprend les noms du marché, pour rester cohérente avec `betFr`.
  const teams = teamOutcomes(outcomes);
  if (teams && parsed.teams) {
    const title = new Set(parsed.teams.map(key));
    if (!title.has(key(teams[0])) || !title.has(key(teams[1]))) {
      d = { ...d, match: `${teams[0]} vs ${teams[1]}` };
    }
  }
  return d;
}
