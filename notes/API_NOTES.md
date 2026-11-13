# Polymarket API notes (verified 2026-11-13)

Everything below was observed with real calls on 2026-11-13 against wallet
`W = 0xc9bfc7986767173b4f1c3fc9b2c6b255fc7381c0` ("Stiff-Desktop") unless marked **[docs]** (stated by the
docs / OpenAPI, not independently tested) or **[unverified]**. Numbers are from the backfill in
`data/raw/` (cutoff 2026-11-13 07:26:14Z): 11,069 trade rows, 11,894 activity rows, 754 positions, 738 markets.

Sources: `https://data-api.polymarket.com/v2/openapi.json` (machine-readable contract, the best reference),
`https://docs.polymarket.com/api-reference/data-api/overview.md`,
`https://docs.polymarket.com/migrate/data-api-v1-to-v2.md`, `https://docs.polymarket.com/api-reference/rate-limits.md`.

`D = https://data-api.polymarket.com/v2`, `G = https://gamma-api.polymarket.com`, `C = https://clob.polymarket.com`.

## 0. The ten things that will bite you

1. **`/v2/trades` defaults to `taker_only=true`** and then returns only about half of this wallet's fills
   (5,926 of 11,069). Always send `taker_only=false`.
2. **CloudFront caches by full URL**: `/v2/trades` 300 s, `/v2/activity` 15 s, `/v2/positions` 5 s, `/v2/value` 6 s,
   Gamma `/events` and `/markets` 300 s, both `prices-history` 90 s. CLOB `/book`, `/price` are not cached.
   Polling the same `/v2/trades` URL shows nothing new for up to 5 minutes. Poll `/v2/activity` instead, or change
   the URL (a moving `end=`, or an ignored parameter such as `_=<ms>`).
