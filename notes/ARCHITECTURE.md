# Architecture (décisions de l'orchestrateur — fait foi pour tous les agents)

Wallet suivi : `0xc9bfc7986767173b4f1c3fc9b2c6b255fc7381c0` (Polymarket « Stiff-Desktop », 100 % CS2).
Lire d'abord `notes/API_NOTES.md` (faits vérifiés sur l'API v2) — surtout la section 0.

## Contraintes d'hébergement

- Dépôt GitHub **public** `Keyoos33/cs2-wallet-monitor`. Tout tourne dans GitHub Actions (minutes gratuites).
- Secrets Actions existants : `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`. Ne jamais les écrire dans un fichier,
  un log, un message d'erreur ou une URL journalisée. Ne jamais journaliser la réponse brute de Telegram.
- Le dépôt étant public : logs sobres, aucune donnée personnelle du propriétaire.
- Node 22+ exécute le TypeScript directement (`node src/runner/main.ts`, imports avec extension `.ts`,
  syntaxe « erasable » uniquement : pas d'enum, pas de namespaces, pas de parameter properties).
  **Zéro dépendance runtime** (fetch natif, fs, child_process pour git). vitest pour les tests.

## Composants

```
src/core/      PUR (pas de réseau/disque) : types, translate (agent traducteur), gamma, format,
               ledger (dédup), positions, alerts (regroupement), stats, dashboard-data
src/runner/    I/O : polymarket.ts (client HTTP), telegram.ts, store.ts (état sur branche git `data`),
               lease.ts, main.ts (boucle), backfill.ts, replay.ts (rejeu TEST)
.github/workflows/monitor.yml   boucle longue auto-relancée + chien de garde
site/          dashboard statique (GitHub Pages) qui lit le JSON de la branche `data`
```

### Branche `data` (orpheline, écrite uniquement par le runner)

```
state/state.json       curseur, bail (lease), battement de coeur, agrégats d'alertes en attente, clés déjà notifiées
ledger/fills.jsonl     registre append-only : une ligne par fill (ligne brute API + champs dérivés), jamais réécrit
ledger/events.jsonl    REDEEM, rebates, dépôts/retraits (bruts)
ledger/alerts.jsonl    chaque alerte envoyée : id, kind, clés de fills couverts, texte, ts envoi, latences, statut Telegram (ok/erreur sans détail sensible), is_test
ledger/markets.json    cache des métadonnées Gamma par condition_id (+ résolution)
site/data.json         données du dashboard (schéma DashboardData dans src/core/types.ts)
site/heartbeat.json    {ts, run_id, last_poll_ok_ts, last_fill_ts, polls, errors}
```

Commits sur `data` : immédiatement après chaque alerte envoyée (pour ne pas re-notifier après un crash),
et un battement de coeur toutes les 5 min. `git pull --rebase` + retry en cas de rejet.

### Boucle de détection (`main.ts`)

1. Toutes les `POLL_SECONDS` (défaut 5) : `GET /v2/activity?user=W&limit=200&start=<cursor-600>&_=<ms>`
   (le paramètre `_` contourne le cache CDN de 15 s). Timeout 8 s ; erreurs comptées, backoff exponentiel plafonné à 60 s
   sur 429/5xx. Si une page revient pleine (200), paginer avec `next_cursor` jusqu'à recouvrir le curseur.
2. Dédup par **multiensemble** : clé `(transaction_hash, token_id, side, price, size, timestamp)` + compteur d'occurrences
   (deux lignes identiques légitimes ne doivent pas être fusionnées ; une ligne déjà vue ne doit jamais être recomptée).
3. Chaque nouveau fill : `detected_ts` (horloge murale), `lag_s = detected_ts - timestamp`, taker si `usdc_size > size*price + 1e-6`,
   métadonnées de marché (Gamma, cache ; `closed=false` puis `closed=true`), phase PRÉ/LIVE = `timestamp < gameStartTime` (heure *prévue*).
   Filtre CS2 : `seriesSlug == "counter-strike"` ou slug d'événement préfixé `cs2-`. Les fills non-CS2 vont au registre mais ne déclenchent pas d'alerte.
4. Reprise après interruption : au démarrage, relire l'état, repartir de `cursor - 3600 s`, paginer tout ce qui manque.
   Les fills découverts avec `lag_s > 120` sont notifiés avec la mention « détecté en retard (HH:MM) ».
5. Résolutions : toutes les 2 min, pour les positions ouvertes dont le match a commencé, interroger Gamma (cache contourné) ;
   les lignes REDEEM de l'activité confirment. Une résolution clôt la position (gagné / perdu / remboursé 50-50) et envoie une alerte RÉSULTAT.

### Montants — règles strictes (pas de mise inventée)

- `usdc` d'un fill = `usdc_size` de l'API (frais taker inclus = sortie réelle de cash). Notional hors frais = `size*price`. Frais = différence.
- Mise affichée = cash réellement sorti (frais inclus), avec les frais indiqués à part. Prix d'entrée = moyenne pondérée **hors frais** (`Σ size*price / Σ size`).
- Position = par `token_id`. Coût moyen pondéré. SELL : PnL réalisé = produit − coût moyen × parts vendues. MERGE/SPLIT/CONVERSION : gérés
  proprement (le wallet n'en a aucun à ce jour ; tester sur fixtures synthétiques, marquées comme telles).
- Résolution : payout = parts × prix de règlement (1, 0 ou 0,5). PnL = payout + ventes − cash sorti (frais inclus). ROI = PnL / cash sorti.
- Les rebates (MAKER_REBATE/TAKER_REBATE) sont comptés à part dans le PnL global, jamais attribués à un pari.

### Regroupement des alertes (`core/alerts.ts`) — anti-spam sans perte d'information

Réalité mesurée : une position se construit en médiane en 6 fills sur 2 h (jusqu'à 687 fills), fill médian 47 $.
Une alerte par fill serait inutilisable. Règles (toutes configurables dans `config.json`) :

- **NEW** : premier fill sur un token → attendre `NEW_SETTLE_S` (20 s) pour agréger la rafale, puis envoyer. Priorité haute.
- **INCREASE** : fills suivants cumulés ; envoyer quand (cumul ≥ `INCREASE_MIN_USD` (100 $) ET ≥ `INCREASE_MIN_GAP_S` (600 s) depuis la dernière alerte de cette position)
  OU cumul ≥ 50 % du coût de la position à la dernière alerte (et ≥ 100 $), après 20 s de calme. Le message donne l'ajout ET le total.
- **REDUCE / CLOSE** : toute vente, après 20 s d'agrégation, sans seuil.
- **RESULT** : à la résolution : gagné/perdu, mise totale, PnL, ROI.
- Aucun fill n'est perdu : ce qui est sous les seuils reste dans le registre/dashboard et sera inclus dans la prochaine alerte de la position
  (le total affiché est toujours exact). Un fill n'appartient qu'à une seule alerte (clés enregistrées dans `alerts.jsonl`).
- Chaque alerte NEW/INCREASE inclut le **prix disponible au moment de l'envoi** (`GET clob/book?token_id=` : meilleur ask et taille,
  $ disponibles jusqu'à prix d'entrée + 0,02) pour que l'utilisateur voie s'il peut encore copier. Ces mesures sont stockées (étude de copiabilité).
- Texte : `src/core/format.ts` (`formatAlert`), à étendre (prix dispo, retard, RESULT). Français, fuseau Europe/Zurich.

### Telegram (`runner/telegram.ts`)

`POST https://api.telegram.org/bot<TOKEN>/sendMessage` avec `chat_id`, `text`, `parse_mode=HTML`, `disable_web_page_preview=true`.
Échapper `< > &`. Lien : `https://polymarket.com/event/<event_slug>`. Retry 3× (respecter `retry_after` sur 429). Si l'envoi échoue,
l'alerte reste « pending » et est retentée au prochain tour ; jamais marquée envoyée sans `ok:true`.
Variable `DRY_RUN=1` : n'envoie rien, écrit le texte dans le log (tests locaux).

### Bail et relais (pas de doublon entre deux runs)

- `state.lease = {run_id, acquired_ts, heartbeat_ts}`. Un run n'envoie des alertes que s'il détient le bail.
- Un run dure `MAX_RUN_S` (5 h 20). À `MAX_RUN_S − 300 s`, il lance son successeur (`gh workflow run monitor.yml`, `GITHUB_TOKEN` avec `actions: write`),
  continue jusqu'à ce que le successeur soit prêt (fichier `state/handover.json` poussé par le successeur) ou jusqu'à `MAX_RUN_S`, puis vide
  ses agrégats en attente dans l'état, pousse `lease.released=true` et s'arrête. Le successeur prend le bail dès qu'il voit la libération
  (ou si `heartbeat_ts` a plus de 120 s) et reprend au curseur.
- Chien de garde : `schedule: */10` + `push` sur le fichier `.kick` + `workflow_dispatch`. Un run qui démarre et trouve un bail vivant
  (battement < 120 s) et pas de relais demandé s'arrête en quelques secondes.

### Dashboard (`site/`, GitHub Pages)

Page statique mobile-first qui charge `site/data.json` depuis la branche `data`
(`https://raw.githubusercontent.com/Keyoos33/cs2-wallet-monitor/data/site/data.json`, repli API contents). Construite par un autre agent
contre le schéma `DashboardData`.

## Tests exigés (vitest, `npm test`)

Dédup multiensemble (rejouer deux fois la même fenêtre → 0 nouveau), fills multiples d'une même transaction, reconstruction des positions
contre `data/raw/positions.json` (754 positions : parts exactes, frais exacts ; PnL à ±1,5 $ comme documenté), ventes/fermetures (synthétiques),
regroupement des alertes (jamais deux alertes pour le même fill, seuils), reprise après interruption (état sérialisé puis rechargé au milieu d'une rafale),
relais de bail, format des messages.
