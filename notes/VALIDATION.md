# Independent QA validation: cs2-wallet-monitor

- Audit date: 2026-11-13, 08:25 to 08:50 UTC.
- Auditor: independent QA (read-only on GitHub; this file is the only file written in the repo, and it is not committed).
- Code audited: `origin/main`. The production run `43392757587` ran commit `90a6868`. `src/` is identical to `2855cff` and `171e4a1`, so line references below hold for current `main`.
- Production data audited: `origin/data`, snapshots at 08:25, 08:29 and 08:46 UTC.
- Primary sources: Data API v2 (`/activity`, `/trades`, `/positions`), Gamma `/markets` and `/events`, Polygon receipts (publicnode, plus drpc for 3 older txs that publicnode had pruned), and the polymarket.com profile page.
- All scripts and raw outputs are in `/tmp/claude-0/-home-user/0b0b89e3-1d8f-579a-89c4-580887b6cffb/scratchpad/qa/` (`harness/` holds the TypeScript harnesses).

> Out of scope: I cannot verify that any Telegram message physically reached the owner's phone. That is checked separately with the owner. The evidence below does show that, as of the audit, no alert could have reached it.

## Verdict table

| # | Check | Verdict | One-line evidence |
|-|-|-|-|
| 1 | Wallet identity | **PASS** | config/code = `0xc9bfc7986767173b4f1c3fc9b2c6b255fc7381c0`; profile URL HTML and Gamma `public-profile` give `proxyWallet` = the same address |
| 2 | Ledger completeness vs API, on-chain amounts | **PASS** | 11 100/11 100 fills, multiset diff 0/0 (exact floats) vs `/activity` and `/trades`; 825/825 events; 28 txs / 31 fills match `OrderFilled` exactly |
| 3 | CS2 detection | **FAIL** (latent) | all 738 traded markets are CS2 and all are flagged `cs2:true`; but real CS2 **outright** markets (e.g. `pgl-major-singapore-2026-winner-…`) are classified non-CS2, so **no alert** would be sent |
| 4 | French translation | **PASS** (traded types) | 754/754 (market, outcome) pairs match my reading of the Gamma description; 661 closed positions re-derived from the final map score agree with the resolution (0 errors) |
| 5 | Amounts / PnL / ROI | **PASS** | 754 positions × 13 fields recomputed from raw API rows: 0 mismatches; totals identical; `/v2/positions` open/closed sets identical, realized PnL within rounding (Σ diff $44 on $584k) |
| 6 | Aggregation (no fill in 2 alerts, amounts = Σ fills) | **PASS** (with documented at-least-once) | 36 fuzz scenarios, 5 616 live fills, 1 791 alerts, 86 hard kills: 0 missing, 0 double-counted, 0 amount errors; 1 duplicated phone message when killed between Telegram `ok` and the journal write |
| 7 | Sells / closes / results | **FAIL** (latent) | REDUCE/CLOSE/RESULT fire and the dashboard PnL is right, but the CLOSE alert's "PnL réalisé" is wrong when a buy follows a sell (+37,50 $ shown, +30,00 $ true) |
| 8 | Resume after interruption | **PASS** | real monitor ran 3× on one store; 12 deleted rows recovered exactly once (`src:live`, lag > 120 s), 2 INCREASE alerts carrying « ⏱ Détecté en retard », 0 duplicates on rerun |
| 9 | Production persistence and liveness | **FAIL** | monitor **not running** since 08:31:28 UTC (lease stale >15 min, never released); 0 watchdog (`schedule`) runs ever; Pages deploy failed; Telegram returns `400 chat not found`; `main` now forces `DRY_RUN=1` |
| 10 | Detection latency | **PARTIAL** | no real alert was ever sent (`ledger/alerts.jsonl` does not exist; the one alert attempt failed 4×). Fill→detection on 8 production live fills: median 3 s, max 15 s. Local API first-seen lag on 5 fresh fills: 1.7–5.0 s |
| 11 | Secret hygiene (public repo) | **PASS** | no token or chat id in code, history or completed-run logs (only a fake test token); logs show `***`; error paths scrub secrets |
| 12 | Other wrong, missing or misleading alerts | see defects | 13 defects listed below |

