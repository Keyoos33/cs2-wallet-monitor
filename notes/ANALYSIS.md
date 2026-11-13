# Is wallet `0xc9bf…81c0` ("Stiff-Desktop") worth copying? Audit of 2026-11-13

Data: complete history to 2026-11-13 07:26Z (`data/raw/`): 11,069 BUY fills, 754 positions (740 settled, 14 open),
738 markets, 390 matches (382 settled). Everything below is reproduced by
`scripts/analysis/analyze.py`, which writes `site/analysis.json` (same tables, French labels).

## Verdict

**Mechanically copyable, not demonstrably profitable.**

- The profit is real cash and 100% CS2: +584,182 USDC on 3,054,897 staked (ROI 19.1%), +14,356 rebates.
- It is statistically weak. Match-clustered 95% CI for the ROI: **1.2% to 37.6%**; z = 1.95 (two-sided p = 0.051).
  With an equal stake on every position the ROI is **4.9% (CI -4.2% to 14.0%, z = 1.05)**: the picks alone are not
  distinguishable from luck; the result comes from the largest bets winning. 86% of the profit is 10 positions,
  24% is one match, and 98% of the money was staked in about five weeks.
- Delay is cheap. The wallet takes displayed prices hours before the match, starting with a small order. One to
  fifteen minutes after its first fill the 1-minute price is only 1.5 to 1.8 cents above its first price, and it
  does not run away afterwards. A simulated follower at +1 min (taker fee and 1 cent of spread included) gets
  3.6% flat-stake (CI -4.8% to 12.4%) and 20.9% when also copying the sizes (CI 3.0% to 39.5%).
- Those follower numbers inherit the wallet's match results. The wallet does **not** beat the closing price
  (-0.2% of stake, CI -0.9% to +0.5%); all of its gain is "result versus closing price" (+21.5% of stake, z = 2.17).
  Someone buying only at the close would have had the same outcome (3.9% flat, 17.5% stake-weighted). So the
  whole case rests on whether its teams keep winning more often than the market expects, which 382 matches
  cannot settle.
- One no-edge bettor in about 39 would show a z this high by chance (one in 7 at flat stakes), and this wallet
  was selected because it had won.

What the data cannot establish: whether the edge is real (too few independent bets), what a follower could
actually have bought at each instant (no historical order book), sub-minute price moves from the price series
(1-minute resolution), and how many wallets were screened before this one was picked.

## Method

- **Cash accounting.** Stake = `usdc_size` of activity TRADE rows (taker fee included). Settlement value per share
  from Gamma `outcomePrices` (1, 0, or 0.5 for a void), falling back to REDEEM rows, then to the position row.
  PnL = shares x settlement - cash. The total (584,181.58) matches the API's `realized_pnl` sum (584,225.69)
  within the 44 USDC documented in `API_NOTES.md`; summed REDEEM cash equals shares x settlement exactly.
  Rebates are reported separately (not attributable to a bet).
- **Uncertainty.** Positions of one match win or lose together, so every confidence interval resamples whole
  matches (cluster bootstrap, 5,000 draws for the headline, 2,000 for sub-tables, fixed seed). The z-score is
  sum of match PnL / sqrt(sum of squared match PnL). Intervals assume independent matches and stable behaviour.
- **Price path.** CLOB `prices-history` with `fidelity=1` for every token (754 of 754, no sampling), window from
  3 h before the first fill to 1 h after the later of last fill and scheduled start. Median gap between points 60 s
  (p99 131 s). "Price at t" = first point at or after t, rejected if more than 180 s later. "Price before" = last
  point before the fill. "Closing price" = last point before `gameStartTime`, at most 30 min old.
- **Market tape.** Data API `/v2/trades?condition=` for every market (738 conditions, 426,832 taker rows,
  second resolution). An "ask-side print" on outcome X is a taker BUY of X at p or a taker SELL of the other
  outcome at q (equivalent to lifting an offer on X at 1-q). The wallet's own taker fills are flagged
  (5,930 rows on the tape versus 5,926 taker fills in the ledger).
