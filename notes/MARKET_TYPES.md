# Marchés Polymarket Counter-Strike 2 — taxonomie et règles de traduction

Référence de `src/core/translate.ts` (`describeBet`). Tout ce qui suit a été mesuré
sur les données réelles de l'API Gamma, le 2026-11-13.

## 1. Corpus analysé

| Source | Contenu |
|---|---|
| `GET /events/keyset?series_id=10310&closed=true` (curseur) | 12 851 événements CS2 clos |
| `GET /events?series_id=10310&closed=false` | 388 événements CS2 ouverts |
| `GET /events?tag_id=100780&closed=false` | + 25 événements hors série (tournois, props) |
| `GET data-api /v2/trades?user=0xc9bf…81c0` (curseur) | 5 924 trades du wallet, 734 marchés |

Total : **13 264 événements, 135 827 marchés**, du 2025-09-24 au 2026-11-24.
Formats (titre) : BO3 11 007 · BO1 2 126 · BO5 96 · BO2 1 · sans « (BOx) » 9.
La série CS2 est `seriesSlug = "counter-strike"` (id 10310), tag principal 100780.
Les pages `/events` de plus de 50 éléments exigent `Accept-Encoding: gzip` ; au-delà
de l'offset 2000 il faut `/events/keyset` (`next_cursor` → `after_cursor`).

## 2. Taxonomie

`marketTypeKey` est la clé stable pour les statistiques ; le numéro de carte est
dans la phrase, jamais dans la clé. « Exact » = nombre de marchés dont les deux
issues sont traduites avec `exact:true`.

| `sportsMarketType` Gamma | Marchés | Exact | `marketTypeKey` | Exemple réel (question → issues, `line`) |
|---|---:|---:|---|---|
| `moneyline` | 13 229 | 13 229 | `match_winner` | `Counter-Strike: ex-RUSTEC vs Nexus (BO3) - CCT Europe Group Stage` → `["ex-RUSTEC","Nexus"]` |
| `moneyline` (BO2, Oui/Non) | 3 | 3 | `match_result_bo2` | `Benched gods to win 2-0?` / `Benched gods vs KUUSAMO.gg: Draw (1-1)?` → `["Yes","No"]` |
| `child_moneyline` | 21 390 | 21 390 | `map_winner` | `Counter-Strike: ex-RUSTEC vs Nexus - Map 1 Winner` → `["ex-RUSTEC","Nexus"]` |
| `map_handicap` | 12 627 | 12 422 | `map_handicap` | `Map Handicap: NXS (-1.5) vs ex-RUSTEC (+1.5)` → `["Nexus","ex-RUSTEC"]`, line −1.5 |
| `totals` | 10 886 | 10 886 | `total_maps` | `Games Total: O/U 2.5` → `["Over","Under"]`, line 2.5 |
| `round_over_under_game_N` (N = 1..5) | 28 715 | 28 715 | `total_rounds_map` | `Map 1 Total Rounds: Over/Under 21.5` → `["Over","Under"]`, line 21.5 |
| `round_handicap_game_N` (N = 1..5) | 27 680 | 27 680 | `round_handicap_map` | `Map 1 Rounds Handicap: TheMongolz (-3.5) vs Heroic (+3.5)` → `["TheMongolz","Heroic"]`, line −3.5 |
| `cs2_odd_even_total_rounds` | 9 953 | 9 953 | `odd_even_rounds_map` | `Map 1: Odd/Even Total Rounds?` → `["Odd","Even"]` |
| `cs2_odd_even_total_kills` | 9 953 | 9 953 | `odd_even_kills_map` | `Map 3: Odd/Even Total Kills?` → `["Odd","Even"]` |
| `map_participant_win_total` (ancien) | 848 | 848 | `exact_maps_won` | `Outfit 49 to win 1 maps?` → `["Yes","No"]`, line 1 |
| `round_over_under_match`, `shooter_rounds_total` (anciens) | 191 | 191 | `total_rounds_match` | `Total Rounds Over/Under 49.5` → `["Over","Under"]` |
| `round_handicap_match`, `shooter_round_handicap` (anciens) | 229 | 229 | `round_handicap_match` | `Series Team Falcons Rounds Handicap (-8.5) vs Liquid (+8.5)` → `["Team Falcons","Liquid"]` |
| *(null)*, événement « `<tournoi>: Winner` » | 40 | 40 | `outright` | `Will FURIA Win the PGL Major Singapore 2026?` → `["Yes","No"]` |
| *(null)*, autres props hors match | 75 | 0 | `other` | `Will FaZe win a Tier 1 event in 2026?` → `["Yes","No"]` |
| *(null)*, match de sept. 2025 | 8 | 0 | `unknown` | `Counter-Strike: Copenhagen Wolves vs FORZE Reload` → `["Copenhagen Wolves","FORZE Reload"]` |