**Bottom line:** the data layer (ledger, positions, PnL, translation) is accurate when checked against primary sources. The delivery layer does not work. As of 08:50 UTC no alert has ever reached Telegram, the monitor is down, notifications are switched off on `main`, and nothing will restart the monitor until a GitHub `schedule` run happens to fire.

---

## Evidence

### 1. Wallet identity: PASS
- `config.json:2` and `src/core/config.ts:64` both set `WALLET = 0xc9bfc7986767173b4f1c3fc9b2c6b255fc7381c0`. The workflows do not override it.
- `curl -L https://polymarket.com/@0xc9bfc7986767173b4f1c3fc9b2c6b255f?via=71729` returns HTTP 200, 599 kB.
  - The page contains `"proxyWallet":"0xc9bfc7986767173b4f1c3fc9b2c6b255fc7381c0"` 29 times.
  - The handle `0xC9BFc7986767173b4f1c3FC9B2c6b255F` is the API `name` field.
- `gamma-api.polymarket.com/public-profile?address=0xc9bf…81c0` returns `proxyWallet` = the same address, `pseudonym: "Stiff-Desktop"`.

### 2. Ledger completeness: PASS
- Full history fetched with cursor pagination and cache-busting (`fetch_all.py`):
  - `/v2/activity` (all types): 11 925 rows, 24 pages.
  - `/v2/trades?taker_only=false`: 11 100 rows.
- Production `ledger/fills.jsonl` (snapshot 08:29, max ts 1794558406) has 11 100 rows. `i` runs 0..11099 with no gaps.
- `cmp_ledger.py` multiset on (tx, token, side, size, price, ts), exact floats:
  - **missing 0, extra 0** vs `/activity` TRADE rows ≤ cutoff.
  - **0/0** vs `/trades`.
  - `usdc_size` mismatches: 0.
  - Duplicate keys: 0 in the ledger, 0 in the API.
- Events: 825 in the API (REDEEM 738, rebates 70, DEPOSIT 11, WITHDRAWAL 5, TIP 1) and 825 in the ledger; diff 0/0.
- Sources of ledger rows: `backfill` 11 094, `live` 6 (8 at 08:46). Sides: 100 % BUY; the wallet never sold.
- On-chain check (`onchain.py`, `onchain_check.py`):
  - Sample: 28 txs = 14 random taker fills, 10 random maker fills, the first and last fills, and both multi-row txs (`0x077bc5…` with 2 rows, `0xaa200a…` with 3 rows). 31 ledger fills in total.
  - Each was matched one-to-one to an exchange log (`0xe111180000d2663c0091e4f400237545b87b996b`, topic0 `0xd543adfd…`, topic2 = wallet).
  - Data words: `[side, tokenId, usdcAmount, shares, fee, …]`.
  - All 28/28 match exactly: `size = shares/1e6`, `usdc_size = (usdcAmount+fee)/1e6`, `fee = fee/1e6`, `price = usdcAmount/shares`, ts = block timestamp.
  - The `taker` flag matches (taker ⇔ counterparty = the exchange contract).

### 3. CS2 detection: FAIL (latent)
- All 738 traded `condition_id`s have Gamma `seriesSlug = counter-strike` and a `cs2-` slug, and all 11 100 fills are `cs2:true`. Today, no CS2 fill is excluded and no non-CS2 fill exists.
- The filter is `isCs2()` (`src/core/ledger.ts:24-27`): it requires `seriesSlug === "counter-strike"` or an event slug starting with `cs2-`. It never looks at Gamma `tags`.
- Real CS2 outright markets have `seriesSlug: null`, no `series`, and tags `cs2` / `counter-strike-2`. Running the real code (`harness/outright.ts`) on two of them:
  - `pgl-major-singapore-2026-winner-1793811600000` ("Will FURIA Win the PGL Major Singapore 2026?"): `isCs2=false`, fill `cs2:false`, `ingestFill` returns `false`. **No alert.** The translator even has an `outright` branch, and it produces a correct sentence.
  - `will-faze-win-a-tier-1-event-in-2026`: same result.