- **Follower model.** Entry price = 1-minute price at the delay + a half-spread (base 1 cent; 0 / 0.5 / 1 / 2 cents
  shown), cash per share = price + 0.05 x price x (1 - price) taker fee, no rebate. ROI = settlement / cash - 1.
  "Flat" = one unit per position; "stake-proportional" = weighted by the wallet's final position cost.
  A second model follows every 10-minute burst of fills with the burst's dollars. A third uses the tape: VWAP of
  the first 100 USDC bought on the ask side after the delay, within 15 minutes (no spread added: executed prices).
- **Why 1 cent.** The wallet's own first taker fill is a median 1.0 cent above the price just before it
  (mean 2.35, p75 1.5, p90 3.5), and a live book snapshot showed 1 to 2 cent spreads (section 6).

Resolution limits, stated plainly: the "10 s" and "30 s" rows of the price-series tables use the first minute point
after that delay (on average 43 s and 61 s after the fill), so they do not resolve sub-minute delays. Only the tape
table is at second resolution, and it covers a third to a half of positions. The price series is a mid or last
traded price, not an executable ask.

## 1. Is the profit real, and is it CS2?

| item | USDC |
|-|-|
| Cash staked, fees included (all positions) | 3,159,534.69 |
| of which settled positions | 3,054,897.11 |
| of which 14 open positions | 104,637.58 |
| Fees on settled positions | 60,635.39 |
| Payouts | 3,639,078.69 |
| **Net PnL, settled bets** | **584,181.58 (ROI 19.12%)** |
| Rebates (taker 13,596.67 + maker 759.65) | 14,356.32 |
| Net with rebates | 598,537.90 (19.59%) |
| Deposits / withdrawals | 244,732.65 / 48,260.00 |

CS2 share: 100% of fills and of dollars. Settled positions: 414 won, 312 lost, 14 voided at 0.5.

Monthly (by scheduled match date): May -1 (2 positions), Aug -4,931 on 6,763, **Oct +524,033 on 1,722,691
(30.4%, CI 11.9 to 47.7)**, **Nov +65,081 on 1,325,441 (4.9%, CI -31.2 to 38.6)**. 99.8% of the money dates from
October onwards.

Drawdown: worst peak-to-trough 188,067 USDC (2026-11-03 to 11-07, from a peak of 656,250 cumulative profit; 77% of
total deposits). Worst day -148,955 (2026-11-04). 42 settlement days, 62% positive.

Concentration: top 10 positions = 501,024 = **85.8% of profit**; without them +83,158. Best match +140,962;
without the 5 best matches +162,998. Median match PnL +14 USDC; 52.9% of matches profitable.

Luck versus edge:

| test | result |
|-|-|
| ROI, match bootstrap | 19.1%, CI 1.2% to 37.6%, 1.6% of resamples at or below 0 |
| z, PnL after fees, clustered by match | 1.95 (p = 0.051 two-sided) |
| z, price only, before fees (null: entry prices fair) | 2.14 |
| Flat stake per position | 4.9%, CI -4.2% to 14.0%, z = 1.05 (p = 0.29) |

Calibration (fee-exclusive entry price = implied probability):

| entry price | n | implied % | won % | Wilson 95% | stake-weighted implied / won % | staked | PnL | ROI % |
|-|-|-|-|-|-|-|-|-|
| 0.00-0.20 | 13 | 14.8 | 26.9 | 10.4-54.0 | 17.8 / 27.0 | 44,481 | 23,516 | 52.9 |
| 0.20-0.30 | 45 | 26.3 | 24.4 | 14.2-38.7 | 26.9 / 34.4 | 153,060 | 42,200 | 27.6 |
| 0.30-0.40 | 115 | 35.5 | 35.7 | 27.5-44.7 | 35.0 / 54.9 | 429,961 | 220,147 | 51.2 |
| 0.40-0.50 | 151 | 45.0 | 51.3 | 43.4-59.2 | 44.5 / 56.6 | 585,947 | 148,783 | 25.4 |
| 0.50-0.60 | 149 | 55.1 | 56.0 | 48.0-63.8 | 56.1 / 53.1 | 613,287 | -53,187 | -8.7 |
| 0.60-0.70 | 134 | 64.8 | 67.9 | 59.6-75.2 | 64.6 / 81.9 | 469,536 | 117,824 | 25.1 |
| 0.70-0.80 | 87 | 74.1 | 80.5 | 70.9-87.4 | 73.8 / 84.7 | 473,630 | 63,833 | 13.5 |
| 0.80-1.00 | 46 | 87.4 | 94.6 | 84.0-98.3 | 89.1 / 96.0 | 284,995 | 21,066 | 7.4 |
| all | 740 | 53.5 | 56.9 | 53.3-60.4 | 56.0 / 66.0 | 3,054,897 | 584,182 | 19.1 |