Lignes observées — `map_handicap` : −1.5 (BO3, BO5), −2.5 (BO5) ; `totals` : 2.5 (BO3),
3.5 et 4.5 (BO5) ; `round_handicap_game_N` : −2.5 … −15.5 (surtout −3.5/−6.5/−9.5/−12.5) ;
`round_over_under_game_N` : 15.5 … 54.5 par pas de 3. **Toutes les lignes sont en x,5** :
aucun remboursement « pile sur la ligne » n'est possible. Une ligne entière déclenche le repli.

**Cherchés et absents du corpus** : score exact (hors `exact_maps_won` et BO2),
première mi-temps, pistol round, props de joueurs (kills d'un joueur, MVP du match),
handicap de cartes par carte. S'ils apparaissent, ils tomberont en `unknown`/`exact:false`.

### Couverture sur les trades réels du wallet `0xc9bf…81c0`

| `marketTypeKey` | Trades | % trades | Volume USDC | % volume |
|---|---:|---:|---:|---:|
| `match_winner` (BO3 3 529, BO1 82, BO5 31) | 3 642 | 61,48 % | 1 863 087 | 67,08 % |
| `map_handicap` (BO3 −1.5 : 1 532 ; BO5 −1.5 : 18 ; BO5 −2.5 : 4) | 1 554 | 26,23 % | 754 096 | 27,15 % |
| `map_winner` | 486 | 8,20 % | 129 527 | 4,66 % |
| `total_maps` (2.5 : 198 ; 3.5 : 3) | 201 | 3,39 % | 26 640 | 0,96 % |
| `round_handicap_map` (−3.5) | 41 | 0,69 % | 3 966 | 0,14 % |
| **Total `exact:true`** | **5 924 / 5 924** | **100 %** | **2 777 316** | **100 %** |

## 3. Sémantique des handicaps — ce qui a été prouvé

### 3.1 Structure (constante sur 40 000+ marchés)

Question `<A> (-x.5) vs <B> (+x.5)`, `line = -x.5`, `outcomes = [A, B]`.

| Contrôle | `map_handicap` (12 345 à deux noms) | `round_handicap_game_N` (27 680) |
|---|---|---|
| 1er nombre négatif, 2e positif, même valeur absolue | 100 % | 100 % |
| `line` = 1er nombre (négatif) | 100 % | 100 % |
| `<B>` = `outcomes[1]`, caractère pour caractère | 100 % | 100 % |
| `<A>` = `outcomes[0]` exactement | 3 280 (27 %) | 100 % |
| `<A>` est une abréviation de `outcomes[0]` | 9 065 (73 %) | 0 |

Donc **issue 0 = côté − (rend le handicap), issue 1 = côté + (le reçoit)**. La règle de
résolution (`description`) le confirme : « *This market will resolve to "Wildcard" if
Wildcard wins 3 or more maps than DENDELE CS in this match. Otherwise, this market will
resolve to "DENDELE CS".* » (ligne −2.5), et pour les rounds : « *…if Ground Zero wins
Map 1 by 4 or more rounds, including any overtime… Otherwise… "Abyssal"* » (ligne −3.5).

Attention : un même match porte souvent **les deux marchés miroirs** (`NEMI (-1.5) vs
Astralis (+1.5)` *et* `AST (-1.5) vs Nemiga (+1.5)`), et l'ordre des issues d'un handicap
n'est **pas** celui du titre. Se tromper de côté inverserait le pari.

### 3.2 Preuve par les résolutions (marchés clos, score final vs `outcomePrices`)

Score final lu dans `event.score` (`"000-000|1-3|Bo5"` → cartes dans l'ordre du titre).

| Marché | Score (issue 0 – issue 1) | Résolu sur | Nombre |
|---|---|---|---:|
| BO3 −1.5 | 2-0 | issue 0 | 4 282 |
| BO3 −1.5 | 2-1 | issue 1 | 2 641 |
| BO3 −1.5 | 1-2 / 0-2 | issue 1 | 2 291 / 2 094 |
| BO5 −1.5 | 3-0 / 3-1 | issue 0 | 25 / 26 |
| BO5 −1.5 | 3-2, 2-3, 1-3, 0-3 | issue 1 | 19 / 19 / 17 / 13 |
| BO5 −2.5 | 3-0 | issue 0 | 25 |
| BO5 −2.5 | 3-1, 3-2, 2-3, 1-3, 0-3 | issue 1 | 25 / 19 / 18 / 18 / 15 |

Contrôle de bout en bout (relecture de la **phrase française produite** contre le score) :
11 679 marchés conformes sur 11 681. Les 2 écarts (`cs2-alkaa-tdp-2026-09-16`,
`cs2-berg-fcf-2026-09-18`) viennent du champ `score` de Gamma, faux pour ces matchs
(« 2-0 » alors que la carte 2 est résolue pour l'autre équipe et que `Games Total O/U 2.5`
est résolu « Over ») : le score réel est 2-1 et la résolution est correcte. Le champ
`score` est donc indicatif, pas une source de vérité (29 `moneyline` sur 11 729 le
contredisent aussi).

Handicap de rounds par carte (Gamma n'expose pas le score en rounds ; preuve par
recoupement avec `child_moneyline` et `round_over_under_game_N` de la même carte) :

| Propriété attendue | Vérifiée |
|---|---:|
| le côté + (issue 1) gagne la carte ⇒ résolu issue 1 | 5 842 / 5 842 |
| le côté − gagne la carte, total ≤ 25 − ⌊x⌋ rounds ⇒ résolu issue 0 | 4 517 / 4 523 |
| le côté − gagne la carte, total ≥ 26 − ⌊x⌋ rounds ⇒ résolu issue 1 | 3 849 / 3 849 |

Les 6 écarts (tous en −3.5, 0,1 %) n'ont pas été élucidés : le recoupement repose sur
trois marchés résolus séparément, et l'un d'eux a pu être réglé de façon atypique. `totals` : 9 983 / 9 990 conformes (mêmes erreurs de `score`).

### 3.3 Exemple de référence

`Map Handicap: NXS (-1.5) vs ex-RUSTEC (+1.5)`, `outcomes = ["Nexus","ex-RUSTEC"]`, BO3 :

- issue 0 → **« Nexus -1,5 carte »** — « Nexus doit gagner 2-0 (BO3 : victoire avec au moins 2 cartes d'écart). »
- issue 1 → **« ex-RUSTEC +1,5 carte »** — « ex-RUSTEC doit gagner au moins une carte (victoire, ou défaite 1-2) : pari perdu seulement si Nexus gagne 2-0. »

## 4. Ambiguïtés tranchées

1. **Abréviation ↔ nom complet.** Les abréviations ne sont pas dérivables du nom :
   `M8` = Gentle Mates, `TS` = Spirit, `G2.A` = G2 Ares ; 469 ne sont même pas une
   sous-séquence du nom, et 150 sont une sous-séquence du nom de **l'adversaire**
   (`TS` ⊂ « **T**eam Falcon**s** »). Toute similarité de chaînes est donc proscrite.
   Règle retenue : `<B>` doit être **strictement** égal à `outcomes[1]` (et différent de
   `outcomes[0]`), `<A>` ne doit pas désigner `outcomes[1]` ; l'issue 0 est alors le côté −
   par élimination (marché binaire). Tout autre cas → `exact:false`.
2. **Ancienne forme à un seul nom** (`Map Handicap: O49 (-1.5)`, janv. 2026, 282 marchés) :
   pas d'élimination possible. Exact seulement si le nom est le nom complet de l'issue 0
   (77 marchés, casse ignorée : `BRUTE` = `Brute`) ; les 205 avec abréviation restent
   `exact:false`, bien que l'ordre « issue 0 = côté − » y soit vérifié à 100 % (260/260 marchés clos) —
   on ne s'appuie jamais sur l'ordre seul.
3. **Format (BO) peu fiable.** Le titre peut être faux (`cs2-nrg-9ine-2026-01-05` : titre
   « (BO5) », question « (BO3) », total 2.5). Donc : (a) format du titre annulé si la
   question en affiche un autre ; (b) le format n'est exploité que s'il est compatible
   avec la ligne (écart ≤ cartes gagnantes, ligne du total dans les durées possibles) ;
   (c) sinon `winConditionFr` reste **général et toujours vrai** (« doit gagner le match
   avec au moins 2 cartes d'écart »). Les scores (« 2-0 », « 3-0 ou 3-1 ») sont calculés
   à partir de N pour tout BO impair (BO1/3/5/7), jamais codés en dur pour le BO3.
4. **Titre d'événement périmé.** `cs2-eiv-brute-2026-01-15` : titre « Pigeons vs Brute »,
   marchés « ex-Imperial Valkyries vs Brute ». Les phrases utilisent toujours les noms des
   **issues du marché** ; si elles ne sont pas celles du titre, `match` est reconstruit à
   partir des issues. Les simples écarts de casse (`AaB Esport` / `AaB esport`) sont ignorés.
5. **Espaces parasites.** Titres avec double espace (227) et issues avec espace en tête
   (`" CSDIILIT"`) : tout est normalisé avant comparaison et affichage.
6. **`moneyline` à issues Oui/Non.** Seul cas : le BO2 `cs2-benche-ksm-2026-09-09`
   (« X to win 2-0? », « Draw (1-1)? »). Traduit en `match_result_bo2` uniquement si le
   titre dit « (BO2) » ; sinon repli. Un `moneyline` dont la question ne contient pas
   « issue0 vs issue1 » est aussi un repli.
7. **Carte éventuellement non jouée.** Règle Polymarket : « *If Map N is not completed
   for any reason, this market will resolve 50-50* ». Tous les marchés par carte ajoutent
   « Si la carte N n'est pas jouée, le marché est réglé à 50-50. » dès que la carte n'est
   pas garantie (N > cartes gagnantes ; N ≥ 2 si le format est inconnu). Un numéro de carte
   supérieur au BO → repli. Le N de `…_game_N` doit être celui de la question.
8. **Exemples de score en rounds.** Basés sur le MR12 de CS2 (13 rounds gagnants, 24 max
   sans prolongation) et présentés comme exemples (« ex. 13-9 ou mieux ») ; la condition
   elle-même (« au moins 4 rounds d'écart, prolongations incluses ») reprend la règle
   officielle. Plus de 24,5 rounds ⇔ prolongation.
9. **`map_participant_win_total`** = nombre **exact** de cartes gagnées (description :
   « *wins exactly 1 maps* »), pas « au moins ». 765 / 767 résolutions conformes.
10. **Vainqueur de tournoi.** Exact seulement si la question est « Will X win the T? »,
    le titre « T: Winner », `groupItemTitle` = X et les issues `["Yes","No"]`. Les lignes
    « another team » et les équipes fictives « A »…« E » restent `exact:false`.
11. **Titres.** Tournoi = tout ce qui suit le premier « - » après « (BOx) » (il peut
    contenir « - » ou « : ») ; sans « (BOx) », premier « - » après le premier « vs » ;
    « More Markets » n'est pas un tournoi. Un nom d'équipe contenant « vs » rend
    `parseEventTitle().teams` nul, mais `describeBet` reste exact car il valide le
    découpage contre les issues du marché.

## 5. Ce qui reste en `exact:false`

| Cas | Marchés | Pourquoi |
|---|---:|---|
| `map_handicap` ancienne forme à un nom avec abréviation | 205 | côté non prouvable par le texte (forme abandonnée depuis fév. 2026) |
| Props hors match (transferts, Valve, « Tier 1 event »…) | 75 | texte libre |
| Matchs de sept. 2025 sans `sportsMarketType` | 8 | type absent |
| Tout type / motif / ligne inconnu ou incohérent | — | par construction |

Dans ce cas : `betFr = "<question anglaise> → <issue>"`, `winConditionFr = "Marché non
traduit automatiquement : le pari est gagné si le marché se résout sur « <issue> »."`,
`marketTypeKey = "unknown"` (événement de match) ou `"other"` (hors match).