- No false positive found. A non-CS2 market whose slug starts with `cs2-` would pass the filter, but none exists.

### 4. Translation: PASS for the traded types
- **Types traded (754 pairs):**

  | Type | Outcome 0 | Outcome 1 |
  |-|-|-|
  | moneyline | 188 | 177 |
  | child_moneyline (map winner) | 76 | 68 |
  | map_handicap | 65 | 112 |
  | totals | 18 | 29 |
  | round_handicap_game_1 | 1 | 9 |
  | round_handicap_game_2 | 4 | 4 |
  | round_handicap_game_3 | 0 | 3 |

  Formats: BO3 736, BO1 9, BO5 9.
- **Method (`indep_translate.py`):**
  - For every pair I parsed **Gamma's `description` rule** myself. Examples: `resolve to "X" if X wins N or more maps than Y … Otherwise "Y"`, `"Over" if … play N or more maps`, `X wins Map k by N or more rounds`.
  - From that rule I derived the set of winning final scores, or the (team, map, margin) tuple.
  - I extracted the same tuple from the system's `winConditionFr` with `describeBet` run on my own Gamma fetch, not on `markets.json`, and compared the two.
  - `site/data.json` `bet`/`win` = fresh `describeBet` for 754/754.
- **Result:** **754/754 agree** (0 failures).
  - This covers both outcome indices of map handicaps (−1.5 / +1.5 BO3; −1.5 / −2.5 / +2.5 BO5), totals 2.5 / 3.5, round handicaps ±3.5 on maps 1–3 (including the « carte 3 non jouée ⇒ 50-50 » note), map winners, and BO1/BO3/BO5 match winners.
  - Outcome 0 = the minus side of the handicap: confirmed against the description for all 177 map-handicap markets.
- **Resolution check:**
  - For 740 closed positions, `data.json` status equals Gamma `outcomePrices[oi]` (740/740).
  - For 661 of them, I re-derived the outcome independently from the event's final map score (`events[0].score`, oriented by title order) using the description rule: **661/661 agree**.
    - Breakdown: moneyline 356, map handicap 173, totals 47, map winner 83 (sweeps only), round handicap map 3 not played → 50-50: 2.
  - Round-handicap margins on played maps could not be checked: no per-map round scores are available.
- 42-row sample table (all 22 type × index × format × line groups): `translation_sample.md` in the scratch dir. Examples:
  - `Map Handicap: RED.A (-1.5) vs QUINTESSÊNCIA (+1.5)`, outcome "RED Canids Academy" (0) → « RED Canids Academy -1,5 carte — doit gagner 2-0 ». Score 0-2 → lost. System says lost.
  - BO5 `+2.5` → « Alter Ego doit gagner au moins une carte (victoire, ou défaite 1-3 ou 2-3) : pari perdu seulement si FlyQuest gagne 3-0 ». This matches the rule.

### 5. Amounts: PASS
- `amounts.py` recomputes every position (754 ≥ 20) from the raw `/activity` rows plus Gamma settlement prices, and compares 13 fields with `site/data.json`:
  - Fields: shares, cash incl. fees, fees, average price (Σsize·price/Σsize), odds, initial (first 60 s), increases, number of fills, first ts, status, payout, PnL, ROI.
  - **0 mismatches.**