Unweighted, the win rate beats the price by 3.3 points and every bucket's interval contains its implied
probability. Stake-weighted, it beats it by 10 points: the money was on the winners. That gap between unweighted
and weighted is the whole result, and it is carried by a few dozen large positions.

Caveat that matters: about 89 "equal-size-equivalent" bets carry the money (section 6), over five weeks.

## 2. How it bets

- **Holds to settlement: yes.** 11,069 buys, 0 sells, 0 merges, 0 splits, 0 conversions; 738 automatic redeems.
  Nuance: in 16 markets (2.0% of dollars) it bought the opposite outcome, which is economically a partial exit.
  Only 3 of the 16 hedge more than half of the shares; in 14 the two average prices sum to less than 1, but the
  legs are hours apart and lopsided, so this is position reduction, not arbitrage.
- **Several markets per match: yes.** 1 market in 48% of matches (13% of dollars), 2 in 26% (31%), 3 in 17% (29%),
  4 or more in 9% (27%). Where at least two positions name a team, all back the same team in 169 of 188 matches
  (2.52M USDC) and both teams in 19 (0.12M). It stacks, it does not hedge.

| market type | n | staked | PnL | ROI % | 95% CI |
|-|-|-|-|-|-|
| Match winner (moneyline) | 357 | 2,058,356 | 335,537 | 16.3 | -3.0 to 36.0 |
| Map handicap +1.5 | 107 | 439,463 | 74,350 | 16.9 | -10.7 to 43.5 |
| Map handicap -1.5 | 64 | 368,052 | 125,590 | 34.1 | -16.2 to 81.5 |
| Single-map winner | 142 | 148,627 | 25,783 | 17.3 | -13.4 to 42.3 |
| Total maps O/U | 47 | 33,138 | 17,178 | 51.8 | 2.6 to 94.3 |
| Round handicap (one map) | 21 | 4,765 | 2,010 | 42.2 | 7.0 to 79.0 |

| split | n | staked | PnL | ROI % | 95% CI |
|-|-|-|-|-|-|
| BO3 | 722 | 2,943,299 | 547,694 | 18.6 | -1.0 to 37.1 |
| BO5 | 9 | 90,192 | 46,111 | 51.1 | n too small |
| BO1 | 9 | 21,406 | -9,624 | -45.0 | n too small |
| Tier 1 (Polymarket `leagueTier`) | 86 | 910,153 | 75,207 | 8.3 | -43.9 to 54.8 |
| Tier 2 | 88 | 515,723 | 374,716 | 72.7 | 33.3 to 108.0 |
| Tier 3 | 66 | 273,774 | 94,146 | 34.4 | -14.5 to 71.7 |
| Tier 4 | 299 | 927,718 | 30,332 | 3.3 | -18.7 to 23.6 |
| Tier 5 | 201 | 427,530 | 9,781 | 2.3 | -16.3 to 17.5 |
| Stake under 100 | 167 | 5,740 | -417 | -7.3 | -26.1 to 10.9 |
| 100 to 1,000 | 246 | 99,860 | 14,287 | 14.3 | -2.5 to 29.4 |
| 1,000 to 5,000 | 157 | 380,123 | -9,016 | -2.4 | -18.6 to 14.4 |
| 5,000 to 20,000 | 128 | 1,312,531 | 418,859 | 31.9 | 11.2 to 54.0 |
| 20,000 and more | 42 | 1,256,643 | 160,469 | 12.8 | -24.0 to 47.4 |

