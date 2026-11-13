# cs2-wallet-monitor

Moniteur permanent d'un wallet Polymarket qui ne parie que sur Counter-Strike 2
(`0xc9bfc7986767173b4f1c3fc9b2c6b255fc7381c0`, « Stiff-Desktop »). Chaque nouveau pari, renfort,
vente et résultat est traduit en français et envoyé sur Telegram ; un tableau de bord statique
(GitHub Pages) présente les positions, les statistiques et le journal des alertes.

Tout tourne dans GitHub Actions, sans serveur et sans dépendance à l'exécution (Node 22 exécute le
TypeScript directement). Les décisions de conception sont dans `notes/ARCHITECTURE.md`, les faits
vérifiés sur l'API dans `notes/API_NOTES.md`.

## Ce que vous recevez sur Telegram

| Alerte | Quand | Contenu |
|-|-|-|
| 🎯 NOUVEAU PARI | premier achat sur une issue, 20 s après la première détection (la rafale est regroupée) | match, tournoi, pari en clair et condition de gain, mise (cash sorti, frais inclus, frais indiqués à part), prix d'entrée et cote, pré-match ou live, taker/maker, prix encore disponible dans le carnet |
| ➕ RENFORT | achats suivants cumulés : ≥ 100 $ et ≥ 10 min depuis la dernière alerte de la position, ou tout de suite si le renfort pèse ≥ 50 % de la position | l'ajout ET le total de la position |
| ➖ VENTE PARTIELLE / ✅ POSITION FERMÉE | toute vente, après 20 s | parts, prix, cash reçu, PnL réalisé |
| 🏁 RÉSULTAT | à la résolution du marché | gagné / perdu / remboursé 50-50, mise totale, encaissé, PnL, ROI |

Ce qui est sous les seuils n'est jamais perdu : c'est dans le registre et le tableau de bord, et inclus dans
l'alerte suivante de la position (le total affiché est toujours exact). Un fill n'appartient qu'à une alerte.
Un pari détecté avec plus de 2 minutes de retard (reprise après une panne) porte la mention « ⏱ Détecté en retard ».

Tous les montants viennent des champs de l'API (`usdc_size`, `size`, `price`) : rien n'est estimé.

## Comment ça tourne

```
.github/workflows/monitor.yml   boucle longue + chien de garde (toutes les 10 min) + relance manuelle
.github/workflows/daily.yml     réconciliation quotidienne avec l'historique complet
.github/workflows/ci.yml        tests et typage
src/core/      code pur : registre (dédup), positions, alertes, stats, données du tableau de bord, format FR
src/runner/    E/S : API Polymarket, Telegram, branche git `data`, bail, boucle, backfill, rejeu TEST
config.json    tous les réglages
site/          tableau de bord statique
```

- **Boucle** : toutes les 3 s, lecture de `/v2/activity` (cache CDN contourné), avec un recouvrement de 10 min.
  Dédoublonnage par multiensemble (aucun identifiant de ligne n'existe dans l'API). Délai mesuré entre un pari
  et sa détection : quelques secondes ; l'alerte part 20 s après (regroupement de la rafale).
- **État** : branche orpheline `data`, écrite uniquement par le moniteur — `ledger/fills.jsonl` (registre,
  jamais réécrit), `ledger/events.jsonl`, `ledger/alerts.jsonl`, `ledger/markets.json`, `state/state.json`,
  `site/data.json` (lu par le tableau de bord), `site/heartbeat.json` (santé).
- **Bail** : un seul run envoie des alertes. Un run dure 5 h 20 ; 5 min avant la fin il lance son successeur,
  attend qu'il soit prêt et lui passe la main, sans doublon ni trou. Si un run meurt, le chien de garde
  (toutes les 10 min) reprend et rattrape ce qui a été manqué.
