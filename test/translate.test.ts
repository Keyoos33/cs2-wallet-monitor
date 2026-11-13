// Tests pilotés par table sur des fixtures RÉELLES de l'API Gamma
// (test/fixtures/markets/*.json = GET /events?slug=…, champs élagués).
import { describe, expect, it } from 'vitest';
import { toMarketMeta } from '../src/core/gamma.ts';
import { MARKET_TYPE_LABELS_FR, describeBet, parseEventTitle } from '../src/core/translate.ts';
import type { MarketMeta } from '../src/core/types.ts';

import fxOddEvenBo3 from './fixtures/markets/cs2-aaa-inf1-2026-03-10.json';
import fxBo2 from './fixtures/markets/cs2-benche-ksm-2026-09-09.json';
import fxBo2More from './fixtures/markets/cs2-benche-ksm-2026-09-09-more-markets.json';
import fxLegacyNoType from './fixtures/markets/cs2-copenhagen-wolves-forze-reload-2025-09-24.json';
import fxLeadingSpace from './fixtures/markets/cs2-csdiil-prime-2026-02-05.json';
import fxLegacyAbbr from './fixtures/markets/cs2-darkkn-o49-2026-01-03.json';
import fxStaleTitle from './fixtures/markets/cs2-eiv-brute-2026-01-15.json';
import fxSeriesOneName from './fixtures/markets/cs2-fut-og1-2026-01-13.json';
import fxLegacyFullName from './fixtures/markets/cs2-got1-dt-2026-01-15.json';
import fxBo1OddEven from './fixtures/markets/cs2-ice-havu-2026-05-21.json';
import fxM8 from './fixtures/markets/cs2-m8-hotu-2026-01-21.json';
import fxBo3Rounds from './fixtures/markets/cs2-mglz-hero-2026-11-02.json';
import fxBo5 from './fixtures/markets/cs2-mglz-mouz-2026-11-08.json';
import fxShooter from './fixtures/markets/cs2-mouz-faze-2025-12-12.json';
import fxBo5Both from './fixtures/markets/cs2-nemi1-ast10-2026-10-04.json';
import fxBoConflict from './fixtures/markets/cs2-nrg-9ine-2026-01-05.json';
import fxBo1 from './fixtures/markets/cs2-phanto-hon1-2026-10-13.json';
import fxRustec from './fixtures/markets/cs2-rustec-nxs1-2026-11-13.json';
import fxSeriesRounds from './fixtures/markets/cs2-tl1-fal2-2026-01-22.json';
import fxTs from './fixtures/markets/cs2-ts7-fal2-2026-04-14.json';
import fxBo1Wallet from './fixtures/markets/cs2-wbta-sawy-2026-10-29.json';
import fxOutright from './fixtures/markets/pgl-major-singapore-2026-winner-1793811600000.json';
import fxProp from './fixtures/markets/will-faze-win-a-tier-1-event-in-2026.json';

interface Fixture {
  event: any;
  markets: any[];
}

const ALL: Record<string, Fixture> = {
  fxOddEvenBo3, fxBo2, fxBo2More, fxLegacyNoType, fxLeadingSpace, fxLegacyAbbr, fxStaleTitle,
  fxSeriesOneName, fxLegacyFullName, fxBo1OddEven, fxM8, fxBo3Rounds, fxBo5, fxShooter, fxBo5Both,
  fxBoConflict, fxBo1, fxRustec, fxSeriesRounds, fxTs, fxBo1Wallet, fxOutright, fxProp,
};

/** Marché d'une fixture, par question exacte (+ 1re issue pour lever les doublons de question). */
function meta(fx: Fixture, question: string, firstOutcome?: string): MarketMeta {
  const found = fx.markets
    .map((m) => toMarketMeta(m, fx.event))
    .filter((m) => m.question === question && (firstOutcome === undefined || m.outcomes[0] === firstOutcome));
  if (found.length === 0) throw new Error(`fixture: marché introuvable: ${question}`);
  return found[0] as MarketMeta;
}

/** Vainqueur réel d'un marché clos (index de l'issue à 1), ou null (ouvert / 50-50). */
function resolvedIndex(fx: Fixture, question: string, firstOutcome?: string): number | null {
  const raw = fx.markets.find(
    (m) => m.question === question && (firstOutcome === undefined || JSON.parse(m.outcomes)[0] === firstOutcome),
  );
  const p = (JSON.parse(raw.outcomePrices) as string[]).map(Number);
  if (!raw.closed) return null;
  return p[0] === 1 && p[1] === 0 ? 0 : p[0] === 0 && p[1] === 1 ? 1 : null;
}

// ─────────────────────────────────────────────────────────────────────────────