Entry-price buckets are in the calibration table above. Caveat: these are post-hoc slices of a small sample. Tier 2
supplies 64% of the profit from 17% of the stake; tiers 4 and 5 (43% of the stake) are roughly break-even. Treat
that as a hypothesis, not a finding. The tier field is Polymarket's and was not cross-checked.

## 3. Maker versus taker

| | fills | share of fills | dollars | share of dollars | PnL | ROI % (CI) | avg price | closing-line value |
|-|-|-|-|-|-|-|-|-|
| Taker | 5,926 | 53.5% | 2,841,126 | 89.9% | 547,582 | 19.9 (1.0 to 39.0) | 0.485 | -0.15% |
| Maker | 5,143 | 46.5% | 318,409 | 10.1% | 36,599 | 11.9 (-0.9 to 24.4) | 0.624 | -1.07% |

(PnL and ROI on settled fills.) Fees paid 63,189.69 = 2.27% of taker notional; rebates 14,356.32 = 22.7% of fees;
net fee cost 1.55% of all cash staked. 727 of 754 positions (96%) are opened by a taker order; maker fills are
small resting adds, at higher prices, and they do not get better prices than the close. This is a price taker
whose flow a follower can see and imitate, not a market maker whose fills cannot be replicated. Caveat: the
ROI difference between the two modes is confounded by price level and timing, and is not significant.

## 4. Timing

`gameStartTime` is the **scheduled** start, not the actual one. A late match makes pre-match bets look live.

| fill time versus scheduled start | fills | dollars | share | ROI % | closing-line value |
|-|-|-|-|-|-|
| more than 8 h before | 3,523 | 1,171,870 | 37.1% | 25.0 | +0.70% |
| 4 to 8 h before | 3,088 | 840,304 | 26.6% | 9.4 | -0.58% |
| 2 to 4 h before | 2,186 | 579,451 | 18.3% | 25.5 | -0.40% |
| 1 to 2 h before | 1,241 | 298,068 | 9.4% | 6.1 | -1.15% |
| under 1 h before | 954 | 261,072 | 8.3% | 28.1 | -1.73% |
| after scheduled start | 77 | 8,769 | 0.3% | -21.7 | n/a |

- 99.7% of dollars are placed before the scheduled start; the dollar-weighted median fill is 5.8 h before
  (quartiles 2.8 h and 9.9 h).
- A position starts a median 8.1 h before start (quartiles 3.1 h and 11.6 h) and its last fill is a median 1.9 h
  before. Build time: median 2.0 h, p75 7.0 h, p95 11.4 h; median 6 fills (p95 49).
- **It starts small**: the first 20 seconds are a median 68 USDC (p75 285, p95 1,901), and the first ten minutes
  hold a median 19% of the final stake. The first alert therefore says little about how large the bet will become.
- In-play: 77 fills, 8,769 USDC, PnL -1,902. 53 are match-winner fills a median 176 min after the scheduled start
  (genuinely in-play or a delayed match, unknowable here); 19 are single-map markets that share the match start
  time and may not have begun. Nothing can be inferred about in-play skill. Polymarket clears the book at start
  (`clearBookOnStart`), so resting orders do not carry into the match.

## 5. Copyability

### 5.1 Cost of delay (price series, +1 cent spread, taker fee)

| delay after first fill | n (coverage) | actual mean lag of the price point | follower price minus wallet first price | follower flat ROI % (CI) | wallet flat ROI %, same positions | follower stake-weighted ROI % (CI) | wallet ROI %, same positions |
|-|-|-|-|-|-|-|-|
| 10 s | 736 (99.5%) | 43 s | +1.47 c | 4.3 (-4.7 to 13.1) | 5.0 | 21.7 (3.0 to 40.5) | 19.5 |
| 30 s | 735 (99.3%) | 61 s | +1.72 c | 3.5 (-5.2 to 12.2) | 4.7 | 21.2 (3.3 to 39.8) | 19.1 |
| 1 min | 730 (98.6%) | 94 s | +1.61 c | 3.6 (-4.8 to 12.4) | 4.7 | 20.9 (3.0 to 39.5) | 18.7 |
| 5 min | 730 (98.6%) | 334 s | +1.50 c | 4.1 (-5.0 to 13.6) | 5.3 | 21.8 (2.9 to 39.4) | 19.5 |
| 15 min | 738 (99.7%) | 933 s | +1.82 c | 3.0 (-5.9 to 11.4) | 4.8 | 20.4 (2.5 to 38.5) | 19.1 |