- **Premier démarrage** : la branche `data` est créée et tout l'historique est chargé (sans aucune alerte).
- **Chaque nuit** (`daily.yml`) : l'historique complet est relu et comparé au registre ; un fill manquant est ajouté
  (et notifié, avec la mention de retard, s'il a moins de 24 h). Un run `daily` rouge = le moniteur n'a pas répondu.

Secrets nécessaires (Settings → Secrets and variables → Actions) : `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`.
Ils ne sont lus que depuis l'environnement, jamais écrits ni journalisés.

## Commandes utiles (onglet Actions → monitor → Run workflow)

| `mode` | Effet |
|-|-|
| `run` | démarre le moniteur (s'arrête tout seul si un autre tourne déjà) |
| `send-test` | envoie un seul message Telegram de test |
| `replay` | rejoue quelques paris **historiques** dans la vraie chaîne d'alertes ; chaque message est préfixé « 🧪 TEST (rejeu historique) » ; rien n'est écrit dans le registre |
| `backfill` | recharge l'historique complet (uniquement si aucun moniteur ne tourne ; n'envoie rien) |

Relance sans passer par l'interface : modifier le fichier `.kick` et pousser sur `main`.

## Changer les seuils

Modifier `config.json` sur `main` ; le changement est pris au prochain run (au plus tard 5 h 20 après, ou tout de
suite en arrêtant le run en cours puis en relançant). Les réglages principaux :

| Clé | Défaut | Rôle |
|-|-|-|
| `POLL_SECONDS` | 3 | intervalle de lecture du flux |
| `NEW_SETTLE_S` | 20 | attente avant d'envoyer un nouveau pari (regroupe la rafale) |
| `INCREASE_MIN_USD` | 100 | renfort minimal notifié |
| `INCREASE_MIN_GAP_S` | 600 | délai minimal entre deux alertes d'une même position |
| `INCREASE_BIG_RATIO` | 0.5 | un renfort ≥ 50 % de la position part sans attendre ce délai |
| `SELL_SETTLE_S` | 20 | attente avant d'envoyer une vente |
| `BOOK_PRICE_MARGIN` | 0.02 | « $ disponibles jusqu'à prix d'entrée + 0,02 » |
| `LATE_LAG_S` | 120 | au-delà, mention « détecté en retard » |
| `RESOLVE_POLL_S` | 120 | fréquence de vérification des résultats |
| `RECONCILE_ALERT_MAX_AGE_S` | 86400 | âge maximal d'un fill rattrapé pour être notifié |
| `INITIAL_WINDOW_S`, `STAKE_BUCKETS` | 60, [100…50000] | tableau de bord : mise initiale, tranches de mise |
| `WALLET`, `TZ` | — | wallet suivi, fuseau des heures affichées |

Les autres clés (bail, relais, délais HTTP) sont décrites dans `src/core/config.ts`.

## Arrêter le moniteur

1. Onglet **Actions** → menu « … » du workflow **monitor** → **Disable workflow** (plus de chien de garde ni de relais).
   Faire de même pour **daily**.
2. Annuler le run en cours (**Cancel run**) : il libère le bail et s'arrête.

Pour redémarrer : **Enable workflow**, puis **Run workflow** (mode `run`).

## Essais en local

```bash
npm ci
npm test                 # vitest
npx tsc --noEmit
# Moniteur à blanc : rien n'est envoyé, l'état va dans un répertoire local (pas de git)
DRY_RUN=1 STORE_DIR=/tmp/cs2-store MAX_RUN_S=120 node src/runner/main.ts
DRY_RUN=1 STORE_DIR=/tmp/cs2-store node src/runner/main.ts replay
```

## Limites à connaître

- **Pas du temps réel strict** : détection quelques secondes après le pari, alerte 20 s plus tard (regroupement).
  Le prix a pu bouger ; la ligne « Dispo maintenant » montre ce qu'il reste dans le carnet à l'instant de l'envoi.
- **Relais et pannes** : pendant un passage de relais ou après un crash, la détection peut prendre de quelques
  secondes à ~10-15 min (le `schedule` de GitHub n'est pas ponctuel) ; rien n'est perdu, les alertes rattrapées
  portent la mention de retard.
- **Au moins une fois** : si un run meurt entre l'accusé de réception de Telegram et l'écriture sur la branche `data`
  (quelques secondes), l'alerte concernée peut être envoyée une seconde fois par le run suivant.
- **GitHub désactive les workflows planifiés d'un dépôt sans activité pendant 60 jours** ; un courriel prévient.
  Il suffit de réactiver le workflow.
- **API non documentée contractuellement** : aucun identifiant de ligne, d'où le dédoublonnage par multiensemble
  et la réconciliation quotidienne. Ventes, MERGE, SPLIT : gérés mais testés uniquement sur des lignes synthétiques
  (ce wallet n'en a jamais fait) ; CONVERSION : signalée, non interprétée.
- **Dépôt public** : l'historique des paris du wallet suivi (données publiques de Polymarket) est visible sur la
  branche `data`. Les secrets ne le sont pas.
- L'historique de la branche `data` est compacté à chaque prise de bail (un seul commit) pour que le dépôt ne grossisse pas.