- Global totals (recomputed = `data.json`):

  | Total | Value |
  |-|-|
  | staked | 3 162 971.14 |
  | staked_closed | 3 054 897.11 |
  | staked_open | 108 074.04 |
  | fees | 63 269.82 |
  | PnL | **584 181.58** |
  | ROI | 0.1912 |
  | won / lost / void / open | 414 / 312 / 14 / 14 |
  | win rate | 0.5702 |
  | taker / maker rebates | 13 596.67 / 759.65 |
  | deposits / withdrawals | 244 732.65 / 48 260 |

  Cross-check: Σ payout = staked_closed + PnL = 3 639 078.69 = Σ REDEEM `usdc_size` (exact).
- Against `/v2/positions`:
  - OPEN: 14 vs 14, same token set; held shares equal.
  - CLOSED: 740 vs 740, same token set; PnL sign agrees 737/737.
  - Realized PnL differs only by API rounding: max |Δ| = $1.50, Σ API 584 225.69 vs 584 181.50 (0.008 %).
  - 2 open tokens differ only because the API was read later (new fills).

### 6. Aggregation: PASS, with the documented at-least-once behaviour
- **Code review (`src/core/alerts.ts`):**
  - The state stores only ledger indices.
  - `ingestFill` refuses an index that is already pending or already in the outbox (`alerts.ts:41-42`).
  - `dueAlerts` empties `ps.buys` / `ps.sells` when it creates a draft.
  - `resultAlerts` attaches leftover fills and then deletes the position state.
  - `Pipeline.load` drops outbox drafts already in `alerts.jsonl` (`pipeline.ts:94-101`). It re-queues only fills at index ≥ `ledger_n`.
  - Ledger dedup is a multiset on (tx, token, side, price, size, ts) (`ledger.ts:15-17, 125-152`).