Spread sensitivity at 1 min: flat 5.9 / 4.7 / 3.6 / 1.5% and stake-weighted 23.5 / 22.2 / 20.9 / 18.4% for
0 / 0.5 / 1 / 2 cents. Each extra cent costs about 2.2 points of flat ROI.

Why the stake-weighted follower beats the wallet: it enters once near the wallet's first price, while the wallet's
own average ends 3.5 cents above the pre-entry price because it keeps buying into its own impact. That advantage
exists only for a follower small enough not to move the price, and "stake-proportional" here means the wallet's
relative weights, not its dollar sizes.

Following every increase (5,943 ten-minute bursts, burst dollars, price 1 min after the burst starts):
follower 17.3% (CI -0.6 to 34.9) versus wallet 19.2% on the same bursts, a cost of about 1.9 points at any delay
up to 15 minutes.

By opening mode at 1 min: taker-opened positions (704): follower flat 2.4% (CI -7.1 to 11.7), wallet 3.6%,
stake-weighted 20.2% versus 18.0%, extra cost 1.63 c. Maker-opened (26 positions, 116,702 USDC): follower flat
37.3% (CI 6.7 to 72.7), wallet 33.5%. The maker-opened sample is too small to mean anything, and a follower
cannot replicate a resting fill, only buy after it.

### 5.2 Cross-check with executed trades (second resolution)

VWAP of the first 100 USDC bought on the ask side by **other** wallets after the delay, within 15 min:

| delay | positions with such trades | mean / median extra cost vs wallet first price | flat ROI % (CI) | stake-weighted ROI % (CI) |
|-|-|-|-|-|
| 10 s | 252 (34%) | +0.77 c / +1.0 c | 5.4 (-8.7 to 19.3) | 20.0 (-2.6 to 42.7) |
| 30 s | 255 (34%) | +0.94 c / +1.0 c | 3.2 (-10.9 to 17.2) | 19.4 (-3.1 to 44.1) |
| 1 min | 256 (35%) | +1.06 c / +1.0 c | 4.3 (-9.8 to 19.4) | 20.7 (-3.2 to 45.4) |
| 5 min | 260 (35%) | +1.24 c / +1.0 c | 4.3 (-8.7 to 19.0) | 20.1 (-3.4 to 45.0) |
| 15 min | 248 (34%) | +1.59 c / +1.15 c | -3.4 (-17.7 to 9.9) | 19.1 (-8.6 to 44.5) |

Where someone else did buy within 15 minutes, they paid about 1 cent more than the wallet's first price, in line
with the price-series estimate. In two thirds of positions nobody else bought in that window, so this check is
silent there (see liquidity).

### 5.3 Does the price run away? Who moves it?

Cents above the price just before the first fill (714 pre-match positions with complete paths):

| step | mean | stake-weighted | taker-opened (690) | maker-opened (24) |
|-|-|-|-|-|
| wallet's first price | 2.35 | 1.41 | 2.34 | 2.79 |
| price 1 min after | 2.96 | 1.75 | 2.97 | 2.62 |
| price 5 min after | 2.86 | 1.70 | 2.84 | 3.38 |
| price 15 min after | 3.07 | 2.05 | 3.12 | 1.60 |
| wallet's final average price | 3.57 | 3.54 | 3.52 | 5.00 |
| closing price | 3.14 | 3.34 | 3.14 | 3.17 |

The jump happens at the first fill (crossing the spread of a thin book: median 1 cent) and the price then stays
flat: closing minus price-after-1-minute is +0.1 to +0.8 cents across first-burst size buckets. There is no
run-away to chase. Over the following hours the price drifts up to about the wallet's own average, and the wallet
supplies much of that pressure: it is 21% of all pre-match taker buying on its side (median 40% per position;
26% median on match-winner markets, 57% on map handicaps, 80% on totals).