describe('toMarketMeta (JSON Gamma brut → MarketMeta)', () => {
  const m = meta(fxRustec, 'Map Handicap: NXS (-1.5) vs ex-RUSTEC (+1.5)');

  it('décode les chaînes JSON et reprend les champs de l\'événement parent', () => {
    expect(m).toEqual({
      conditionId: '0xdc2fbb7bdc4331e3ea483cb8d70e7f3882812c3ec3b29b839d8154ec12964366',
      question: 'Map Handicap: NXS (-1.5) vs ex-RUSTEC (+1.5)',
      slug: 'cs2-rustec-nxs1-2026-11-13-map-handicap-home-1pt5',
      eventSlug: 'cs2-rustec-nxs1-2026-11-13',
      eventTitle: 'Counter-Strike: ex-RUSTEC vs Nexus (BO3) - CCT Europe Group Stage',
      seriesSlug: 'counter-strike',
      sportsMarketType: 'map_handicap',
      line: -1.5,
      outcomes: ['Nexus', 'ex-RUSTEC'],
      tokenIds: m.tokenIds,
      groupItemTitle: 'Map Handicap: NXS (-1.5) vs ex-RUSTEC (+1.5)',
      gameStartTime: '2026-11-13T18:00:00.000Z',
      negRisk: false,
    });
    expect(m.tokenIds).toHaveLength(2);
    expect(m.tokenIds[0]).toMatch(/^\d{60,}$/);
  });

  it('utilise market.events[0] quand l\'événement n\'est pas passé (GET /markets)', () => {
    const raw = { ...fxRustec.markets[0], events: [fxRustec.event] };
    const viaEmbedded = toMarketMeta(raw);
    expect(viaEmbedded.eventSlug).toBe('cs2-rustec-nxs1-2026-11-13');
    expect(viaEmbedded.eventTitle).toBe(fxRustec.event.title);
    expect(viaEmbedded.seriesSlug).toBe('counter-strike');
  });

  it('tolère les champs absents / déjà décodés / illisibles', () => {
    const x = toMarketMeta({ conditionId: '0x1', outcomes: ['A', 'B'], clobTokenIds: 'pas du json', line: '2.5' });
    expect(x.outcomes).toEqual(['A', 'B']);
    expect(x.tokenIds).toEqual([]);
    expect(x.line).toBe(2.5);
    expect(x.sportsMarketType).toBeNull();
    expect(x.seriesSlug).toBeNull();
    expect(x.gameStartTime).toBeNull();
    expect(x.negRisk).toBe(false);
    expect(x.eventTitle).toBe('');
  });

  it('marché sans type ni ligne (vainqueur de tournoi)', () => {
    const o = meta(fxOutright, 'Will FURIA Win the PGL Major Singapore 2026?');
    expect(o.sportsMarketType).toBeNull();
    expect(o.line).toBeNull();
    expect(o.seriesSlug).toBeNull();
    expect(o.outcomes).toEqual(['Yes', 'No']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('parseEventTitle', () => {
  const cases: Array<[string, ReturnType<typeof parseEventTitle>]> = [
    // titres réels
    [
      'Counter-Strike: ex-RUSTEC vs Nexus (BO3) - CCT Europe Group Stage',
      { match: 'ex-RUSTEC vs Nexus', teams: ['ex-RUSTEC', 'Nexus'], format: 'BO3', tournament: 'CCT Europe Group Stage' },
    ],
    [
      'Counter-Strike: TheMongolz vs MOUZ (BO5) - IEM Beijing Playoffs',
      { match: 'TheMongolz vs MOUZ', teams: ['TheMongolz', 'MOUZ'], format: 'BO5', tournament: 'IEM Beijing Playoffs' },
    ],
    // double espace + espace en tête du nom (réel)
    [
      'Counter-Strike:  Phantom Academy vs Honvéd (BO1) - ESEA Advanced Europe Regular Season',
      { match: 'Phantom Academy vs Honvéd', teams: ['Phantom Academy', 'Honvéd'], format: 'BO1', tournament: 'ESEA Advanced Europe Regular Season' },
    ],
    // double espace avant (BOx) (réel)
    [
      'Counter-Strike: Nice Try vs Nordic Partners Gaming  (BO1) - PGL Masters European Open Qualifier #1 Playoffs',
      { match: 'Nice Try vs Nordic Partners Gaming', teams: ['Nice Try', 'Nordic Partners Gaming'], format: 'BO1', tournament: 'PGL Masters European Open Qualifier #1 Playoffs' },
    ],
    // tournoi contenant ":" et "#" (réel)
    [
      'Counter-Strike: Benched gods vs KUUSAMO.gg (BO2) - Exort Fiesta Closed Qualifier: Series #2 Group D',
      { match: 'Benched gods vs KUUSAMO.gg', teams: ['Benched gods', 'KUUSAMO.gg'], format: 'BO2', tournament: 'Exort Fiesta Closed Qualifier: Series #2 Group D' },
    ],
    // (BOx) sans tournoi (réel, 2025)
    ['Counter-Strike: MOUZ vs FaZe (BO3)', { match: 'MOUZ vs FaZe', teams: ['MOUZ', 'FaZe'], format: 'BO3', tournament: '' }],
    // ni (BOx) ni tournoi (réel, sept. 2025)
    [
      'Counter-Strike: Copenhagen Wolves vs FORZE Reload',
      { match: 'Copenhagen Wolves vs FORZE Reload', teams: ['Copenhagen Wolves', 'FORZE Reload'], format: null, tournament: '' },
    ],
    // événement annexe "More Markets" (réel) : ce n'est pas un tournoi
    [
      'Counter-Strike: Benched gods vs KUUSAMO.gg - More Markets',
      { match: 'Benched gods vs KUUSAMO.gg', teams: ['Benched gods', 'KUUSAMO.gg'], format: null, tournament: '' },
    ],
    // nom d'équipe terminé par un tiret (réel : "OLDBOYS-")
    [
      'Counter-Strike: OLDBOYS- vs Peekaboo (BO1) - ESEA Advanced Europe Regular Season',
      { match: 'OLDBOYS- vs Peekaboo', teams: ['OLDBOYS-', 'Peekaboo'], format: 'BO1', tournament: 'ESEA Advanced Europe Regular Season' },
    ],
    // tirets et préfixes "ex-" dans les deux noms
    [
      'Counter-Strike: ex-Zero Tenacity vs ex-Imperial Valkyries (BO3) - CCT Europe Closed Qualifier: Series #3 Group C',
      { match: 'ex-Zero Tenacity vs ex-Imperial Valkyries', teams: ['ex-Zero Tenacity', 'ex-Imperial Valkyries'], format: 'BO3', tournament: 'CCT Europe Closed Qualifier: Series #3 Group C' },
    ],
    // tournoi contenant " - " : tout ce qui suit le PREMIER " - " après (BOx)
    [
      'Counter-Strike: FURIA vs Vitality (BO3) - BLAST Open - Spring Finals - Group A',
      { match: 'FURIA vs Vitality', teams: ['FURIA', 'Vitality'], format: 'BO3', tournament: 'BLAST Open - Spring Finals - Group A' },
    ],
    // sans (BOx) : séparateur = premier " - " APRÈS le " vs " (nom d'équipe avec " - ")
    [
      'Counter-Strike: Alpha - Red vs Beta - ESL Pro League - Group B',
      { match: 'Alpha - Red vs Beta', teams: ['Alpha - Red', 'Beta'], format: null, tournament: 'ESL Pro League - Group B' },
    ],
    // nom d'équipe contenant " vs " : découpage non unique ⇒ teams = null, match intact
    [
      'Counter-Strike: Us vs Them vs NAVI (BO3) - IEM Katowice',
      { match: 'Us vs Them vs NAVI', teams: null, format: 'BO3', tournament: 'IEM Katowice' },
    ],
    // "vs." et casse du format
    [
      'Counter-Strike: G2 vs. FaZe (bo5) - Major Final',
      { match: 'G2 vs. FaZe', teams: ['G2', 'FaZe'], format: 'BO5', tournament: 'Major Final' },
    ],
    // sans préfixe de jeu
    ['Astralis vs fnatic (BO3)', { match: 'Astralis vs fnatic', teams: ['Astralis', 'fnatic'], format: 'BO3', tournament: '' }],
    // "(BO3)" dans le nom du tournoi mais pas à la fin de la partie match
    [
      'Counter-Strike: A1 vs B2 - Cup (BO3) Finals',
      { match: 'A1 vs B2', teams: ['A1', 'B2'], format: null, tournament: 'Cup (BO3) Finals' },
    ],
    // pas un match (réels)
    ['PGL Major Singapore 2026: Winner', { match: 'PGL Major Singapore 2026: Winner', teams: null, format: null, tournament: '' }],
    ['Will FaZe win a Tier 1 event in 2026? ', { match: 'Will FaZe win a Tier 1 event in 2026?', teams: null, format: null, tournament: '' }],
    ['', { match: '', teams: null, format: null, tournament: '' }],
  ];
  it.each(cases)('%s', (title, expected) => {
    expect(parseEventTitle(title)).toEqual(expected);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

type Row = [
  label: string,
  fx: Fixture,
  question: string,
  firstOutcome: string | undefined,
  idx: number,
  key: string,
  betFr: string,
  winFr: string,
];

const RUSTEC_ML = 'Counter-Strike: ex-RUSTEC vs Nexus (BO3) - CCT Europe Group Stage';
const BO5_ML = 'Counter-Strike: TheMongolz vs MOUZ (BO5) - IEM Beijing Playoffs';
const NOT_PLAYED = (n: number) => ` Si la carte ${n} n'est pas jouée, le marché est réglé à 50-50.`;

const EXACT_ROWS: Row[] = [
  // ── match_winner (moneyline) : BO1 / BO3 / BO5, les deux issues
  ['BO3 #0', fxRustec, RUSTEC_ML, undefined, 0, 'match_winner', 'ex-RUSTEC gagne le match', 'ex-RUSTEC doit remporter le match (BO3 : 2 cartes gagnantes).'],
  ['BO3 #1', fxRustec, RUSTEC_ML, undefined, 1, 'match_winner', 'Nexus gagne le match', 'Nexus doit remporter le match (BO3 : 2 cartes gagnantes).'],
  ['BO5 #0', fxBo5, BO5_ML, undefined, 0, 'match_winner', 'TheMongolz gagne le match', 'TheMongolz doit remporter le match (BO5 : 3 cartes gagnantes).'],
  ['BO5 #1', fxBo5, BO5_ML, undefined, 1, 'match_winner', 'MOUZ gagne le match', 'MOUZ doit remporter le match (BO5 : 3 cartes gagnantes).'],
  ['BO1 #0 (pari réel du wallet)', fxBo1Wallet, 'Counter-Strike: WBT Academy vs SAW Youngsters (BO1) - Circuito Retake Group A', undefined, 0, 'match_winner', 'WBT Academy gagne le match', "WBT Academy doit gagner l'unique carte du match (BO1)."],
  ['BO1 #1', fxBo1Wallet, 'Counter-Strike: WBT Academy vs SAW Youngsters (BO1) - Circuito Retake Group A', undefined, 1, 'match_winner', 'SAW Youngsters gagne le match', "SAW Youngsters doit gagner l'unique carte du match (BO1)."],
  ['BO1, nom avec espace en tête', fxBo1, 'Counter-Strike:  Phantom Academy vs Honvéd (BO1) - ESEA Advanced Europe Regular Season', undefined, 0, 'match_winner', 'Phantom Academy gagne le match', "Phantom Academy doit gagner l'unique carte du match (BO1)."],

  // ── map_winner (child_moneyline)
  ['carte 1 #0', fxRustec, 'Counter-Strike: ex-RUSTEC vs Nexus - Map 1 Winner', undefined, 0, 'map_winner', 'ex-RUSTEC gagne la carte 1', 'ex-RUSTEC doit gagner la carte 1.'],
  ['carte 2 #1', fxRustec, 'Counter-Strike: ex-RUSTEC vs Nexus - Map 2 Winner', undefined, 1, 'map_winner', 'Nexus gagne la carte 2', 'Nexus doit gagner la carte 2.'],
  ['BO5 carte 3 (toujours jouée)', fxBo5, 'Counter-Strike: TheMongolz vs MOUZ - Map 3 Winner', undefined, 1, 'map_winner', 'MOUZ gagne la carte 3', 'MOUZ doit gagner la carte 3.'],
  ['BO5 carte 4 (peut ne pas être jouée)', fxBo5, 'Counter-Strike: TheMongolz vs MOUZ - Map 4 Winner', undefined, 0, 'map_winner', 'TheMongolz gagne la carte 4', 'TheMongolz doit gagner la carte 4.' + NOT_PLAYED(4)],
  ['format inconnu ("More Markets"), carte 1', fxBo2More, 'Counter-Strike: Benched gods vs KUUSAMO.gg - Map 1 Winner', undefined, 1, 'map_winner', 'KUUSAMO.gg gagne la carte 1', 'KUUSAMO.gg doit gagner la carte 1.'],
  ['format inconnu ("More Markets"), carte 2', fxBo2More, 'Counter-Strike: Benched gods vs KUUSAMO.gg - Map 2 Winner', undefined, 0, 'map_winner', 'Benched gods gagne la carte 2', 'Benched gods doit gagner la carte 2.' + NOT_PLAYED(2)],

  // ── total_maps (totals)
  ['BO3 2,5 Plus', fxRustec, 'Games Total: O/U 2.5', undefined, 0, 'total_maps', 'Plus de 2,5 cartes', 'Le match doit aller en 3 cartes (score final 2-1, peu importe le vainqueur).'],
  ['BO3 2,5 Moins', fxRustec, 'Games Total: O/U 2.5', undefined, 1, 'total_maps', 'Moins de 2,5 cartes', 'Le match doit se terminer en 2 cartes (score final 2-0, peu importe le vainqueur).'],
  ['BO5 3,5 Plus', fxBo5, 'Games Total: O/U 3.5', undefined, 0, 'total_maps', 'Plus de 3,5 cartes', 'Il faut au moins 4 cartes jouées (score final 3-1 ou 3-2, peu importe le vainqueur).'],
  ['BO5 3,5 Moins (pari réel du wallet)', fxBo5, 'Games Total: O/U 3.5', undefined, 1, 'total_maps', 'Moins de 3,5 cartes', 'Le match doit se terminer en 3 cartes (score final 3-0, peu importe le vainqueur).'],
  ['BO5 4,5 Plus', fxBo5, 'Games Total: O/U 4.5', undefined, 0, 'total_maps', 'Plus de 4,5 cartes', 'Le match doit aller en 5 cartes (score final 3-2, peu importe le vainqueur).'],
  ['BO5 4,5 Moins', fxBo5, 'Games Total: O/U 4.5', undefined, 1, 'total_maps', 'Moins de 4,5 cartes', 'Il faut au plus 4 cartes jouées (score final 3-0 ou 3-1, peu importe le vainqueur).'],

  // ── map_handicap : abréviation dans la question, nom complet dans les issues
  ['BO3 NXS → Nexus −1,5', fxRustec, 'Map Handicap: NXS (-1.5) vs ex-RUSTEC (+1.5)', undefined, 0, 'map_handicap', 'Nexus -1,5 carte', "Nexus doit gagner 2-0 (BO3 : victoire avec au moins 2 cartes d'écart)."],
  ['BO3 ex-RUSTEC +1,5', fxRustec, 'Map Handicap: NXS (-1.5) vs ex-RUSTEC (+1.5)', undefined, 1, 'map_handicap', 'ex-RUSTEC +1,5 carte', 'ex-RUSTEC doit gagner au moins une carte (victoire, ou défaite 1-2) : pari perdu seulement si Nexus gagne 2-0.'],
  ['BO5 −1,5', fxBo5, 'Map Handicap: MOUZ (-1.5) vs TheMongolz (+1.5)', undefined, 0, 'map_handicap', 'MOUZ -1,5 carte', "MOUZ doit gagner 3-0 ou 3-1 (BO5 : victoire avec au moins 2 cartes d'écart)."],
  ['BO5 +1,5', fxBo5, 'Map Handicap: MOUZ (-1.5) vs TheMongolz (+1.5)', undefined, 1, 'map_handicap', 'TheMongolz +1,5 carte', 'TheMongolz doit gagner au moins 2 cartes (victoire, ou défaite 2-3) : pari perdu seulement si MOUZ gagne 3-0 ou 3-1.'],
  ['BO5 −2,5 (pari réel du wallet)', fxBo5, 'Map Handicap: MOUZ (-2.5) vs TheMongolz (+2.5)', undefined, 0, 'map_handicap', 'MOUZ -2,5 cartes', "MOUZ doit gagner 3-0 (BO5 : victoire avec au moins 3 cartes d'écart)."],
  ['BO5 +2,5', fxBo5, 'Map Handicap: MOUZ (-2.5) vs TheMongolz (+2.5)', undefined, 1, 'map_handicap', 'TheMongolz +2,5 cartes', 'TheMongolz doit gagner au moins une carte (victoire, ou défaite 1-3 ou 2-3) : pari perdu seulement si MOUZ gagne 3-0.'],
  ['abréviation M8 → Gentle Mates', fxM8, 'Map Handicap: M8 (-1.5) vs HOTU (+1.5)', undefined, 0, 'map_handicap', 'Gentle Mates -1,5 carte', "Gentle Mates doit gagner 2-0 (BO3 : victoire avec au moins 2 cartes d'écart)."],
  ['abréviation M8, côté +', fxM8, 'Map Handicap: M8 (-1.5) vs HOTU (+1.5)', undefined, 1, 'map_handicap', 'HOTU +1,5 carte', 'HOTU doit gagner au moins une carte (victoire, ou défaite 1-2) : pari perdu seulement si Gentle Mates gagne 2-0.'],
  ['abréviation TS → Spirit (lettres présentes dans "Team Falcons")', fxTs, 'Map Handicap: TS (-1.5) vs Team Falcons (+1.5)', undefined, 0, 'map_handicap', 'Spirit -1,5 carte', "Spirit doit gagner 2-0 (BO3 : victoire avec au moins 2 cartes d'écart)."],
  ['abréviation TS, côté +', fxTs, 'Map Handicap: TS (-1.5) vs Team Falcons (+1.5)', undefined, 1, 'map_handicap', 'Team Falcons +1,5 carte', 'Team Falcons doit gagner au moins une carte (victoire, ou défaite 1-2) : pari perdu seulement si Spirit gagne 2-0.'],
  ['marché miroir FAL −1,5', fxTs, 'Map Handicap: FAL (-1.5) vs Spirit (+1.5)', undefined, 0, 'map_handicap', 'Team Falcons -1,5 carte', "Team Falcons doit gagner 2-0 (BO3 : victoire avec au moins 2 cartes d'écart)."],
  ['marché miroir, Spirit +1,5', fxTs, 'Map Handicap: FAL (-1.5) vs Spirit (+1.5)', undefined, 1, 'map_handicap', 'Spirit +1,5 carte', 'Spirit doit gagner au moins une carte (victoire, ou défaite 1-2) : pari perdu seulement si Team Falcons gagne 2-0.'],
  ['issue avec espace en tête (" CSDIILIT")', fxLeadingSpace, 'Map Handicap: PRIME (-1.5) vs  CSDIILIT (+1.5)', undefined, 1, 'map_handicap', 'CSDIILIT +1,5 carte', 'CSDIILIT doit gagner au moins une carte (victoire, ou défaite 1-2) : pari perdu seulement si PRIME gagne 2-0.'],
  ['ancienne forme à un nom, nom complet exact', fxLegacyFullName, 'Map Handicap: gothboiclique (-1.5)', undefined, 0, 'map_handicap', 'gothboiclique -1,5 carte', "gothboiclique doit gagner 2-0 (BO3 : victoire avec au moins 2 cartes d'écart)."],
  ['ancienne forme à un nom, côté +', fxLegacyFullName, 'Map Handicap: gothboiclique (-1.5)', undefined, 1, 'map_handicap', 'Dark Tigers +1,5 carte', 'Dark Tigers doit gagner au moins une carte (victoire, ou défaite 1-2) : pari perdu seulement si gothboiclique gagne 2-0.'],

  // ── total_rounds_map (round_over_under_game_N)
  ['carte 1, 21,5 Plus', fxRustec, 'Map 1 Total Rounds: Over/Under 21.5', undefined, 0, 'total_rounds_map', 'Plus de 21,5 rounds sur la carte 1', 'Il faut au moins 22 rounds joués sur la carte 1, prolongations incluses (ex. 13-9 ou plus serré).'],
  ['carte 1, 21,5 Moins', fxRustec, 'Map 1 Total Rounds: Over/Under 21.5', undefined, 1, 'total_rounds_map', 'Moins de 21,5 rounds sur la carte 1', 'Il faut au plus 21 rounds joués sur la carte 1, prolongations incluses (ex. 13-8 ou plus large).'],
  ['carte 3 d\'un BO3 (peut ne pas être jouée)', fxRustec, 'Map 3 Total Rounds: Over/Under 21.5', undefined, 0, 'total_rounds_map', 'Plus de 21,5 rounds sur la carte 3', 'Il faut au moins 22 rounds joués sur la carte 3, prolongations incluses (ex. 13-9 ou plus serré).' + NOT_PLAYED(3)],
  ['24,5 Plus = prolongation', fxBo3Rounds, 'Map 1 Total Rounds: Over/Under 24.5', undefined, 0, 'total_rounds_map', 'Plus de 24,5 rounds sur la carte 1', 'Il faut au moins 25 rounds joués sur la carte 1, prolongations incluses (la carte doit aller en prolongation).'],
  ['24,5 Moins = sans prolongation', fxBo3Rounds, 'Map 1 Total Rounds: Over/Under 24.5', undefined, 1, 'total_rounds_map', 'Moins de 24,5 rounds sur la carte 1', 'Il faut au plus 24 rounds joués sur la carte 1, prolongations incluses (la carte doit se terminer sans prolongation).'],
  ['18,5 Moins', fxBo3Rounds, 'Map 1 Total Rounds: Over/Under 18.5', undefined, 1, 'total_rounds_map', 'Moins de 18,5 rounds sur la carte 1', 'Il faut au plus 18 rounds joués sur la carte 1, prolongations incluses (ex. 13-5 ou plus large).'],
  ['BO5 carte 5', fxBo5, 'Map 5 Total Rounds: Over/Under 21.5', undefined, 1, 'total_rounds_map', 'Moins de 21,5 rounds sur la carte 5', 'Il faut au plus 21 rounds joués sur la carte 5, prolongations incluses (ex. 13-8 ou plus large).' + NOT_PLAYED(5)],
  ['BO1 carte 1', fxBo1, 'Map 1 Total Rounds: Over/Under 21.5', undefined, 0, 'total_rounds_map', 'Plus de 21,5 rounds sur la carte 1', 'Il faut au moins 22 rounds joués sur la carte 1, prolongations incluses (ex. 13-9 ou plus serré).'],

  // ── round_handicap_map (round_handicap_game_N)
  ['carte 1 −3,5', fxBo3Rounds, 'Map 1 Rounds Handicap: TheMongolz (-3.5) vs Heroic (+3.5)', undefined, 0, 'round_handicap_map', 'TheMongolz -3,5 rounds (carte 1)', "TheMongolz doit gagner la carte 1 avec au moins 4 rounds d'écart (ex. 13-9 ou mieux), prolongations incluses."],
  ['carte 1 +3,5 (pari réel du wallet)', fxBo3Rounds, 'Map 1 Rounds Handicap: TheMongolz (-3.5) vs Heroic (+3.5)', undefined, 1, 'round_handicap_map', 'Heroic +3,5 rounds (carte 1)', "Heroic doit gagner la carte 1, ou la perdre avec au plus 3 rounds d'écart (ex. défaite 10-13 ou plus serrée), prolongations incluses."],
  ['marché miroir carte 1', fxBo3Rounds, 'Map 1 Rounds Handicap: Heroic (-3.5) vs TheMongolz (+3.5)', undefined, 0, 'round_handicap_map', 'Heroic -3,5 rounds (carte 1)', "Heroic doit gagner la carte 1 avec au moins 4 rounds d'écart (ex. 13-9 ou mieux), prolongations incluses."],
  ['carte 1 −6,5', fxBo3Rounds, 'Map 1 Rounds Handicap: TheMongolz (-6.5) vs Heroic (+6.5)', undefined, 0, 'round_handicap_map', 'TheMongolz -6,5 rounds (carte 1)', "TheMongolz doit gagner la carte 1 avec au moins 7 rounds d'écart (ex. 13-6 ou mieux), prolongations incluses."],
  ['carte 1 +6,5', fxBo3Rounds, 'Map 1 Rounds Handicap: TheMongolz (-6.5) vs Heroic (+6.5)', undefined, 1, 'round_handicap_map', 'Heroic +6,5 rounds (carte 1)', "Heroic doit gagner la carte 1, ou la perdre avec au plus 6 rounds d'écart (ex. défaite 7-13 ou plus serrée), prolongations incluses."],
  ['carte 3 d\'un BO3', fxBo3Rounds, 'Map 3 Rounds Handicap: Heroic (-3.5) vs TheMongolz (+3.5)', undefined, 1, 'round_handicap_map', 'TheMongolz +3,5 rounds (carte 3)', "TheMongolz doit gagner la carte 3, ou la perdre avec au plus 3 rounds d'écart (ex. défaite 10-13 ou plus serrée), prolongations incluses." + NOT_PLAYED(3)],
  ['BO5 carte 4', fxBo5, 'Map 4 Rounds Handicap: MOUZ (-3.5) vs TheMongolz (+3.5)', undefined, 0, 'round_handicap_map', 'MOUZ -3,5 rounds (carte 4)', "MOUZ doit gagner la carte 4 avec au moins 4 rounds d'écart (ex. 13-9 ou mieux), prolongations incluses." + NOT_PLAYED(4)],
  ['BO1, nom avec espace en tête', fxBo1, 'Map 1 Rounds Handicap:  Phantom Academy (-3.5) vs Honvéd (+3.5)', undefined, 0, 'round_handicap_map', 'Phantom Academy -3,5 rounds (carte 1)', "Phantom Academy doit gagner la carte 1 avec au moins 4 rounds d'écart (ex. 13-9 ou mieux), prolongations incluses."],

  // ── pair / impair
  ['rounds impair', fxBo1OddEven, 'Map 1: Odd/Even Total Rounds?', undefined, 0, 'odd_even_rounds_map', 'Total de rounds impair sur la carte 1', 'Le nombre total de rounds joués sur la carte 1 (prolongations incluses) doit être impair (ex. 13-10 = 23 rounds).'],
  ['rounds pair', fxBo1OddEven, 'Map 1: Odd/Even Total Rounds?', undefined, 1, 'odd_even_rounds_map', 'Total de rounds pair sur la carte 1', 'Le nombre total de rounds joués sur la carte 1 (prolongations incluses) doit être pair (ex. 13-11 = 24 rounds).'],
  ['kills impair', fxBo1OddEven, 'Map 1: Odd/Even Total Kills?', undefined, 0, 'odd_even_kills_map', 'Total de kills impair sur la carte 1', 'Le nombre total de kills des deux équipes sur la carte 1 (prolongations incluses) doit être impair.'],
  ['kills pair, carte 3 d\'un BO3', fxOddEvenBo3, 'Map 3: Odd/Even Total Kills?', undefined, 1, 'odd_even_kills_map', 'Total de kills pair sur la carte 3', 'Le nombre total de kills des deux équipes sur la carte 3 (prolongations incluses) doit être pair.' + NOT_PLAYED(3)],

  // ── anciens types « match entier » (déc. 2025 – janv. 2026)
  ['total rounds match Plus', fxSeriesRounds, 'Total Rounds Over/Under 49.5', undefined, 0, 'total_rounds_match', 'Plus de 49,5 rounds sur le match entier', "Il faut au moins 50 rounds joués au total sur l'ensemble des cartes du match."],
  ['total rounds match Moins (shooter_rounds_total)', fxShooter, 'Total Rounds Over/Under 52.5', undefined, 1, 'total_rounds_match', 'Moins de 52,5 rounds sur le match entier', "Il faut au plus 52 rounds joués au total sur l'ensemble des cartes du match."],
  ['handicap rounds match −8,5', fxSeriesRounds, 'Series Team Falcons Rounds Handicap (-8.5) vs Liquid (+8.5)', undefined, 0, 'round_handicap_match', 'Team Falcons -8,5 rounds (match entier)', "Team Falcons doit totaliser au moins 9 rounds de plus que Liquid sur l'ensemble des cartes du match."],
  ['handicap rounds match +8,5', fxSeriesRounds, 'Series Team Falcons Rounds Handicap (-8.5) vs Liquid (+8.5)', undefined, 1, 'round_handicap_match', 'Liquid +8,5 rounds (match entier)', "Sur l'ensemble des cartes du match, Team Falcons ne doit pas totaliser 9 rounds ou plus d'avance sur Liquid."],
  ['forme "Series X … (-4.5)" à un nom', fxSeriesOneName, 'Series FUT Esports Rounds Handicap (-4.5)', undefined, 1, 'round_handicap_match', 'OG +4,5 rounds (match entier)', "Sur l'ensemble des cartes du match, FUT Esports ne doit pas totaliser 5 rounds ou plus d'avance sur OG."],
  ['shooter_round_handicap à un nom', fxShooter, 'MOUZ Rounds Handicap (-7.5)', undefined, 0, 'round_handicap_match', 'MOUZ -7,5 rounds (match entier)', "MOUZ doit totaliser au moins 8 rounds de plus que FaZe sur l'ensemble des cartes du match."],

  // ── exact_maps_won (map_participant_win_total, Oui/Non)
  ['0 carte Oui', fxLegacyAbbr, 'Outfit 49 to win 0 maps?', undefined, 0, 'exact_maps_won', 'Outfit 49 gagne exactement 0 carte', 'Outfit 49 doit perdre le match 0-2.'],
  ['0 carte Non', fxLegacyAbbr, 'Outfit 49 to win 0 maps?', undefined, 1, 'exact_maps_won', 'Outfit 49 ne gagne pas exactement 0 carte', 'Outfit 49 doit gagner le match, ou le perdre sur un autre score que 0-2.'],
  ['1 carte Oui', fxLegacyAbbr, 'Dark Knight to win 1 maps?', undefined, 0, 'exact_maps_won', 'Dark Knight gagne exactement 1 carte', 'Dark Knight doit perdre le match 1-2.'],
  ['2 cartes Oui', fxLegacyAbbr, 'Outfit 49 to win 2 maps?', undefined, 0, 'exact_maps_won', 'Outfit 49 gagne exactement 2 cartes', 'Outfit 49 doit remporter le match (BO3 : 2 cartes gagnées).'],
  ['2 cartes Non', fxLegacyAbbr, 'Outfit 49 to win 2 maps?', undefined, 1, 'exact_maps_won', 'Outfit 49 ne gagne pas exactement 2 cartes', 'Outfit 49 doit perdre le match (BO3).'],

  // ── match_result_bo2 (moneyline Oui/Non d'un BO2)
  ['A 2-0 Oui', fxBo2, 'Benched gods to win 2-0?', undefined, 0, 'match_result_bo2', 'Benched gods gagne 2-0', 'Benched gods doit gagner les deux cartes du match (BO2).'],
  ['A 2-0 Non', fxBo2, 'Benched gods to win 2-0?', undefined, 1, 'match_result_bo2', 'Benched gods ne gagne pas 2-0', 'Benched gods ne doit pas gagner les deux cartes : le match doit finir sur un nul 1-1 ou une défaite 0-2.'],
  ['nul Oui', fxBo2, 'Benched gods vs KUUSAMO.gg: Draw (1-1)?', undefined, 0, 'match_result_bo2', 'Match nul 1-1', 'Chaque équipe doit gagner une carte (BO2 terminé à 1-1).'],
  ['nul Non', fxBo2, 'Benched gods vs KUUSAMO.gg: Draw (1-1)?', undefined, 1, 'match_result_bo2', 'Pas de match nul', "L'une des deux équipes doit gagner les deux cartes (score final 2-0)."],

  // ── outright
  ['vainqueur tournoi Oui', fxOutright, 'Will FURIA Win the PGL Major Singapore 2026?', undefined, 0, 'outright', 'FURIA remporte le tournoi PGL Major Singapore 2026', 'FURIA doit remporter le tournoi PGL Major Singapore 2026 (1re place).'],
  ['vainqueur tournoi Non', fxOutright, 'Will Natus Vincere Win the PGL Major Singapore 2026?', undefined, 1, 'outright', 'Natus Vincere ne remporte pas le tournoi PGL Major Singapore 2026', 'Toute autre équipe que Natus Vincere doit remporter le tournoi PGL Major Singapore 2026.'],
];

describe('describeBet — types reconnus (exact:true)', () => {
  it.each(EXACT_ROWS)('%s', (_label, fx, question, firstOutcome, idx, key, betFr, winFr) => {
    const d = describeBet(meta(fx, question, firstOutcome), idx);
    expect(d.exact).toBe(true);
    expect(d.marketTypeKey).toBe(key);
    expect(d.marketTypeFr).toBe(MARKET_TYPE_LABELS_FR[key]);
    expect(d.betFr).toBe(betFr);
    expect(d.winConditionFr).toBe(winFr);
  });

  it('renseigne match / format / tournoi depuis le titre', () => {
    const d = describeBet(meta(fxRustec, 'Map Handicap: NXS (-1.5) vs ex-RUSTEC (+1.5)'), 0);
    expect(d).toEqual({
      match: 'ex-RUSTEC vs Nexus',
      format: 'BO3',
      tournament: 'CCT Europe Group Stage',
      marketTypeKey: 'map_handicap',
      marketTypeFr: 'Handicap de cartes',
      betFr: 'Nexus -1,5 carte',
      winConditionFr: "Nexus doit gagner 2-0 (BO3 : victoire avec au moins 2 cartes d'écart).",
      exact: true,
    });
  });

  it('vainqueur de tournoi : tournoi tiré de la question', () => {
    const d = describeBet(meta(fxOutright, 'Will FURIA Win the PGL Major Singapore 2026?'), 0);
    expect(d.tournament).toBe('PGL Major Singapore 2026');
    expect(d.format).toBeNull();
  });

  it('le numéro de carte n\'entre jamais dans marketTypeKey', () => {
    for (const fx of Object.values(ALL)) {
      for (const raw of fx.markets) {
        const m = toMarketMeta(raw, fx.event);
        m.outcomes.forEach((_, i) => expect(describeBet(m, i).marketTypeKey).not.toMatch(/(map|game|carte)_?\d/));
      }
    }
  });

  it('toutes les clés produites ont un libellé FR', () => {
    for (const fx of Object.values(ALL)) {
      for (const raw of fx.markets) {
        const m = toMarketMeta(raw, fx.event);
        m.outcomes.forEach((_, i) => {
          const d = describeBet(m, i);
          expect(MARKET_TYPE_LABELS_FR[d.marketTypeKey]).toBe(d.marketTypeFr);
        });
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Preuve sur marchés CLOS : la phrase FR de l'issue gagnante doit être vraie
// au vu du score final (event.score = "…|cartesA-cartesB|BoN", ordre du titre).

describe('sémantique des handicaps de cartes vérifiée sur marchés clos', () => {
  const closed: Array<[Fixture, string]> = [
    [fxBo5Both, 'Map Handicap: NEMI (-1.5) vs Astralis (+1.5)'], // Nemiga 1-3 Astralis
    [fxBo5Both, 'Map Handicap: NEMI (-2.5) vs Astralis (+2.5)'],
    [fxBo5Both, 'Map Handicap: AST (-1.5) vs Nemiga (+1.5)'], //   3-1 couvre −1,5…
    [fxBo5Both, 'Map Handicap: AST (-2.5) vs Nemiga (+2.5)'], //   …mais pas −2,5
    [fxBo5, 'Map Handicap: MOUZ (-1.5) vs TheMongolz (+1.5)'], // TheMongolz 0-3 MOUZ
    [fxBo5, 'Map Handicap: MOUZ (-2.5) vs TheMongolz (+2.5)'],
    [fxBo3Rounds, 'Map Handicap: MGLZ (-1.5) vs Heroic (+1.5)'], // TheMongolz 2-0 Heroic
    [fxBo3Rounds, 'Map Handicap: HERO (-1.5) vs TheMongolz (+1.5)'],
    [fxTs, 'Map Handicap: TS (-1.5) vs Team Falcons (+1.5)'], // Spirit 0-2 Team Falcons
    [fxTs, 'Map Handicap: FAL (-1.5) vs Spirit (+1.5)'],
    [fxM8, 'Map Handicap: M8 (-1.5) vs HOTU (+1.5)'], // Gentle Mates 0-2 HOTU
    [fxLeadingSpace, 'Map Handicap: PRIME (-1.5) vs  CSDIILIT (+1.5)'], // CSDIILIT 2-0 PRIME
    [fxLegacyFullName, 'Map Handicap: gothboiclique (-1.5)'], // gothboiclique 2-1
  ];

  it.each(closed)('%#  %s → %s', (fx, question) => {
    const m = meta(fx, question);
    const winner = resolvedIndex(fx, question);
    expect(winner).not.toBeNull();
    const t = parseEventTitle(fx.event.title);
    const [a, b] = String(fx.event.score).split('|')[1]!.split('-').map(Number) as [number, number];
    const maps = new Map<string, number>([[t.teams![0], a], [t.teams![1], b]]);

    // On relit UNIQUEMENT la phrase FR produite : "<équipe> ±x,5 carte(s)".
    for (const idx of [0, 1]) {
      const d = describeBet(m, idx);
      expect(d.exact).toBe(true);
      const parsed = /^(.+) ([+-])(\d+),5 cartes?$/.exec(d.betFr)!;
      const team = parsed[1]!;
      const hcp = (parsed[2] === '-' ? -1 : 1) * (Number(parsed[3]) + 0.5);
      const other = [...maps.keys()].find((k) => k !== team)!;
      expect(maps.has(team)).toBe(true);
      const covers = maps.get(team)! + hcp > maps.get(other)!;
      expect(covers).toBe(idx === winner);
    }
  });

  it('total de cartes et vainqueur du match cohérents avec le score final', () => {
    // Nemiga 1-3 Astralis : 4 cartes
    expect(resolvedIndex(fxBo5Both, 'Games Total: O/U 3.5')).toBe(0);
    expect(describeBet(meta(fxBo5Both, 'Games Total: O/U 3.5'), 0).betFr).toBe('Plus de 3,5 cartes');
    expect(resolvedIndex(fxBo5Both, 'Games Total: O/U 4.5')).toBe(1);
    expect(describeBet(meta(fxBo5Both, 'Games Total: O/U 4.5'), 1).betFr).toBe('Moins de 4,5 cartes');
    const ml = 'Counter-Strike: Nemiga vs Astralis (BO5) - Stake Ranked Episode 4 Playoffs';
    expect(describeBet(meta(fxBo5Both, ml), resolvedIndex(fxBo5Both, ml)!).betFr).toBe('Astralis gagne le match');
  });

  it('exact_maps_won cohérent avec le score final (Dark Knight 1-2 Outfit 49)', () => {
    for (const [q, yes] of [
      ['Outfit 49 to win 2 maps?', true],
      ['Outfit 49 to win 1 maps?', false],
      ['Outfit 49 to win 0 maps?', false],
      ['Dark Knight to win 1 maps?', true],
      ['Dark Knight to win 2 maps?', false],
    ] as Array<[string, boolean]>) {
      expect(resolvedIndex(fxLegacyAbbr, q)).toBe(yes ? 0 : 1);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('describeBet — repli exact:false (jamais de supposition)', () => {
  function expectFallback(m: MarketMeta, idx: number, key: 'unknown' | 'other') {
    const d = describeBet(m, idx);
    const outcome = (m.outcomes[idx] ?? `issue n°${idx}`).trim();
    expect(d.exact).toBe(false);
    expect(d.marketTypeKey).toBe(key);
    expect(d.marketTypeFr).toBe(MARKET_TYPE_LABELS_FR[key]);
    expect(d.betFr).toBe(`${m.question.trim()} → ${outcome}`);
    expect(d.winConditionFr).toBe(
      `Marché non traduit automatiquement : le pari est gagné si le marché se résout sur « ${outcome} ».`,
    );
    return d;
  }

  it('ancienne forme à un nom AVEC abréviation ("O49") : pas de preuve du côté ⇒ repli', () => {
    const m = meta(fxLegacyAbbr, 'Map Handicap: O49 (-1.5)');
    const d0 = expectFallback(m, 0, 'unknown');
    expect(d0.betFr).toBe('Map Handicap: O49 (-1.5) → Outfit 49');
    expect(d0.match).toBe('Dark Knight vs Outfit 49');
    expect(d0.format).toBe('BO3');
    expectFallback(m, 1, 'unknown');
  });

  it('marché de match sans sportsMarketType (sept. 2025)', () => {
    const m = meta(fxLegacyNoType, 'Counter-Strike: Copenhagen Wolves vs FORZE Reload');
    expectFallback(m, 0, 'unknown');
    expectFallback(m, 1, 'unknown');
  });

  it('prop hors match (Oui/Non) ⇒ other', () => {
    const m = meta(fxProp, 'Will FaZe win a Tier 1 event in 2026? ');
    const d = expectFallback(m, 0, 'other');
    expect(d.betFr).toBe('Will FaZe win a Tier 1 event in 2026? → Yes');
    expect(d.match).toBe('Will FaZe win a Tier 1 event in 2026?');
    expectFallback(m, 1, 'other');
  });

  it('vainqueur de tournoi : lignes génériques ("another team", équipe fictive "A")', () => {
    expectFallback(meta(fxOutright, 'Will another team Win the PGL Major Singapore 2026?'), 0, 'other');
    expectFallback(meta(fxOutright, 'Will A Win the PGL Major Singapore 2026?'), 1, 'other');
  });

  it('index d\'issue hors bornes', () => {
    const m = meta(fxRustec, RUSTEC_ML);
    for (const idx of [2, -1, 0.5, Number.NaN]) {
      const d = describeBet(m, idx);
      expect(d.exact).toBe(false);
      expect(d.marketTypeKey).toBe('unknown');
    }
  });

  // Mutations d'un marché réel : chaque incohérence doit suffire à déclencher le repli.
  const base = meta(fxRustec, 'Map Handicap: NXS (-1.5) vs ex-RUSTEC (+1.5)');
  const mutations: Array<[string, Partial<MarketMeta>]> = [
    ['issues inversées par rapport à la question', { outcomes: ['ex-RUSTEC', 'Nexus'] }],
    ['2e nom de la question absent des issues', { outcomes: ['Nexus', 'RUSTEC'] }],
    ['line de signe opposé', { line: 1.5 }],
    ['line différente de la question', { line: -2.5 }],
    ['line absente', { line: null }],
    ['signes inversés dans la question', { question: 'Map Handicap: NXS (+1.5) vs ex-RUSTEC (-1.5)', line: 1.5 }],
    ['valeurs absolues différentes', { question: 'Map Handicap: NXS (-1.5) vs ex-RUSTEC (+2.5)' }],
    ['ligne entière (remboursement possible)', { question: 'Map Handicap: NXS (-1) vs ex-RUSTEC (+1)', line: -1 }],
    ['1er nom = issue 1 (contradiction)', { question: 'Map Handicap: ex-RUSTEC (-1.5) vs ex-RUSTEC (+1.5)' }],
    ['trois issues', { outcomes: ['Nexus', 'ex-RUSTEC', 'Draw'] }],
    ['issues identiques', { outcomes: ['ex-RUSTEC', 'ex-RUSTEC'] }],
    ['issues Oui/Non', { outcomes: ['Yes', 'No'] }],
    ['libellé de question inconnu', { question: 'Maps Spread: NXS (-1.5) vs ex-RUSTEC (+1.5)' }],
    ['sportsMarketType inconnu', { sportsMarketType: 'first_half_winner' }],
    ['sportsMarketType absent', { sportsMarketType: null }],
  ];
  it.each(mutations)('handicap de cartes — %s', (_label, patch) => {
    const m = { ...base, ...patch };
    expect(describeBet(m, 0).exact).toBe(false);
    expect(describeBet(m, 1).exact).toBe(false);
    expect(describeBet(m, 0).betFr).toBe(`${m.question} → ${m.outcomes[0]}`);
  });

  it('handicap de rounds : numéro de carte du type ≠ celui de la question', () => {
    const m = meta(fxBo3Rounds, 'Map 1 Rounds Handicap: TheMongolz (-3.5) vs Heroic (+3.5)');
    expect(describeBet(m, 0).exact).toBe(true);
    expect(describeBet({ ...m, sportsMarketType: 'round_handicap_game_2' }, 0).exact).toBe(false);
  });

  it('carte 4 annoncée dans un BO3 ⇒ repli', () => {
    const m = meta(fxRustec, 'Counter-Strike: ex-RUSTEC vs Nexus - Map 2 Winner');
    expect(describeBet({ ...m, question: 'Counter-Strike: ex-RUSTEC vs Nexus - Map 4 Winner' }, 0).exact).toBe(false);
  });

  it('plus/moins : issues dans un ordre inattendu ou ligne incohérente ⇒ repli', () => {
    const m = meta(fxRustec, 'Games Total: O/U 2.5');
    expect(describeBet({ ...m, outcomes: ['Under', 'Over'] }, 0).exact).toBe(false);
    expect(describeBet({ ...m, line: 3.5 }, 0).exact).toBe(false);
    expect(describeBet({ ...m, question: 'Games Total: O/U 3', line: 3 }, 0).exact).toBe(false);
  });

  it('moneyline dont la question ne nomme pas les deux issues ⇒ repli', () => {
    const m = meta(fxRustec, RUSTEC_ML);
    expect(describeBet({ ...m, outcomes: ['ex-RUSTEC', 'Favbet'] }, 0).exact).toBe(false);
    expect(describeBet({ ...m, question: 'Who wins the pistol round?' }, 0).exact).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('describeBet — format (BO) et titres atypiques', () => {
  it('titre (BO5) contredit par la question (BO3) ⇒ format null, formulation générique', () => {
    const ml = describeBet(meta(fxBoConflict, 'Counter-Strike: NRG vs 9INE (BO3)'), 0);
    expect(ml.exact).toBe(true);
    expect(ml.format).toBeNull();
    expect(ml.winConditionFr).toBe('NRG doit remporter le match.');
  });

  it('ligne incompatible avec le format annoncé (2,5 cartes dans un « BO5 ») ⇒ formulation générique', () => {
    const d = describeBet(meta(fxBoConflict, 'Games Total: O/U 2.5'), 0);
    expect(d.exact).toBe(true);
    expect(d.betFr).toBe('Plus de 2,5 cartes');
    expect(d.winConditionFr).toBe('Il faut au moins 3 cartes jouées dans le match.');
    expect(describeBet(meta(fxBoConflict, 'Games Total: O/U 2.5'), 1).winConditionFr).toBe(
      'Il faut au plus 2 cartes jouées dans le match.',
    );
  });

  it('handicap de cartes sans format connu ⇒ condition générale (jamais « 2-0 » codé en dur)', () => {
    const m = { ...meta(fxRustec, 'Map Handicap: NXS (-1.5) vs ex-RUSTEC (+1.5)'), eventTitle: 'Counter-Strike: ex-RUSTEC vs Nexus' };
    expect(describeBet(m, 0).winConditionFr).toBe("Nexus doit gagner le match avec au moins 2 cartes d'écart.");
    expect(describeBet(m, 1).winConditionFr).toBe("ex-RUSTEC doit gagner le match, ou le perdre avec moins de 2 cartes d'écart.");
    expect(describeBet(m, 0).format).toBeNull();
  });

  it('handicap −2,5 dans un BO3 (impossible) ⇒ condition générale', () => {
    const m = { ...meta(fxBo5, 'Map Handicap: MOUZ (-2.5) vs TheMongolz (+2.5)'), eventTitle: 'Counter-Strike: TheMongolz vs MOUZ (BO3) - IEM Beijing Playoffs' };
    const d = describeBet(m, 0);
    expect(d.exact).toBe(true);
    expect(d.winConditionFr).toBe("MOUZ doit gagner le match avec au moins 3 cartes d'écart.");
  });

  it('BO7 traité par la règle générale', () => {
    const t = 'Counter-Strike: TheMongolz vs MOUZ (BO7) - Showmatch';
    const h = { ...meta(fxBo5, 'Map Handicap: MOUZ (-2.5) vs TheMongolz (+2.5)'), eventTitle: t };
    expect(describeBet(h, 0).winConditionFr).toBe("MOUZ doit gagner 4-0 ou 4-1 (BO7 : victoire avec au moins 3 cartes d'écart).");
    expect(describeBet(h, 1).winConditionFr).toBe(
      'TheMongolz doit gagner au moins 2 cartes (victoire, ou défaite 2-4 ou 3-4) : pari perdu seulement si MOUZ gagne 4-0 ou 4-1.',
    );
    const o = { ...meta(fxBo5, 'Games Total: O/U 4.5'), eventTitle: t };
    expect(describeBet(o, 0).winConditionFr).toBe('Il faut au moins 5 cartes jouées (score final 4-1 ou 4-2 ou 4-3, peu importe le vainqueur).');
    expect(describeBet(o, 1).winConditionFr).toBe('Le match doit se terminer en 4 cartes (score final 4-0, peu importe le vainqueur).');
  });

  it('titre périmé (équipe remplacée) : le match affiché suit les issues du marché', () => {
    // titre : "Pigeons vs Brute", marché : "ex-Imperial Valkyries vs Brute"
    const d = describeBet(meta(fxStaleTitle, 'Counter-Strike: ex-Imperial Valkyries vs Brute (BO3)'), 0);
    expect(d.exact).toBe(true);
    expect(d.betFr).toBe('ex-Imperial Valkyries gagne le match');
    expect(d.match).toBe('ex-Imperial Valkyries vs Brute');
    expect(d.tournament).toBe('NODWIN Clutch Series Play-In Group C');
    // ancienne forme à un nom : "BRUTE" = issue 0 à la casse près ⇒ exact
    const h = describeBet(meta(fxStaleTitle, 'Map Handicap: BRUTE (-1.5)'), 1);
    expect(h.exact).toBe(true);
    expect(h.betFr).toBe('ex-Imperial Valkyries +1,5 carte');
    // … mais "PGE" (abréviation) ⇒ repli
    expect(describeBet(meta(fxStaleTitle, 'Map Handicap: PGE (-1.5)'), 0).exact).toBe(false);
  });

  it('nom d\'équipe contenant " vs " : les issues lèvent l\'ambiguïté du titre', () => {
    const title = 'Counter-Strike: Us vs Them vs NAVI (BO3) - IEM Katowice';
    const m: MarketMeta = {
      ...meta(fxRustec, RUSTEC_ML),
      eventTitle: title,
      question: title,
      outcomes: ['Us vs Them', 'NAVI'],
    };
    const d = describeBet(m, 0);
    expect(d.exact).toBe(true);
    expect(d.betFr).toBe('Us vs Them gagne le match');
    expect(d.match).toBe('Us vs Them vs NAVI');
    const child = { ...m, sportsMarketType: 'child_moneyline', question: 'Counter-Strike: Us vs Them vs NAVI - Map 2 Winner' };
    expect(describeBet(child, 1).betFr).toBe('NAVI gagne la carte 2');
    // mauvais découpage ("Us" / "Them vs NAVI") ⇒ repli
    expect(describeBet({ ...m, outcomes: ['Us', 'NAVI'] }, 0).exact).toBe(false);
  });

  it('BO2 : format conservé, pas de vainqueur « 2 cartes gagnantes »', () => {
    const d = describeBet(meta(fxBo2, 'KUUSAMO.gg to win 2-0?'), 0);
    expect(d.format).toBe('BO2');
    expect(d.betFr).toBe('KUUSAMO.gg gagne 2-0');
    expect(d.tournament).toBe('Exort Fiesta Closed Qualifier: Series #2 Group D');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('couverture des fixtures', () => {
  it('chaque marché de chaque fixture donne une description pour chaque issue, sans exception', () => {
    let n = 0;
    for (const fx of Object.values(ALL)) {
      for (const raw of fx.markets) {
        const m = toMarketMeta(raw, fx.event);
        expect(m.outcomes.length).toBe(2);
        expect(m.tokenIds.length).toBe(2);
        for (const i of [0, 1]) {
          const d = describeBet(m, i);
          expect(d.betFr.length).toBeGreaterThan(0);
          expect(d.winConditionFr.length).toBeGreaterThan(0);
          n++;
        }
        // deux issues d'un même marché ne donnent jamais la même phrase
        expect(describeBet(m, 0).betFr).not.toBe(describeBet(m, 1).betFr);
      }
    }
    expect(n).toBe(212);
  });

  it('les clés de type forment un petit ensemble stable', () => {
    expect(Object.keys(MARKET_TYPE_LABELS_FR).sort()).toEqual([
      'exact_maps_won', 'map_handicap', 'map_winner', 'match_result_bo2', 'match_winner',
      'odd_even_kills_map', 'odd_even_rounds_map', 'other', 'outright', 'round_handicap_map',
      'round_handicap_match', 'total_maps', 'total_rounds_map', 'total_rounds_match', 'unknown',
    ]);
  });
});