3. **`usdc_size` on activity TRADE rows includes the taker fee** (it equals the wallet's net pUSD outflow on-chain).
   `size * price` is the fee-exclusive notional. `/v2/trades` has no cash field at all.
4. **A taker row is one aggregate per transaction** (VWAP price, up to 10 decimals); **a maker row is one on-chain
   `OrderFilled` log**, so one `transaction_hash` can give several rows for the same token at different prices.
5. **There is no row id.** `(transaction_hash, token_id, side, price, size)` has 0 collisions in this wallet's history
   but is not guaranteed unique; prefer window replacement to key-based dedup (section 3.3).
6. **CLOSED positions serve `entry_cost_usdc = 0`** and a fee-**inclusive** `avg_price`; OPEN positions serve the
   real fee-exclusive cost and a fee-**exclusive** `avg_price`.
7. **`realized_pnl` is net of fees**: payout minus the sum of `usdc_size` (within 1.5 USDC per position).
8. **This wallet never sells**: 11,069 BUY rows, 0 SELL, 0 MERGE/SPLIT. Every position ends in a REDEEM row
   (winner `usdc_size = size`, loser `usdc_size = 0`, 50/50 `usdc_size = size/2`).
9. **Gamma `/markets?condition_ids=` hides closed markets unless `closed=true`**, and `closed=true` hides open ones;
   ids must be repeated parameters (a comma list returns `[]`); the default `limit` is 20.
10. 96 REDEEM rows from 2026-10-15..21 have an empty `token_id` (4 also `outcome_index: 999`): join redeems on
    `(condition_id, outcome_index)`, not on `token_id`.

## 1. Data API v2: endpoints for a user's history

No auth. Envelope `{data, pagination:{limit, offset, has_more, next_cursor}}`. v1 is gone (HTTP 410);
`GET D/closed-positions?user=W` -> 404.

| endpoint | what | verified call |
|-|-|-|
| `GET D/trades` | fills (user, market, event or global shape) | `D/trades?user=W&limit=1000&start=1&taker_only=false` -> 11,069 rows over 12 pages |
| `GET D/activity` | trades + redeems + rebates + cash movements | `D/activity?user=W&limit=1000&start=1&type=<all 18>&exclude_deposits_withdrawals=false` -> 11,894 rows |
| `GET D/positions` | open and closed positions, PnL | `D/positions?user=W&status=OPEN&limit=1000` -> 14; `...status=CLOSED...` -> 740 |
| `GET D/value` | portfolio mark-to-market | `D/value?user=W` -> `{"proxy_wallet":..,"value":101872.625}` |
| `GET D/user-stats` | profile card, cumulative PnL breakdown | `D/user-stats?user=W` -> `trades: 633` (distinct markets), `join_date: 1780057200`, `all_time_pnl{realized_pnl: 584225.70, fees_paid: -62589.54, taker_rebate: 13596.67, maker_rebate: 759.65, volume_usdc, trade_count: 11051, ...}` |
| `GET D/user-volume` | volume in a window | `D/user-volume?user=W` -> `{volume: 6271183.5, volume_usdc: 3094934.9, trade_count: 11054}`; `start`/`end` floored to UTC days |
| `GET D/user-pnl` | PnL time series | **[docs]** `interval` = max/all/1m/1w/1d/12h/6h, `fidelity` = 1d/18h/12h/3h/1h |
| `GET D/tokens` | token id -> condition, outcome, resolved, final_price | `D/tokens?token_id=a,b` (max 50, comma list) or `?condition=` (max 10) |
| `GET D/resolutions` | UMA resolution state | `D/resolutions?condition=a,b` (max 20) -> `status: posed / resolved`, `price: "1000000000000000000"` |
| `GET D/prices-history` | price series per token | section 6 |
| `GET D/status` | ingestion freshness | `serving.lag_seconds: 1`, `blocks_behind: 1-2` at test time |
| `GET D/positions/combos`, `D/activity/combos` | combo products | both empty for W |

### 1.1 Pagination, limits, history depth

- Cursor only. `limit` default 100, max 1000 on trades / activity / positions (`limit=1001` -> 400
  `limit must be between 0 and 1000`). `offset=` in any form -> 400 (`'offset' is not a query param on this API`),
  so there is **no offset cap**; the `pagination.offset` field is only a running row counter.
- Follow `pagination.next_cursor` until it is `null`. Once a cursor is sent, `limit` is ignored (the cursor carries
  its page size). The feed cursors work without `user` re-sent but only carry the seek anchor, so re-send every filter.
  `/v2/positions` requires `user` with the cursor (bare cursor -> 400) and a contradicting `status` -> 400 `invalid cursor`.
- The cursor is base64 JSON plus a signature, e.g.
  `{"type":"trades","params":{"l":2,"ts":1794553837,"sq":"972322540002002220","d":2}}`. `sq` is the hidden
  sequence id: `block * 1e10 + txIndex * 1e5 + logIndex * 10` (checked against two receipts: block 97232254,
  txIndex 20, logIndex 222). It is not returned on rows.
- **Depth: full history is reachable.** Both feeds walk back to the first trade 2026-05-29 16:35:41Z
  (ts 1780072541) and end with `next_cursor: null`; with deposits included the first row is 2026-05-29 13:23:14Z.
  A full walk is 12 pages of 1000 (about 10 s). Omitted `start` floors to three years back **[docs]**; `start=1`
  asks for everything. For this 5.5-month-old wallet both give the same rows.
- Unknown parameters are silently ignored (`bogus=1`, `after=`, `before=` -> 200 unchanged). Rejected with 400:
  `offset`, `market`, `market_id`. Both snake_case and camelCase names work (`takerOnly`, `conditionId`, `sortDirection`).

### 1.2 `/v2/trades` parameters (all tested)

| param | behaviour |
|-|-|
| `user` | wallet; omit for the market / event / global feed |
| `taker_only` | **default true**. `false` adds the rows where the wallet was maker (5,143 extra here) |
| `start`, `end` | epoch seconds, inclusive, on block timestamp; user shape only. `start=1794000000&end=1794086400` -> 161 rows |
| `condition` (`condition_id`, `conditionId`) | comma list, max 20. One CS2 condition -> 7 rows |
| `event_id` | Gamma event id(s), max 20. `event_id=1371808` -> 77 rows |
| `side` | `BUY` / `SELL` (`SELL` -> 0 rows for W) |
| `filter_type`, `filter_amount` | `CASH` or `TOKENS` minimum; `CASH&filter_amount=1000` -> 659 rows. Default floor 0.01 tokens |
| `limit`, `cursor` | see 1.1 |
| sort | none. `sort_direction=ASC` is ignored; always newest first |

### 1.3 `/v2/activity` parameters (all tested)

| param | behaviour |
|-|-|
| `user` | required (400 without) |
| `type` | comma list of `TRADE, SPLIT, MERGE, REDEEM, CONVERSION, MIGRATION, REWARD, YIELD, MAKER_REBATE, TAKER_REBATE, REFERRAL_REWARD, DEPOSIT, WITHDRAWAL, DIRECTIONAL_SPLIT, DIRECTIONAL_MERGE, THRESHOLD_COMPOSE, THRESHOLD_DECOMPOSE, TIP`; anything else -> 400. Omitted = all except `TIP` |
| `exclude_deposits_withdrawals` | default `true`; DEPOSIT / WITHDRAWAL rows appear only with `false` (`type=DEPOSIT` alone -> 0 rows) |
| `start`, `end` | as trades. `start=1794000000&end=1794086400` -> 185 rows, min/max ts inside the window |
| `condition`, `event_id`, `side` | as trades (`condition` and `event_id` are mutually exclusive **[docs]**) |
| `sort_direction` | `ASC` or `DESC` (default). ASC verified: exact reverse of the DESC walk (11,894 rows) |
| `sort_by` | only `TIMESTAMP`; `CASH` -> 400 |

### 1.4 `/v2/positions` parameters (all tested)

| param | behaviour |
|-|-|
| `status` | `OPEN` (default; superset that also returns `REDEEMABLE`), `REDEEMABLE`, `REDEEMABLE_LOST`, `MERGEABLE`, `CLOSED`. Anything else (`ALL`) -> 400. For W: OPEN 14, CLOSED 740, the other three 0 |
| `sort_by` | `CURRENT_VALUE, PRICE, TOKENS, UNREALIZED_PNL, REALIZED_PNL, TOTAL_PNL, TIMESTAMP` (= `last_event_at`). Default `CURRENT_VALUE` (OPEN) / `REALIZED_PNL` (CLOSED). On CLOSED, `TOKENS` etc. fall back to realized-PnL order |
| `sort_direction` | `ASC` / `DESC` |
| `start`, `end` | bounds on `last_event_at`. `status=CLOSED&start=1794000000` -> 97 rows. Not carried by the cursor |
| `condition`, `event_id`, `title` | narrowing filters; `title=G2` -> 4, `event_id=1371808` -> 4 |
| `filter_type`, `filter_amount` | dust floor (default 0.1 tokens) on OPEN; not applied to a user's CLOSED set |
| `include_archived` | OPEN-family only; with `status=CLOSED` -> 400 |

There is no way to get OPEN and CLOSED in one call. Closed positions = `status=CLOSED`; realized PnL = `realized_pnl`
on each row; the wallet total is `user-stats.all_time_pnl.realized_pnl` (584,225.70 = sum of the 740 closed rows).

## 2. Field semantics

### 2.1 `/v2/trades` row

Fields: `proxy_wallet, side, token_id, condition_id, size, price, timestamp, title, slug, icon, event_slug, outcome,
outcome_index, name, pseudonym, bio, profile_image, profile_image_optimized, transaction_hash`. Nothing else: no id,
no log index, no fee, no cash amount, no maker/taker flag, no order id.

- `timestamp`: block timestamp, seconds. `size`: shares. `price`: USDC per share. `side`: from the wallet's view.
- `title` / `slug` are the **market** question and slug; `event_slug` is the parent event.
- **Taker fill = one row per transaction**, aggregated over every maker order it matched. Verified on-chain: tx
  `0x4b39ed41...` matched 10 maker orders (10 `OrderFilled` logs naming W as counterparty) and the API serves one
  row `size 1490.08, price 0.7373603431`, i.e. `makerAmountFilled / takerAmountFilled` of the taker-order log
  (1098.7259 / 1490.08). Taker prices therefore often have 8-10 decimals (about 440 of 5,926 rows).
- **Maker fill = one row per `OrderFilled` log in which W is the maker.** Tx `0xaa200a56...` has three such logs
  (indices 827, 829, 831) and three rows: `491.81 @ 0.65`, `300 @ 0.66`, `494.2 @ 0.66` (same token, two prices).
- Rows per `transaction_hash` in this history: 11,064 with 1 row, 1 with 2 rows, 1 with 3 rows. Multi-row
  transactions were always same token, same side.
- **Maker/taker flag**: not a field. Derive it by (a) walking the feed twice (`taker_only=true` vs `false`); the
  backfill stores this as `_taker`; or (b) from activity: a TRADE row is a taker row iff `usdc_size > size * price`
  (true for exactly the 5,926 taker rows here, because every market traded has taker-only fees). Split for W:
  5,926 taker rows / 2,777,316 USDC notional vs 5,143 maker rows / 318,409 USDC.

### 2.2 `/v2/activity` row

Same fields as trades plus `type` and `usdc_size` (and `is_combo` on combo rows **[docs]**). TRADE rows are the
same rows as `/v2/trades?taker_only=false`, in the same order: 11,069 vs 11,069, multiset difference 0 in both directions.

- **`usdc_size` on a BUY includes the fee.** Taker rows: `usdc_size = size * price + fee`; maker rows:
  `usdc_size = size * price` (max difference 1e-7). Checked against receipts for all 17 fills of one position:
  `usdc_size` equals the net pUSD transferred out of the wallet to 6 decimals on every row. For SELL rows the sign
  convention is **[unverified]** (W has none).
- **Fee formula** (matches 5,921 of 5,924 taker rows at test time; one more rounds to 0.049): `fee = rate * size * price * (1 - price)` with
  `rate = 0.05`; two trades from 2026-05 used 0.03. The rate is on the Gamma market as
  `feeSchedule: {"exponent":1,"rate":0.05,"takerOnly":true,"rebateRate":0.15}` (`feeType: sports_fees_v3`, 736 of 738
  markets; `sports_fees_v2` with rate 0.03 on the other 2). On-chain it is the fifth data word of the taker
  `OrderFilled` log (3.66 USDC for 305 shares at 0.40). Total taker fees paid: 63,189.69 USDC = 2.3% of taker notional.
- Where fees appear: (1) inside `usdc_size`; (2) `positions[].entry_fees_usdc` (matches the per-token sum of
  `usdc_size - size*price` on all 754 positions); (3) `user-stats.all_time_pnl.fees_paid` = -62,589.54, which is
  about 600 USDC less than the sum of (1) **[unverified why]**; (4) rebates come back as separate
  `TAKER_REBATE` / `MAKER_REBATE` rows.

### 2.3 Activity types for this wallet

| type | rows | sum `usdc_size` | shape |
|-|-|-|-|
| TRADE | 11,069 | 3,159,534.69 | all `side: BUY` |
| REDEEM | 738 | 3,639,078.69 | `side: ""`, `price: 0`, `size` = shares burned, `usdc_size` = payout |
| TAKER_REBATE | 36 | 13,596.67 | no market fields (`condition_id: ""`, `outcome_index: 999`), `size = usdc_size`; daily around 00:10 UTC |
| MAKER_REBATE | 34 | 759.65 | same shape; daily around 00:45 UTC |
| DEPOSIT | 11 | 244,732.65 | only with `exclude_deposits_withdrawals=false` |
| WITHDRAWAL | 5 | 48,260.00 | same |
| TIP | 1 | 0.01 | only when named in `type`; `side: "IN"` |

SPLIT, MERGE, CONVERSION, REWARD, YIELD, MIGRATION, REFERRAL_REWARD: 0 rows.

**Resolution / redeem.** Redemption is automatic (sent by a relayer, not by the wallet); the REDEEM row lands a
median 11 s after Gamma `closedTime` (p90 about 13 min). One row per (transaction, outcome token); a transaction
can redeem several markets (up to 8 rows). `usdc_size / size` is 1.0 on 418 rows (winner), 0.0 on 310 (loser, the
row still exists and shows the burned shares), 0.5 on 10 (50/50 resolution).

**A losing position** therefore looks like: REDEEM row with `usdc_size: 0`; position row `status: CLOSED`,
`current_size: 0`, `current_price: 0`, `realized_pnl < 0`, `redeemable: false`. A winner: `current_price: 1`,
`realized_pnl > 0`. 50/50: `current_price: 0.5`. Closed rows by `current_price`: 414 / 312 / 14. No position was
ever seen in `REDEEMABLE` or `REDEEMABLE_LOST`, because auto-redeem closes it within seconds.

**Degraded REDEEM rows.** 96 REDEEM rows dated 2026-10-15..21 have `token_id: ""`; 92 of them still carry a correct
`outcome_index`. The other 4 are 50/50 resolutions with `outcome_index: 999`, `outcome: ""` and `size` = payout
(half the shares). In that window two losing positions have no REDEEM row of their own. Net: 734 of 740 closed
positions have a REDEEM row matching `(condition_id, outcome_index)`; 6 do not.

### 2.4 `/v2/positions` row

One row per outcome token. Verified against the feeds:

| field | meaning (measured) |
|-|-|
| `total_size` | lifetime shares bought; equals the sum of BUY `size` on all 754 rows |
| `current_size` | shares held now; 0 on CLOSED |
| `entry_fees_usdc` | sum of taker fees; equals sum(`usdc_size - size*price`) on all 754 rows |
| `entry_cost_usdc` | OPEN: sum(`size*price`), fee-exclusive, but always slightly **below** the feed sum: by more than 0.01 USDC on 8 of 14 rows, max 0.68 **[unverified why]**. **CLOSED: always 0.0** (740 of 740) |
| `total_cost_usdc` | `entry_cost_usdc + entry_fees_usdc`; so on CLOSED rows it is just the fees |
| `avg_price` | 4 decimals. OPEN: fee-exclusive VWAP (14 of 14 within 0.0002). **CLOSED: fee-inclusive VWAP** = sum(`usdc_size`)/`total_size` (740 of 740 within 0.0003; the fee-exclusive VWAP is off by about 0.01) |
| `realized_pnl` | CLOSED: `payout - sum(usdc_size)`, i.e. **after fees**. Exact (<= 0.01) on 469 of 734 checkable rows; on the other 265 the API value is higher by up to 1.50 USDC (sum of differences 44.09) **[unverified why]** |
| `unrealized_pnl` | `current_value - entry_cost_usdc`, fee-exclusive |
| `current_price` | live mark on OPEN; final payout (0 / 0.5 / 1) on CLOSED |
| `last_event_at` | last trade or the redeem timestamp (equals the REDEEM ts on 734 of 740 closed rows) |
| `first_entry_at` | first buy |
| `status`, `redeemable`, `mergeable` | `redeemable` was false on every row |
| `event_id`, `event_slug`, `slug`, `title`, `outcome`, `outcome_index`, `opposite_outcome`, `opposite_token_id`, `end_date`, `negative_risk`, `archived` | metadata; `event_id` is the Gamma event id |

To reconstruct the cost of a closed position use the feeds, or `avg_price * total_size` (fee-inclusive, 4-decimal
rounding error: up to a few USDC on large positions). 754 tokens over 738 conditions: 16 conditions were bought on
both sides; each side is its own row.

## 3. Dedup, ordering, latency

### 3.1 Ordering

Both feeds are ordered by `(block_timestamp, sequence_id)` descending, i.e. reverse chain order (block, tx index,
log index). All full walks were monotonically non-increasing in `timestamp`, and the ASC activity walk is the exact
reverse of the DESC walk. Rows sharing a timestamp keep chain order.

Because the order is chain position and not arrival time, **a row that is indexed late is inserted at its chain
position, below rows you may already have seen**; "newest first" does not mean "most recently indexed first".

### 3.2 Latency (measured)

- `D/status` reported `serving.lag_seconds: 1` and 1-2 blocks behind chain head.
- Target wallet (4 s polling of `/v2/activity`): two new trades were first seen 3.1 s and 13.4 s after their block
  timestamp; the second figure includes the 15 s CDN cache. The wallet then went quiet (last trade 07:22:16Z), so
  this is a sample of two.
- Busy third-party wallet (`0xc69bd556...`, 2 s polling of `/v2/activity` with a cache-busting parameter, 170 s):
  166 new TRADE rows, first-seen lag min 0.8 s, median 4.0 s, p90 6.0 s, max 7.1 s (includes the 2 s poll interval).
  **0 rows appeared below the previously seen newest timestamp.**
- So in practice new rows arrived at the top within about 7 s and never out of order, but the API gives no
  guarantee: ordering is by chain position (3.1), `D/tokens` documents "may lag by up to a minute" **[docs]**, and
  the ingestion uses one crawl cursor per contract event (201 cursors in `D/status`), so a TRADE and a REDEEM of
  the same second can become visible at different moments. Re-read an overlap window (10 minutes is generous)
  rather than assuming `timestamp > last_seen` is complete.
- On top of ingestion lag comes the CDN cache: the same `/v2/trades` URL returned `x-cache: Hit from cloudfront`
  with a growing `age` for up to 300 s while `/v2/activity` already showed a newer trade. Adding `&_=<random>`
  gave `Miss from cloudfront` every time.

### 3.3 What identifies a row

No id or log index is exposed. Measured on this wallet's 11,069 trade rows:

| key | distinct | rows in collisions |
|-|-|-|
| `transaction_hash` | 11,066 | 5 |
| `transaction_hash, token_id, side` | 11,066 | 5 |
| `transaction_hash, token_id, side, price` | 11,068 | 2 |
| `transaction_hash, token_id, side, price, size` | 11,069 | **0** |

The last key is safe on everything seen so far, but it can collide in principle: two resting orders of the same
wallet with the same price filled for the same size in one transaction give two identical rows (no fully identical
rows exist in this history). Recommendations:

- For activity use `(type, transaction_hash, token_id, side, price, size)`; for REDEEM use
  `(transaction_hash, condition_id, outcome_index)` since `token_id` can be empty (0 collisions on 738 rows).
- Count duplicates instead of dropping them (treat the feed as a multiset), or better, sync by **window
  replacement**: re-fetch `start = last_ts - overlap` and replace all stored rows with `timestamp >= start`.
  `scripts/backfill_raw.py` does this; it needs no key and keeps chain order.

## 4. Recognising CS2

All four tests agree on 100% of this wallet's history (738 markets, 390 events):

| test | result |
|-|-|
| Gamma event `seriesSlug == "counter-strike"` (series id 10310) | 738 / 738 markets |
| market `slug` and `event_slug` start with `cs2-` | 11,069 / 11,069 trade rows |
| event `title` starts with `Counter-Strike:` | 738 / 738 |
| market `question` / feed `title` starts with `Counter-Strike:` | only 497 / 738: sub-markets are titled `Map Handicap: ...`, `Games Total: ...`, `Map 1 Rounds Handicap: ...` |

**CS2 share: 100% of trades and of volume; nothing else was ever traded.** Use the `cs2-` prefix on `event_slug`
as the cheap test straight from the feed and `seriesSlug` as confirmation. Do not use the feed `title` prefix.
Event tags are `esports`, `counter-strike-2` (id 100780), `games`, `sports`; the tag also matches non-match futures
(`will-faze-win-a-tier-1-event-in-2026`, no `seriesSlug`), so the series is the better filter for match markets.
CLOB `/markets/{condition_id}` also returns `tags: ["Sports","Esports","Games","counter strike 2"]`.

By Gamma `sportsMarketType` (share of notional): `moneyline` 67.3% (7,686 rows), `map_handicap` 26.5% (2,218, line
-1.5), `child_moneyline` 5.0% (829, single-map winner), `totals` 1.0% (284, line 2.5), `round_handicap_game_N`
0.2% (52). 10,992 of 11,069 fills were before `gameStartTime`; 77 (8,666 USDC) after. Activity by month: May 2
rows, Aug 75, Oct 7,661, Nov 3,331 so far; 99.8% of volume is since October.

## 5. Gamma

### 5.1 Markets in bulk

`GET G/markets?condition_ids=0x..&condition_ids=0x..&closed=true&limit=100`

- **Repeat the parameter.** `condition_ids=a,b` returns `[]`.
- **`closed` filter**: omitted or `false` returns only open markets (3 closed ids + 1 open id -> 1 row);
  `closed=true` returns only closed ones (-> 3 rows). Query twice to cover both.
- **`limit` defaults to 20**: 100 ids without `limit` returned 20 rows. Send `limit >= number of ids`.
- 100 ids per request works; 150 fails with HTTP 414 (URL too long). The backfill uses 40.
- By token: `G/markets?clob_token_ids=<id>&clob_token_ids=<id>` (same `closed` rule). By slug:
  `G/markets?slug=..` (same rule), `G/markets/slug/<slug>` and `G/markets/<id>` return closed markets directly.
- All 738 condition ids resolved (724 closed, 14 open); none missing.
- Each market embeds `events[0]` with `id, slug, title, seriesSlug, startTime, endDate, live, ended, score, period,
  closed, gameId, eventMetadata` (league, tournament, `pandascoreMatchId`) but **not** `tags` or sibling markets.
  One call therefore gives market plus parent-event metadata (stored as `_event` in `markets.jsonl`).
- `outcomes`, `outcomePrices`, `clobTokenIds`, `umaResolutionStatuses` are **JSON-encoded strings**; decode them.
  `clobTokenIds[i]` pairs with `outcomes[i]` and with the feeds' `outcome_index`.

Market fields worth using: `conditionId, slug, question, groupItemTitle, sportsMarketType, line, outcomes,
clobTokenIds, gameStartTime` ("2026-11-13 10:30:00+00"), `endDate, closed, closedTime, acceptingOrders, bestBid,
bestAsk, lastTradePrice, spread, orderPriceMinTickSize, orderMinSize, feeSchedule, feeType, volumeNum`.

### 5.2 Resolution

| field | closed market | open market |
|-|-|-|
| `closed` | `true` | `false` |
| `outcomePrices` | `["1","0"]` (360), `["0","1"]` (350), `["0.5","0.5"]` (14) | live mid prices |
| `umaResolutionStatus` | `"resolved"` (724 of 724) | absent |
| `umaResolutionStatuses` | `["proposed","proposed"]` or `["proposed"]`: a history, **not** the final state | `[]` |
| `closedTime` | `"2026-08-19 16:46:30+00"` | absent |
| `automaticallyResolved` | `true` | absent |

Winner = index of `"1"` in `outcomePrices` once `closed` and `umaResolutionStatus == "resolved"`; treat
`["0.5","0.5"]` as a void (cancelled, forfeit or walkover per the market rules). Alternatives:
`D/tokens?token_id=` (`resolved`, `final_price`), `C/markets/{condition_id}` (`tokens[].winner`),
`D/resolutions?condition=`.

### 5.3 Events and live state

- `G/events?slug=a&slug=b` returns open and closed events without a `closed` flag (unlike `/markets`), each with all
  its markets (11 for a BO3: moneyline, 2-3 `child_moneyline`, `totals`, `map_handicap`, round handicaps and totals
  per map), `tags`, `series`, `teams`. `G/events?id=..&id=..` and `G/events/slug/<slug>` also work.
- Live fields on the event: `live` (bool), `ended` (bool), `score` (`"0-0|0-0|Bo3"` before the match,
  `"000-000|2-1|Bo3"` after), `period` (`"0/3"` .. `"3/3"`), `startTime`. Closed events: `live: false, ended: true`.
- Listing: `G/events?series_id=10310&closed=false&limit=100` (max 100 per page; `limit=500` returns 100; `offset`
  pages; `G/events/keyset` gives `next_cursor`). **`limit > 50` needs `Accept-Encoding: gzip`** or it answers 406
  `gzip_required`. `live=true` returned 0 rows at a time when no CS2 match was live, so the filter is
  **[unverified]**; in-play values of `score` / `period` were not observed either.
- **Gamma responses are cached 300 s per URL** (`x-cache: Hit from cloudfront, age: 192` seen), so `live`, `score`
  and `bestBid` can be 5 minutes old. Use the CLOB for prices.

## 6. CLOB (public, no auth; all verified)

| call | returns |
|-|-|
| `GET C/book?token_id=T` | `{market, asset_id, timestamp(ms), hash, bids[], asks[], min_order_size, tick_size, neg_risk, last_trade_price}`. `bids` ascending and `asks` descending, so the **best level is the last element** of each. Closed market -> 404 `No orderbook exists` |
| `POST C/books` body `[{"token_id":T},..]` | array of books |
| `GET C/price?token_id=T&side=BUY` | `{"price":"0.32"}`: `BUY` = best bid, `SELL` = best ask (0.33) |
| `POST C/prices` body `[{"token_id":T,"side":"BUY"},..]` | `{T: {"BUY":"0.32","SELL":"0.33"}}` |
| `GET C/midpoint?token_id=T` | `{"mid":"0.325"}`; bulk: `POST C/midpoints` with `[{"token_id":T}]` (the GET form with `token_ids=` -> `Invalid payload`) |
| `GET C/spread`, `C/last-trade-price`, `C/tick-size`, `C/fee-rate` `?token_id=T` | `{"spread":"0.01"}`, `{"price":"0.33","side":"BUY"}`, `{"minimum_tick_size":0.01}`, `{"base_fee":1000}` |
| `GET C/markets/{condition_id}` | market with `tokens:[{token_id,outcome,price,winner}]`, `closed`, `accepting_orders`, `game_start_time`, `tags`; works for closed markets |
| `GET C/prices-history?market=T&...` | `{"history":[{"t":sec,"p":price}]}` |

`C/prices-history`: `market` is the **token id**. Either `interval` (`1h, 6h, 1d, 1w, 1m, max`) or
`startTs` + `endTs` (seconds), plus `fidelity` in minutes. `interval=1d&fidelity=1` gives about one point per
minute. For a resolved market `interval=max` returned `[]`, but an explicit `startTs/endTs` window still returned
one-minute points for a market from 2026-05-29. Cached 90 s.

`D/prices-history?token_id=T` (v2): exactly one of `start`(+`end`, window max 15 days, `end` exclusive),
`interval` (`max, all, 1m, 1w, 1d, 6h, 1h`), or `as_of=<ts>` (latest observation at or before `ts`, handy for
"price when the wallet traded"); optional `bucket_seconds` (60..86400). Rows `{timestamp, price,
resolution_seconds}`, oldest first, a resolved series ends with the payout point (`resolution_seconds: 0`).
Fine grains expire: an explicit window on the 2026-05-29 market returned `[]`, `interval=max` returned one 12-hour
point plus the settlement point. Retention **[docs]**: 1-minute >= 7 days, 5-minute >= 60 days, 30-minute >= 90
days, 3 h and 12 h permanent. For old one-minute prices use the CLOB endpoint.

## 7. Rate limits

Stated **[docs]** (Cloudflare, per IP, sliding 10 s windows; excess is throttled, heavy load answers 429 with
`Retry-After`):

| API | limit per 10 s |
|-|-|
| Data v2 general | 800 |
| `/v2/trades` | 300 |
| `/v2/positions`, `/v2/activity`, `/v2/prices-history` | 200 each |
| `/v2/status` | 100 |
| Gamma general / `/events` / `/markets` | 4,000 / 500 / 300 |
| CLOB general / `/book` / `/price` / `/midpoint` | 9,000 / 1,500 each |
| CLOB `/books`, `/prices`, `/midpoints` | 500 each |
| CLOB `/prices-history` | 1,000 |

Observed: no 429 and no rate-limit headers at any point; 40 sequential `/v2/trades` calls in 5.3 s all returned
200; the full backfill is 32 Data API + 20 Gamma requests. A 1000-row page takes about 0.5-1 s. The practical
constraint is the CDN cache (section 0, item 2), not the rate limit.

## 8. Suggested polling recipe

1. Every 10-15 s: `D/activity?user=W&limit=200&start=<last_ts - 600>` (changing `start` or adding `_=<ms>` avoids a
   stale cached page). Replace the stored window, diff to find new rows. TRADE rows carry everything `/v2/trades`
   does plus `usdc_size`; REDEEM rows give resolutions.
2. Classify taker / maker with `usdc_size > size * price`.
3. New `condition_id`: `G/markets?condition_ids=..&closed=false&limit=..` (then `closed=true` for any not returned).
4. Prices: `C/book` or `POST C/prices` on the token ids; price at trade time: `D/prices-history?as_of=`.
5. Nightly: `scripts/backfill_raw.py --full` to catch any late row and refresh positions.

## 9. Not verified

- SELL, MERGE, SPLIT, CONVERSION rows and the sign of `usdc_size` on sells (the wallet has none).
- `REDEEMABLE` / `REDEEMABLE_LOST` position rows (never present; auto-redeem is immediate).
- In-play values of Gamma `live`, `score`, `period` and the `live=true` filter (no CS2 match was live during testing).
- Why `entry_cost_usdc` on OPEN rows is up to 0.68 USDC below the feed sum, why `realized_pnl` is up to 1.50 USDC
  above `payout - sum(usdc_size)` on 265 positions, and why `user-stats.fees_paid` (62,589.54) is below the summed
  taker fees (63,189.69).
- Whether a cursor stays valid indefinitely (cursors a few minutes old worked).
- Rate limits were not pushed to the point of a 429.
- `/v2/user-pnl` output was not inspected.