- **Harness (`harness/sim.ts`, `harness/fuzz.ts`; mine, not the project's tests):**
  - It drives the **real `runMonitor`** with a fake API, a fake Telegram sender, a simulated clock, and an in-memory store that loses everything since its last `sync` on a crash.
  - Adversarial inputs:
    - identical duplicate rows in one tx (15 % of bursts);
    - extra same-tx rows;
    - shuffled API order;
    - the previous response returned again (30 % of polls);
    - late indexing of 150–550 s on 10 % of rows;
    - random BUY/SELL bursts;
    - hard kills at a random I/O operation (API call, Telegram send, sleep), followed by a restart after the lease went stale;
    - final resolution of every market.
  - Results over 36 scenarios (12 seeds × {clean, permuted+dup windows+sells, the same plus crashes}): 5 616 live fills, 1 791 recorded alerts, 86 hard kills.
    - **missing 0**: every live fill is in exactly one recorded alert (NEW, INCREASE, REDUCE, CLOSE, or RESULT for sub-threshold leftovers).
    - **double-counted 0**.
    - **alert `usdc` ≠ Σ `usdc_size` of its fills: 0**.
    - ledger length = truth in 36/36 scenarios.
    - Backfill fills alerted: 0.
  - At-least-once: 1 Telegram message out of 1 828 was re-sent after a kill landed exactly between Telegram `ok:true` and the `alerts.jsonl` write. The README documents this ("Au moins une fois").

### 7. Sells, closes, results: FAIL (latent, the wallet never sold)
`harness/sells.ts` runs the real monitor on synthetic rows that copy every field of a real `/v2/activity` TRADE row (output: `sells_out.txt`, `sells_out_CDE.txt`).

| Scenario | Alerts produced | Dashboard | Verdict |
|-|-|-|-|
| A: 2 buys (incl. fee), partial sell, close | NEW 51 $ (fee 1,00); REDUCE `+9,75 $`, remaining `90,75 $`; CLOSE `+44,25 $` | sold, PnL 54 | correct |
| B: buy, sell half, **buy again**, close | REDUCE `+15 $`; CLOSE **`+37,50 $`** | PnL 45 (15 + **30**) | **alert wrong** (−7.50 $ error) |
| C: buy, partial sell, resolved WON | RESULT ✅ « Mise totale 82 $, **Encaissé 150 $**, PnL +98 $ » | won, PnL 98 | PnL right; "Encaissé" leaves out the 30 $ of sale proceeds (150 − 82 ≠ 98) |
| D: resolved LOST | RESULT ❌ −30,60 $ (−100 %) | lost | correct |
| E: resolved 50-50 | RESULT ↩️ « REMBOURSÉ 50-50 », +20 $ (+66,7 %) | void | correct (bought at 0.30) |
| F: oversell (150 sold, 100 known) | CLOSE `+15 $` | PnL 40, warning shown | alert uses unclamped shares: inconsistent with the dashboard |

RESULT alerts appear only once the scheduled start time has passed (`pipeline.ts:224`).

### 8. Resume after interruption: PASS
I ran `DRY_RUN=1 STORE_DIR=<scratch>/store8 MAX_RUN_S=90 NODE_USE_ENV_PROXY=1 node src/runner/main.ts` three times. Logs: `run8_1.log`, `run8_2.log`, `run8_3.log`.

1. **Run 1:** bootstrap gave 11 105 fills (11 069 from the local `data/raw`, 36 from the API). Reconcile found 0 phantoms. No alerts.
2. **Between runs:** I deleted the **last 12 rows** of `ledger/fills.jsonl` (`head -n -12`).
3. **Run 2:** « flux: 12 nouveau(x) fill(s) ». Two alerts:
   - « ➕ RENFORT … Ajout : 1 773 $ (5 exécutions) … ⏱ Détecté en retard à 09:41 (18 min après le pari de 13/11 09:22) »
   - « Ajout : 2 723 $ (7 exécutions) … ⏱ Détecté en retard … »
   - The sums are exact: 1 773.02 and 2 722.94.
4. **Run 3:** 0 new fills, 0 alerts.
- Final ledger = run-1 ledger as a multiset (lost 0, extra 0, duplicate keys 0).
- The 12 recovered rows are `src:"live"` with `lag_s > 120`.
- No fill appears in more than one alert.

### 9. Production persistence and liveness: FAIL
- **Runs:** only 8 runs exist (`gh api …/actions/runs`).
  - Monitor `43392757587` (push, 08:22:49) is **cancelled** at 08:32:03. Its log shows the node process killed as an "orphan process". There is no « arrêt demandé » / « bail: libéré ».
  - Monitor `43393928668` (push of `.kick`, 08:31:51) started while the old run was still alive. It logged « bail: un autre run est vivant, arrêt (chien de garde) » and exited after 11 s. That is the expected fast exit, but it left **no run holding the lease**.
  - **0 `schedule` runs ever** (`?event=schedule` → total_count 0) at 08:46, although `*/10 * * * *` has been active since 08:22.
- **Lease and data freshness at 08:47 UTC:**
  - `state.json` lease `gh-43392757587-1`, `released:false`, `heartbeat_ts 1794558688` (08:31:28): 942 s old, stale threshold 120 s.
  - `site/heartbeat.json` and `site/data.json` were last regenerated at 1794558584: 1 046 s old.
  - Last data commit: `36ee8c2 08:31:28 battement`.
  - While it ran, the lease heartbeat committed every 45 s (`56f2270 08:29:58`, `2f9b5e3 08:30:43`, `36ee8c2 08:31:28`) and `data.json` was regenerated on every new fill. Persistence worked while the job was alive.
- **Missed fills:** 3 fills totalling **$3 858** (08:34–08:37 UTC: 1 282.14 $ Nexus, 460.85 $ and 2 115.08 $ ex-RUSTEC) are on the API and not in production.
- **Telegram:**
  - The monitor log shows « démarrage: ÉCHEC de l'envoi Telegram (http 400) », then « telegram: échec de l'alerte a1 (http 400) » on tries 1 to 4.
  - The `telegram-test` run `43393543447` logged « getMe : http 200 ok=true » and then « sendMessage : http 400 — Bad Request: chat not found ».
  - Alert `a1` is still stuck in `state.alerts.outbox`. It is an INCREASE of 147.01 $ covering fills 11096 and 11098–11101.
- **`main` now sets `DRY_RUN: "1"`** in `monitor.yml:57` (commit `171e4a1`, « Notifications Telegram désactivées à la demande du propriétaire »). Any run that does start will send nothing.
- **Pages:** run `43393005801` failed with « Get Pages site failed … Not Found ». `has_pages:false`, so the dashboard is not published.
- **Logs:** completed-run logs were read: CI ×4 (254 tests pass), pages, telegram-test, both monitor runs.

### 10. Detection latency: PARTIAL (no real alert exists)
- No real alert exists in production. `ledger/alerts.jsonl` is absent and `state.alerts.seq = 1`; that single alert was never delivered. Fill→detected→Telegram-sent latency therefore cannot be measured, and none occurred.
- Fill block time → `detected_ts` for the 8 production `live` fills: 15, 9, 3, 3, 1, 3, 1, 1 s (median 3 s). The 15 s and 9 s values occurred during bootstrap.
- Local poller (`poll_lag.py`: `/v2/activity` every 2 s with `_=<ms>`, 20 min, 08:28:51–08:48:51 UTC, 0 errors): 5 fresh fills.
  - First-seen lag after block time: **5.0, 5.0, 1.7, 5.0, 1.8 s** (2 of them in one block), i.e. 1.7–5.0 s with a 2 s polling resolution.
  - The API timestamp equals the block timestamp (verified on-chain in check 2).
  - Add the 20 s `NEW_SETTLE_S` to get the expected alert time for a new bet.

### 11. Secret hygiene: PASS
- `git grep` over all revisions found only the fake `123456789:AAFakeTokenForTests_…` in `test/telegram.test.ts`.
- The token and chat id are read only from env (`env.ts:37,51`).
- `scrub()` is applied to every log line; HTTP errors log only host and path (`polymarket.ts`); git errors log only exit codes.
- `dispatchSuccessor` passes the token through env with `stdio:"ignore"`.
- `scripts/telegram-diag.ts` prints only presence and shape and scrubs Telegram's `description`.
- Completed-run logs: 1 011 lines, 26 `***` masks, no `bot<digits>:` pattern, no raw chat id.
- `ci.yml` (the only workflow on `pull_request`) has no secrets.

---

## Defects (severity-ranked)

| # | Sev | Defect | Location | Reproduction / evidence |
|-|-|-|-|-|
| D1 | **Critical** | **No alert can reach the phone.** Telegram rejects every send with `400 Bad Request: chat not found` (wrong `TELEGRAM_CHAT_ID`, or `/start` never sent to the bot). The very first alert `a1` is stuck in the outbox. | secret config; `src/runner/telegram.ts:67-74` | run logs `43392757587` (« ÉCHEC … http 400 », a1 tries 1–4) and `43393543447` (« chat not found ») |
| D2 | **Critical** | **Notifications are disabled on `main`** (`DRY_RUN: "1"`). Drafts are then marked `status:"dry"` and removed from the outbox (`pipeline.ts:292-297`), so every alert produced while DRY_RUN is on is **permanently lost**, even after Telegram is fixed. This contradicts the system's core claim. I cannot verify the owner's alleged request. | `.github/workflows/monitor.yml:57`; `src/runner/pipeline.ts:292` | `git show origin/main:.github/workflows/monitor.yml` |
| D3 | **Critical** | **Monitor down, no self-recovery.** Cancelling a run does not release the lease: SIGTERM/SIGINT never reach node, which is killed as an orphan. The `.kick` run that was meant to replace it exited because the lease still looked alive. The `*/10` watchdog has **never fired**. As a result, fills (3 so far, $3 858) are not being detected. README:92 (« Cancel run : il libère le bail ») is false. | `src/runner/main.ts:28-29`, `src/runner/monitor.ts:30-33`, `.github/workflows/monitor.yml` (schedule), `README.md:92` | lease `released:false`, heartbeat 08:31:28; runs list: 0 `schedule` runs; job log « Terminate orphan process: pid (2208) (node) » |
| D4 | High | **CS2 outright (tournament-winner) bets are never alerted**: the filter ignores Gamma `tags` (`cs2`, `counter-strike-2`); these events have `seriesSlug:null` and non-`cs2-` slugs. | `src/core/ledger.ts:24-27`, `src/core/alerts.ts:39` | `node harness/outright.ts` → `isCs2:false, alertMachineAccepts:false` for `pgl-major-singapore-2026-winner-1793811600000` |
| D5 | Medium | **Not "every bet":** follow-up buys below 100 $ cumulative (or within 10 min of the last alert, unless ≥ 50 % of the position) are held back. They may surface only in the RESULT message. The 6 production live fills of $2–$23 produced no alert for 7 minutes. Pre-bootstrap positions never get a NEW alert. | `src/core/alerts.ts:113-122` (thresholds), `config.json` | prod `state.alerts.pos` showed `pending: 6` |
| D6 | Medium | **CLOSE/REDUCE "PnL réalisé" is wrong when a buy follows a sell**: it uses `p.cash/p.bought` instead of the average-cost basis at the time of the sale. | `src/core/alerts.ts:73-74` | `harness/sells.ts` scenario B: alert `+37,50 $`, true `+30,00 $` |
| D7 | Medium | **Delivery failures are silent**: the startup "en service" message is attempted once and never retried; failed alerts retry forever every ≤ 5 min with no escalation; the dashboard is not published (Pages not enabled). The owner cannot notice that no alerts are coming. | `src/runner/monitor.ts:125-133`, `src/runner/pipeline.ts:259`, `pages.yml` run failure | logs above |
| D8 | Low | **Amounts ≥ 100 $ shown rounded to the dollar** (« Ajout : 2 723 $ » for 2 722.94). This is not the exact stake that was asked for. | `src/core/format.ts:9` | run8_2.log |
| D9 | Low | **RESULT message "Encaissé" leaves out earlier sale proceeds**, so the message's numbers do not add up. | `src/core/format.ts:138` | sells scenario C: 82 $ in, « Encaissé 150 $ », PnL +98 $ |
| D10 | Low | **The oversell alert's PnL is not clamped** like the position's. | `src/core/alerts.ts:73-74` vs `positions.ts:30-35` | sells scenario F: +15 $ vs +40 $ |
| D11 | Low | **The dedup key leaves out `usdc_size`.** Two rows that are equal except for the fee can be swapped depending on API order, giving a wrong stake. Not observed in the data: 0 colliding keys. | `src/core/ledger.ts:15-17,133-136` | `node harness/collide.ts` → `[50, 50]` instead of `[50, 51]` |
| D12 | Low | **"🔴 LIVE (match commencé)" is inferred from the *scheduled* start**, not the actual start; matches often start late. | `src/core/ledger.ts:30-36`, `src/core/format.ts:158` | code |
| D13 | Low | **Resolution polling only begins after the scheduled start.** MERGE/CONVERSION change positions without any alert. A position opened and resolved while the monitor was down gets a late NEW alert but no RESULT, because it never entered `state.open`. | `src/runner/pipeline.ts:224`, `src/core/positions.ts:106-134`, `src/core/alerts.ts:145-150` | code review; never happened for this wallet |

**What is solid:** ledger completeness and dedup against the API and on-chain data, position, PnL and ROI arithmetic, French translation of all market types this wallet trades, and crash/resume and aggregation invariants under adversarial input.

**What blocks the system's claim:** D1, D2 and D3. Fixing them requires the owner, not code alone: a correct chat id plus `/start` to the bot, `DRY_RUN` removed, and a run started manually.