### 5.4 Closing-line value (before fees)

| who / which price | n | mean close minus price | close higher in | stake-weighted, % of stake (CI) |
|-|-|-|-|-|
| wallet, position average | 734 | -0.36 c | 51.2% | **-0.20 (-0.91 to +0.47)** |
| wallet, first price | 734 | +0.86 c | 61.3% | +4.17 (2.86 to 5.45) |
| wallet taker fills | 5,813 | +0.09 c | 46.4% | -0.10 (-0.75 to +0.54) |
| wallet maker fills | 4,511 | -0.28 c | 42.2% | -1.07 (-2.87 to +0.98) |
| follower +1 min (+1 c) | 724 | -0.75 c | 42.3% | +1.58 (0.32 to 2.84) |
| follower +5 min (+1 c) | 721 | -0.68 c | 43.4% | +1.72 (0.43 to 2.99) |
| follower +15 min (+1 c) | 724 | -0.88 c | 42.1% | +0.89 (-0.34 to 2.22) |

Decomposition of the wallet's PnL on settled pre-match positions:

| component | USDC | % of stake |
|-|-|-|
| price move from purchase to close | -7,443 | -0.24 |
| match result versus closing price | +655,882 | +21.53 (z = 2.17; CI 3.9 to 40.3 of closing value) |
| fees | -60,496 | -1.99 |
| net | 587,942 | 19.30 |

**None of the edge is the price moving after entry.** The wallet buys at about the closing price on average. The
stake-weighted follower shows a small positive closing-line value only because the wallet's later buying lifts the
price after the follower's single entry; it is smaller than the taker fee (about 2.5% of stake at mid prices) plus
the spread, so it cannot be harvested by selling before the match. The closing price is also not an independent
yardstick here, since the wallet is a large part of the flow.

A 21% edge over closing prices is far larger than genuine pre-match edges usually are. Either the wallet has
information the market never absorbs, or this is a favourable run. The data cannot tell which; the flat-stake
result (z about 1) leans towards the run.

### 5.5 Two filters found on the same data (to be confirmed out of sample)

- Price cap: follow only if the price at +1 min is at most N cents above the wallet's first price. N = 2 keeps 75% of
  positions, flat 7.2% (CI -3.5 to 17.9); N = 1 keeps 30%, flat 22.5% (CI 6.1 to 39.7); N = 5 keeps 93%, flat 4.6%.
- Wait for commitment: enter 1 min after the wallet's cumulative stake on the position crosses a threshold.
  1,000 USDC: 326 positions, flat 6.5% (CI -6.0 to 19.0). 5,000: 170, 14.4% (-2.5 to 31.4). 10,000: 97, 32.7%
  (11.3 to 56.2). 20,000: 42, 14.7% (-18.9 to 47.3). The follower pays 0.7 to 0.9 cents more than the wallet's final
  average. Non-monotonic, small n, selected after the fact.

## 6. Blind spots

**Liquidity.** No historical order book exists, so two proxies:

1. Tape: dollars bought on the same side by others after the wallet's first fill, within 2 cents of its price.
   In the next 15 minutes: median 0 USDC, at least 100 USDC in 14% of positions, at least 1,000 in 3%, none at
   all in 52%. Until scheduled start: median 165 USDC (quartiles 5 and 1,774), at least 100 in 55%, at least 1,000
   in 31%. Including the wallet's own buying until start: median 470. Absence of trades is a lower bound on what
   was for sale, not proof of an empty book.
2. One live snapshot (2026-11-13 07:53Z, the 14 open positions, after the wallet had already bought): spread
   1 cent on 11 books and 2 cents on 3. Dollars offered within 1 cent of the best ask: 232,747 and 146,129 on the
   two tier-1 match-winner markets; 5,960 to 20,174 on three of their handicap and map markets and 67 on a fourth;
   147 to 1,696 on the eight lower-tier books (four of them under 300). So 100 USDC was fillable within a cent on
   13 of 14 books and 1,000 on 7 of 14. This is a single snapshot and says nothing about the moment of the
   wallet's first fill.

Practical reading: 100 USDC per bet is usually feasible, 1,000 only on tier-1/2 match-winner and handicap
markets, and the wallet's own sizes (median 712, largest 70,615 per position; 128,195 on one match) are out of
reach. The monitor is designed to store the book at each alert; that record should replace these proxies.

**Market-type risks.** 32.7% of dollars are off the match-winner market (26.5% map handicaps), where the wallet is
most of the flow and books are thinnest. 43.3% of dollars are in tier 4-5 tournaments: forfeits, stand-ins and
match-integrity problems are more common there and invisible in this data. 14 positions were voided at 0.5
(-1,166 USDC). All bets on one match resolve off one result.

**Survivorship.** z = 1.95 corresponds to a one-sided chance of 2.5%: one no-edge bettor in 39 does this well
(normal approximation; one in 7 at flat stakes). Polymarket has far more than 39 active CS2 wallets and this one
came to attention through a tweet about its winnings. The number of wallets screened is unknown, so the evidence
cannot be discounted properly; it can only be called weak.

**Regime.** By week (scheduled date): W42 +35.2% on 256k, W43 +13.4% on 555k, W44 +35.0% on 1,007k, W45 -0.7% on
824k, W46 (partial) +20.1% on 393k. Flat-stake by week: 0.4, 0.6, 18.5, -16.0, 27.2%. First half of matches 19.0%
(CI -3.1 to 38.6), second half 19.2% (CI -4.7 to 43.1); flat 4.1% and 5.7%. No visible decay, and no power to see
one: every weekly interval spans zero or nearly so. Stakes rose 2.5-fold between the halves (0.86M to 2.19M), so
future variance per match is larger than the past sample suggests.

**Correlation.** Two positions in the same match share the same result in 69.9% of 602 pairs. Clustering by match
inflates the standard error by 1.22 versus treating positions as independent. Stake concentration (inverse
Herfindahl of per-match stakes) equals about **89 equal-sized bets**; the 20 largest matches hold 37.4% of dollars.

**Other.** The wallet's behaviour may change once it is followed (its fills are public within seconds). Rebates
(22.7% of fees) depend on Polymarket's programme. A follower who sizes proportionally needs a bankroll that
survives a drawdown of the order of 30% of peak profit within four days.

## Limitations

- Five weeks of meaningful history; all inference is conditional on 382 matches behaving like independent draws.
- Follower ROI is computed on the wallet's realised matches, so it measures the cost of delay, not the reality of
  the edge.
- 1-minute price points, mid or last trade; the spread is an assumption (calibrated on the wallet's own crossing
  cost and one live snapshot); depth at the time is unknown.
- `gameStartTime` is scheduled, not actual. "Closing price" is the last point before the scheduled start.
- Tape-based liquidity counts executed trades only. Maker-opened positions (27) are too few for separate conclusions.
- Tier, format and market-type splits, the price cap and the commitment threshold are post-hoc.
- Open positions (14, 104,638 USDC) are excluded from PnL.

## Reproducing

```
python3 scripts/analysis/analyze.py \
  --trades data/raw/trades.jsonl --activity data/raw/activity.jsonl \
  --markets data/raw/markets.jsonl --positions data/raw/positions.json \
  --cache-dir <dir> --out site/analysis.json
```

Stdlib only. Cold cache: about 1,700 HTTP requests (754 price histories, 738 tapes with pagination), 4 workers,
about 3 minutes, no 429 seen. Warm cache: about 20 s; only open markets are re-fetched, closed markets are final.
`--offline` uses the cache only, `--no-tape` skips the tape. Output is deterministic for a given input and cache
(fixed bootstrap seed) apart from `genere_le`. Inputs may be JSONL or JSON (list, or object keyed by id), so the
runner's ledger files work as well as the raw backfill; if the trades file has no `usdc_size`, cash is rebuilt from
the fee formula and the `_taker` flag. A section that cannot be computed is replaced by a stub instead of failing
the run. The cache directory should be persisted between daily runs (for example with `actions/cache`).
