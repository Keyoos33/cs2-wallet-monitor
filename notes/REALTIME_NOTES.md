# Real-time detection of one wallet's Polymarket fills — measured notes

Wallet: `0xc9bfc7986767173b4f1c3fc9b2c6b255fc7381c0` ("Stiff-Desktop"). All measurements taken 2026-11-13 07:15–08:10 UTC
from a cloud container behind an HTTPS egress proxy (adds some tens of ms; absolute numbers will differ slightly elsewhere).
Everything below was observed in a real request/response unless it is listed under "Not verified".

## TL;DR

| Question | Answer |
|---|---|
| Fastest correct channel | On-chain `OrderFilled` logs filtered by the wallet as indexed `maker` (topic2). HTTP `eth_getLogs` polling at 1.5 s: median 0.0 s, max 0.1 s after block timestamp, 17/17 fills. |
| Best HTTP-only Polymarket channel | `GET /v2/activity?user=…&type=TRADE` **with a cache-busting query param**: median 3.3 s, max 6.2 s, 17/17. |
| Biggest traps | (1) `/v2/trades` defaults to `taker_only=true` and silently hides this wallet's maker fills (10 of 17 in the run; 640 of 771 over ~19 h). (2) CloudFront caches Data API responses: `/v2/trades` `max-age=300`, `/v2/activity` `max-age=15`; without a cache-buster `/v2/trades` lagged a median 155 s (max 236 s). |
| RTDS websocket | Still alive, undocumented. `activity/trades` carries `proxyWallet` and delivered maker and taker fills at ~0 s, but there is no server-side wallet filter (global firehose ~20–35 msg/s) and connections go silent without a close frame. |
| Maker vs taker | Only on-chain: `OrderFilled.taker == exchange address` means the wallet's order was the taker order. Data API has no role field. |
| Collateral | pUSD `0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB`, 6 decimals. |
| Goldsky subgraphs | Dead (`ENDPOINT_DEPRECATED`). |

## 1. Contracts, events, topic hashes (decoded from this wallet's real receipts)

Receipt used first: tx `0xe8d9cd0bb8b3b170464ea12778bc1f3fdaed220d4e38f802e93bde766a48c270` (block 97232315), saved as `rcpt_e8d9.json`.
Addresses match https://docs.polymarket.com/resources/contracts.md (fetched 2026-11-13).

| Contract | Address | Seen for this wallet |
|---|---|---|
| CTF Exchange (V2, EIP-712 domain version "2") | `0xE111180000d2663C0091e4f400237545B87B996B` | 771 of 771 fills in the last 45,000 blocks |
| Neg Risk CTF Exchange | `0xe2222d279d744050d28e00520010520000310F59` | 0 (include in the filter anyway) |
| ExchangeV3 (Polymarket Protocol V2 markets, Gamma `version: "v2"`) | `0xe3333700cA9d93003F00f0F71f8515005F6c00Aa` | 0 (include in the filter anyway) |
| pUSD collateral (ERC-20, `symbol()`="pUSD", `decimals()`=6) | `0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB` | every fill |
| Conditional Tokens (ERC-1155 outcome shares, 6 decimals) | `0x4D97DCd97eC945f40cF65F87097ACe5EA0476045` | every fill |
| USDC.e (only moved by the collateral adapter when pUSD is wrapped for split/merge) | `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174` | not the wallet's cash leg |
| Fee receiver seen in `FeeCharged` | `0x115f48dc2a731aa16251c6d6e1befc42f92accc9` | every taker fill |

CS2 markets checked are Gamma `version: "v1"`, `negRisk: false`, `feeSchedule: {rate: 0.05, takerOnly: true}` (`gamma-api.polymarket.com/markets?slug=cs2-rustec-nxs1-2026-11-13`).

Event signatures (topic0 recomputed with keccak256 in `sigs.mjs` and matched against the receipt):

| Event | topic0 |
|---|---|
| `OrderFilled(bytes32 orderHash, address maker, address taker, uint8 side, uint256 tokenId, uint256 makerAmountFilled, uint256 takerAmountFilled, uint256 fee, bytes32 builder, bytes32 metadata)` — first three indexed | `0xd543adfd945773f1a62f74f0ee55a5e3b9b1a28262980ba90b1a89f2ea84d8ee` |
| `OrdersMatched(bytes32 takerOrderHash, address takerOrderMaker, uint8 side, uint256 tokenId, uint256 makerAmountFilled, uint256 takerAmountFilled)` — first two indexed | `0x174b3811690657c217184f89418266767c87e4805d09680c39fc9c031c0cab7c` |
| `FeeCharged(address receiver, uint256 amount)` — receiver indexed | `0x55bb3cade9d43b798a4fe5ffdd05024b2d7870df53920673bfc7e68047cd0ab1` |
| ERC-20 `Transfer(address,address,uint256)` (pUSD) | `0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef` |
| ERC-1155 `TransferSingle(address,address,address,uint256,uint256)` | `0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62` |

Parameter names are inferred from the docs and the previous exchange version; the type list is exact (the hash only matches this type list).
The pre-migration `OrderFilled` topic0 will not match anything on these contracts.

`OrderFilled` layout: `topics[1]`=orderHash, `topics[2]`=maker (the signer of this order — the wallet, in both roles), `topics[3]`=taker.
`data` = 7 words: `side` (0=BUY, 1=SELL), `tokenId`, `makerAmountFilled`, `takerAmountFilled`, `fee`, `builder`, `metadata`.

## 2. Channels: what exists and what it delivers

### a) Data API v2 polling

- `GET /v2/activity?user=<w>&type=TRADE` returns maker and taker fills, with `usdc_size`. 17/17 fills seen.
- `GET /v2/trades?user=<w>` **defaults to `taker_only=true`**: it showed 7/17 fills (all 10 maker fills missing). With `taker_only=false` it showed 17/17. No `usdc_size` field.
- `timestamp` in both equals the block timestamp (30/30 checked).
- Neither feed has a maker/taker field or a log index.
- CDN caching (response headers, `x-cache: Hit from cloudfront`):
  - `/v2/trades`: `cache-control: public, max-age=300`
  - `/v2/activity`: `cache-control: public, max-age=15`
  - The cache key includes the query string; any extra unknown parameter (e.g. `&_=<ms>`) is accepted (HTTP 200) and gives `x-cache: Miss`. Changing `start=` also busts it.
- Freshness: cache-busted `/v2/activity` and `/v2/trades?taker_only=false` are equally fresh (median 3.3 s vs 4.0 s; the difference is within polling jitter). `GET /v2/status` reported `activity_feed age_seconds: 0`, ingestion 1 block behind.
- Forward polling shape that works: `&start=<last block ts>&sort_direction=ASC&limit=100` (`start` is inclusive, so dedup).

### b) RTDS websocket `wss://ws-live-data.polymarket.com`

No longer in the docs as a trade feed (docs only describe migrating RTDS price topics to PolyBolt, and say comment streaming is being retired). It still answers:

```json
{"action":"subscribe","subscriptions":[{"topic":"activity","type":"trades"}]}
```

Message (real, trimmed):

```json
{"topic":"activity","type":"trades","timestamp":1794554528455,"payload":{"proxyWallet":"0xC9BFc7986767173b4f1c3FC9B2c6b255Fc7381C0","side":"BUY","size":259.08,"price":0.6903504708970202,"fee":2.76913,"asset":"…","conditionId":"0x…","slug":"cs2-rustec-nxs1-2026-11-13-map-handicap-home-1pt5","eventSlug":"cs2-rustec-nxs1-2026-11-13","timestamp":1794554528,"transactionHash":"0x903a3411…"}}
```

- `proxyWallet` is present (mixed case — lowercase before comparing). `fee` is present on `trades`, absent on `orders_matched`.
- `activity/trades` delivered maker and taker fills: 13/13 with a watchdog-reconnecting client.
- `activity/orders_matched` delivered taker fills only: 3/3 taker, 0/10 maker (run 2); 9/9 taker, 0/9 maker (run 1).
- Server-side filtering: `filters:"{\"event_slug\":\"…\"}"` and `{"market_slug":…}` work (162 msgs, 1 distinct event vs 534 msgs / 39 events unfiltered in the same 15 s). A `proxyWallet` or `user` filter is accepted but delivers nothing: 0/17 of the wallet's fills on the `proxyWallet`-filtered connection. So wallet filtering is client-side only, on a global firehose of ~20–35 msg/s (~1 KB each).
- Reliability: connections went silent with no close frame. Without a watchdog, `ws_trades` stopped after ~11 min and saw 8/17; `ws_orders_matched` stopped after ~10 min and saw 0/17. With an 8 s silence watchdog there were 2 silent stalls (after 225 s and 245 s) and 2 server closes (after 750 s and 903 s) in 19 min. Text `PING` was sent every 2.5–5 s throughout. I cannot rule out that the egress proxy contributed.
- `wss://ws-subscriptions-clob.polymarket.com/ws/market` (public) gives book snapshots and `last_trade_price` per asset with a `transactionHash` but no wallet. The `user` channel needs the wallet's own API credentials.

### c) On-chain logs

Filter: `address` = the three exchanges, `topics = [OrderFilled topic0, null, <wallet padded to 32 bytes>]`.
This catches every fill in both roles, because the wallet is always `maker` of its own order's `OrderFilled`.

- `https://polygon-bor-rpc.publicnode.com`: topic-filtered `eth_getLogs` accepted up to 10,000 blocks (`exceed maximum block range: 10000` above); 9,999 blocks took 0.9–1.9 s; multi-address arrays OK; JSON-RPC batch OK; 80 requests at 50 req/s all HTTP 200; 3,080 requests in the 39-min run with no 429. One transient `invalid block range params` (my `fromBlock` exceeded the `eth_blockNumber` returned by a lagging backend) — clamp `fromBlock <= toBlock`.
- `https://polygon.drpc.org`: works for ranges ≤100 blocks; ≥200 blocks fails with HTTP 400 `ranges over 10000 blocks are not supported on free plan` (message is misleading). 6 HTTP 429 in 3,675 requests at ~1.6 req/s; 80 requests at 36 req/s all 200. Slower (p50 530 ms for 4 calls per cycle).
- `https://polygon-rpc.com`: unusable — `{"error":"API key disabled, reason: tenant disabled"}` HTTP 403.
- Both working RPCs return a `blockTimestamp` field on each log, so no extra block fetch is needed.
- `eth_subscribe("logs", {address, topics})` over `wss://polygon-bor-rpc.publicnode.com` and `wss://polygon.drpc.org` is accepted. publicnode delivered 17/17; drpc 16/17 (one maker fill never arrived).
- Blocks become visible 0.5–1.2 s **before** their own `timestamp` (15 consecutive heads measured), which is why some latencies below are negative. Block interval is ~1.5 s.

### d) Goldsky

All five public Polymarket subgraph endpoints tried (`orderbook-subgraph` 0.0.1 and prod, `activity-subgraph`, `positions-subgraph`, `pnl-subgraph`) return:

```json
{"errors":[{"message":"This Polymarket subgraph endpoint is paused and deprecated following Polymarket's migration to V2 — the data is stale and incorrect. Stop using it. …","extensions":{"code":"ENDPOINT_DEPRECATED","migrateTo":"https://edge.goldsky.com/data/docs/"}}]}
```

The suggested replacement host `edge.goldsky.com` was blocked by this environment's network policy, so it is untested.

## 3. Measured latency

Method: `harness.mjs` ran all pollers concurrently; for each fill it recorded the wall-clock time each channel first returned it.
Latency = first-seen wall clock − block timestamp. Ground truth = an independent `eth_getLogs` over the whole window afterwards.
Local clock agreed with the Data API `Date` header to within 1 s. Negative values are real (see block timestamp note above).

Run 2, 38.7 min, 17 fills (10 maker, 7 taker); the last 330 s were excluded so the slowest channel had time to show each fill.

| Channel | Cadence | Seen | Missed | Median s | p90 s | Max s |
|---|---|---|---|---|---|---|
| RPC `eth_subscribe` logs, publicnode (WS) | push | 17/17 | 0 | −0.8 | −0.7 | −0.2 |
| RPC `eth_subscribe` logs, drpc (WS) | push | 16/17 | 1 maker | −0.2 | 0.4 | 0.8 |
| RPC `eth_getLogs`, publicnode (HTTP) | 1.5 s | 17/17 | 0 | 0.0 | 0.1 | 0.1 |
| RPC `eth_getLogs`, drpc (HTTP) | 2.5 s | 17/17 | 0 | 0.9 | 1.4 | 1.9 |
| RTDS `activity/trades`, with watchdog | push | 13/13 | 0 | 0.0 | 0.8 | 0.8 |
| RTDS `activity/trades`, no watchdog | push | 8/17 | 9 (stalled) | −0.3 | 0.1 | 0.2 |
| RTDS `activity/orders_matched`, with watchdog | push | 3/13 | 10 maker | −0.1 | −0.1 | −0.1 |
| RTDS `activity/trades` + `proxyWallet` filter | push | 0/17 | 17 | – | – | – |
| `/v2/activity`, cache-busted | 1.5 s | 17/17 | 0 | 3.3 | 4.6 | 6.2 |
| `/v2/trades?taker_only=false`, cache-busted | 1.5 s | 17/17 | 0 | 4.0 | 4.7 | 7.5 |
| `/v2/trades` default (taker only), cache-busted | 3 s | 7/17 | 10 maker | 4.6 | 5.6 | 7.5 |
| `/v2/activity`, same URL every time (CDN) | 2 s | 17/17 | 0 | 9.6 | 17.6 | 20.4 |
| `/v2/trades?taker_only=false`, same URL (CDN) | 3 s | 17/17 | 0 | 155.5 | 224.4 | 235.6 |

The watchdog RTDS client started 11 min after the others, hence 13 eligible fills.

Run 1 (39.5 min, 18 fills, 9 maker / 9 taker, overlapping window) reproduced the shared channels:
`eth_getLogs` publicnode 18/18 median −0.4 / max 0.6; drpc 18/18 median 0.6 / max 1.9; `/v2/activity` busted 18/18 median 3.8 / p90 4.8 / max 6.8;
`/v2/trades?taker_only=false` busted 18/18 median 3.9 / p90 5.4 / max 8.5; default `/v2/trades` 9/18; uncached-URL `/v2/trades` median 155.8 / max 233.3.

Poller health over run 2: Data API 1,540 + 1,538 + 770 cache-busted requests, all HTTP 200, 2 transport errors (`fetch failed`), p50 130 ms. No 429 from the Data API at ~1.7 req/s sustained or in an 80-request burst at 37 req/s.

## 4. Maker vs taker

Recipe (per `OrderFilled` log with `topics[2] == wallet`):

1. `taker = topics[3]`. If `taker` is the emitting exchange address → the wallet's order was the **taker** order (it crossed the book; `fee` > 0 on fee-enabled markets). Cross-check: the same tx has `OrdersMatched` with `topics[2] == wallet`.
2. Otherwise → the wallet's order was a resting **maker** order; `topics[3]` is the counterparty wallet and `fee` = 0.
3. `side` = first data word: 0 BUY, 1 SELL.

When the wallet is taker, each counterparty's `OrderFilled` has `topics[3] == wallet`; filter `[topic0, null, null, wallet]` to list them (158 such logs vs 50 taker orders in 9,000 blocks).

Result for the 30 most recent fills at 08:08 UTC (`fills_analysis.txt`): 16 MAKER, 14 TAKER, all BUY, all on CTF Exchange. An earlier sample at 07:20 gave 20 MAKER / 10 TAKER.
Over 45,000 blocks (~19 h): 771 fills = 640 MAKER + 131 TAKER, all BUY.

Data API: no role field. Indirect only — a row present with `taker_only=false` and absent with the default is a maker fill (matched 30/30: 16 maker absent, 14 taker present). RTDS: a fill on `orders_matched` is a taker fill; `fee > 0` on `trades` also implies taker.

## 5. Exact amounts

All amounts are 6-decimal integers.

- BUY: `makerAmountFilled` = pUSD paid for shares, `takerAmountFilled` = shares received.
- SELL: `makerAmountFilled` = shares sold, `takerAmountFilled` = pUSD gross proceeds.
- `fee` is in pUSD, charged only to the taker order: BUY taker pays `usdc + fee`; SELL taker receives `usdc − fee`.
- Fee formula confirmed on 10/10 taker fills: `fee = shares × 0.05 × p × (1 − p)` (ratio exactly 0.05).
- Wallet's pUSD `Transfer` out in the tx equals `usdc + fee` exactly on 10/10 taker fills and `usdc` on maker fills.

Comparison with the Data API, 30/30 fills:

| | Maker fill | Taker BUY | Taker SELL |
|---|---|---|---|
| `size` | = shares | = shares | = shares |
| `size × price` | = on-chain pUSD | = on-chain pUSD **excluding** fee | = gross proceeds |
| activity `usdc_size` | = on-chain pUSD | = pUSD **including** fee | = proceeds **minus** fee |

Worked example, tx `0x565f016e…b0ca75` (block 97233964): on-chain `makerAmountFilled` 287.500000, `takerAmountFilled` 575.000000, `fee` 7.187500; API `size` 575, `price` 0.5, `usdc_size` 294.6875.
So the fee is `usdc_size − size × price` for a taker BUY, and the API cannot give it for `/v2/trades` (no `usdc_size`).
`price` is an average when one taker order hits several makers (e.g. 0.6903504709 for a 10-`OrderFilled` tx) and can carry float noise (`0.3900000011`); recompute from the integers.

SELL semantics were validated on two other wallets' fills (`sell_check.out`), because this wallet had no SELL in 45,000 blocks:
maker SELL 2.48 shares → +2.0336 pUSD, `usdc_size` 2.0336; taker SELL 429.23 shares, gross 8.5846, fee 0.5889 → +7.9957 pUSD, `usdc_size` 7.9957.

## 6. Observability limits

- Resting orders of a third party are not observable. `clob.polymarket.com/data/orders?maker_address=…`, `/data/trades`, `/trades` → HTTP 401 `Unauthorized/Invalid api key`; `/v2/orders` on the Data API → 404; `/book` and the market websocket give only aggregated `{price, size}` levels with no owner. Orders are signed off-chain and reach the chain only inside a match, so there is no on-chain trace of an unfilled order.
- One order produces many fills. Over 45,000 blocks: 771 fills from 133 distinct `orderHash` values; 49 orders had ≥2 fills; one resting order (`0xb0464bd6…64ce`) was filled 430 times in 430 separate transactions across 207 blocks.
- One taker order hitting several makers is one wallet `OrderFilled` and one API row (the 10-event tx above is a single row).
- The wallet never had more than one fill in a transaction (771/771), but nothing guarantees that; keep the log index in the key.
- `orderHash` is the only link between fills of the same order, and it exists only on-chain.

## 7. Recommendation for a Cloudflare Workers poller

Primary: HTTP `eth_getLogs` against publicnode, from a Durable Object alarm loop.
Reconciliation: Data API `/v2/activity` (cache-busted), which also supplies market title/slug/outcome.

- Cadence: `eth_getLogs` every 2 s (one call; add `eth_blockNumber` in the same JSON-RPC batch). 1.5 s ran clean for 39 min here (3,080 requests, zero 429); publicnode publishes no hard limit that I verified, so keep a fallback.
- Range: `fromBlock = lastProcessedBlock − 20` (overlap for reorgs and backend lag), `toBlock = head`, clamped so `fromBlock <= toBlock`. On cold start or after downtime, page in ≤9,000-block chunks.
- Fallback RPC: drpc, with ranges ≤100 blocks and one address per call or it returns 400. Expect occasional 429.
- Reconciliation: `/v2/activity?user=…&type=TRADE&start=<last ts − 60>&sort_direction=ASC&limit=100&_=<now ms>` every 15–30 s. Any row whose `(transaction_hash, token_id)` has no on-chain record triggers an `eth_getTransactionReceipt` for that hash. Documented limit is 200 req/10 s for `/v2/activity`; this is far below it.
- If only one channel is wanted: `/v2/activity` cache-busted every 2 s gives ~3–6 s latency and missed nothing in two runs, but has no role and no order hash.
- Do not use `/v2/trades` as the detector: default hides maker fills, 300 s CDN TTL, no `usdc_size`.
- RTDS is not worth a Durable Object websocket here: no wallet filter, ~25 KB/s of unrelated traffic, silent stalls, and no latency advantage over `eth_getLogs`. If a push channel is wanted, `eth_subscribe` logs on publicnode is wallet-filtered server-side and was 17/17, but still needs the HTTP backfill on reconnect.
- Dedup key: `(transaction_hash, log_index)` for on-chain records. To join a Data API row (which has no log index) use `(transaction_hash, token_id, side)` and compare `size` to the shares integer / 1e6.
- CS2 filter: logs carry only `tokenId`. Map `tokenId` → market via Gamma (`clobTokenIds`) or take `slug`/`title` from the activity row; CS2 slugs start with `cs2-`.

## 8. Copy-paste requests

All fills of the wallet in a block range (returns the fill of the worked example):

```bash
curl -sS -X POST -H 'content-type: application/json' https://polygon-bor-rpc.publicnode.com -d '{"jsonrpc":"2.0","id":1,"method":"eth_getLogs","params":[{"fromBlock":"0x5cbac2c","toBlock":"0x5cbac2c","address":["0xE111180000d2663C0091e4f400237545B87B996B","0xe2222d279d744050d28e00520010520000310F59","0xe3333700cA9d93003F00f0F71f8515005F6c00Aa"],"topics":["0xd543adfd945773f1a62f74f0ee55a5e3b9b1a28262980ba90b1a89f2ea84d8ee",null,"0x000000000000000000000000c9bfc7986767173b4f1c3fc9b2c6b255fc7381c0"]}]}'
```

Response (trimmed): `topics[3]` = `0x…e111180000d2663c0091e4f400237545b87b996b` (wallet was taker), `data` words = `0` (BUY), tokenId, `0x1122e6e0` (287.5 pUSD), `0x2245cdc0` (575 shares), `0x6dac2c` (7.1875 fee), `blockTimestamp` `0x6af6c1f2`, `logIndex` `0x135`, `removed` false.

Head plus logs in one batch:

```bash
curl -sS -X POST -H 'content-type: application/json' https://polygon-bor-rpc.publicnode.com -d '[{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]},{"jsonrpc":"2.0","id":2,"method":"eth_getLogs","params":[{"fromBlock":"0x5cbac00","toBlock":"latest","address":["0xE111180000d2663C0091e4f400237545B87B996B","0xe2222d279d744050d28e00520010520000310F59","0xe3333700cA9d93003F00f0F71f8515005F6c00Aa"],"topics":["0xd543adfd945773f1a62f74f0ee55a5e3b9b1a28262980ba90b1a89f2ea84d8ee",null,"0x000000000000000000000000c9bfc7986767173b4f1c3fc9b2c6b255fc7381c0"]}]}]'
```

Counterparty fills when the wallet was taker: same body with `"topics":["0xd543…d8ee",null,null,"0x000000000000000000000000c9bfc7986767173b4f1c3fc9b2c6b255fc7381c0"]`.

Receipt for exact cash legs:

```bash
curl -sS -X POST -H 'content-type: application/json' https://polygon-bor-rpc.publicnode.com -d '{"jsonrpc":"2.0","id":1,"method":"eth_getTransactionReceipt","params":["0x565f016ea3136cec5a371fdc1253e8721354150391a055046544168bdfb0ca75"]}'
```

Data API (the `_` parameter is the cache-buster; change it on every request):

```bash
curl -sS "https://data-api.polymarket.com/v2/activity?user=0xc9bfc7986767173b4f1c3fc9b2c6b255fc7381c0&type=TRADE&start=1794556402&sort_direction=ASC&limit=100&_=$(date +%s%3N)"
curl -sS "https://data-api.polymarket.com/v2/trades?user=0xc9bfc7986767173b4f1c3fc9b2c6b255fc7381c0&taker_only=false&limit=30&_=$(date +%s%3N)"
curl -sS https://data-api.polymarket.com/v2/status
```

RTDS subscribe frames (send text `PING` every 5 s; reconnect after 8–10 s of silence):

```json
{"action":"subscribe","subscriptions":[{"topic":"activity","type":"trades"}]}
{"action":"subscribe","subscriptions":[{"topic":"activity","type":"trades","filters":"{\"event_slug\":\"cs2-rustec-nxs1-2026-11-13\"}"}]}
```

RPC websocket subscribe (`wss://polygon-bor-rpc.publicnode.com`):

```json
{"jsonrpc":"2.0","id":1,"method":"eth_subscribe","params":["logs",{"address":["0xE111180000d2663C0091e4f400237545B87B996B","0xe2222d279d744050d28e00520010520000310F59","0xe3333700cA9d93003F00f0F71f8515005F6c00Aa"],"topics":["0xd543adfd945773f1a62f74f0ee55a5e3b9b1a28262980ba90b1a89f2ea84d8ee",null,"0x000000000000000000000000c9bfc7986767173b4f1c3fc9b2c6b255fc7381c0"]}]}
```

## 9. Not verified

- Nothing was run from Cloudflare Workers; cadence and limits were measured from one cloud IP. Cloudflare egress IPs are shared and may be rate-limited differently by publicnode/drpc.
- The actual rate-limit ceilings of publicnode, drpc and the Data API were not found (no throttling up to 37–50 req/s bursts of 80). Data API numbers quoted are from the docs.
- Reorg behaviour: no `removed: true` log and no disappearing fill was seen in ~40 min; the overlap window is a precaution, not a measured need.
- Whether an RTDS `event_slug`-filtered subscription delivers this wallet's maker fills was not tested (the filter itself works).
- Whether the RTDS silent stalls come from Polymarket or from this environment's egress proxy.
- SELL decoding was confirmed only on other wallets; this wallet sold nothing in the sampled period.
- Neg Risk CTF Exchange and ExchangeV3 are assumed to emit the same `OrderFilled` ABI (docs say so); this wallet has no fills there to decode.
- Goldsky "Edge Data API" (host blocked here).
- Sample is 17 + 18 fills over two overlapping ~39-min runs in one quiet-ish hour; tail latencies under heavy load are unknown.

## 10. Scripts and raw logs

Directory: `/tmp/claude-0/-home-user/0b0b89e3-1d8f-579a-89c4-580887b6cffb/scratchpad/realtime/`

| File | What |
|---|---|
| `/tmp/claude-0/-home-user/0b0b89e3-1d8f-579a-89c4-580887b6cffb/scratchpad/realtime/harness.mjs` | Concurrent pollers (Data API ×5 variants, `eth_getLogs` ×2 RPCs, RTDS ×3) recording first-seen times |
| `/tmp/claude-0/-home-user/0b0b89e3-1d8f-579a-89c4-580887b6cffb/scratchpad/realtime/ethsub_harness.mjs` | `eth_subscribe` logs recorder (publicnode + drpc WS) |
| `/tmp/claude-0/-home-user/0b0b89e3-1d8f-579a-89c4-580887b6cffb/scratchpad/realtime/ws_harness.mjs` | RTDS recorder with silence watchdog |
| `/tmp/claude-0/-home-user/0b0b89e3-1d8f-579a-89c4-580887b6cffb/scratchpad/realtime/latency_report.py` | Builds the latency table against on-chain ground truth |
| `/tmp/claude-0/-home-user/0b0b89e3-1d8f-579a-89c4-580887b6cffb/scratchpad/realtime/run2_latency_report.txt`, `/tmp/claude-0/-home-user/0b0b89e3-1d8f-579a-89c4-580887b6cffb/scratchpad/realtime/run1_latency_report.txt` | Reports incl. per-fill detail and poller health |
| `/tmp/claude-0/-home-user/0b0b89e3-1d8f-579a-89c4-580887b6cffb/scratchpad/realtime/run1_firstseen.jsonl`, `/tmp/claude-0/-home-user/0b0b89e3-1d8f-579a-89c4-580887b6cffb/scratchpad/realtime/run2_firstseen.jsonl`, `/tmp/claude-0/-home-user/0b0b89e3-1d8f-579a-89c4-580887b6cffb/scratchpad/realtime/run2b_firstseen.jsonl`, `/tmp/claude-0/-home-user/0b0b89e3-1d8f-579a-89c4-580887b6cffb/scratchpad/realtime/run2c_firstseen.jsonl` | Raw first-seen rows per channel |
| `/tmp/claude-0/-home-user/0b0b89e3-1d8f-579a-89c4-580887b6cffb/scratchpad/realtime/run1_stats.jsonl`, `/tmp/claude-0/-home-user/0b0b89e3-1d8f-579a-89c4-580887b6cffb/scratchpad/realtime/run2_stats.jsonl`, `/tmp/claude-0/-home-user/0b0b89e3-1d8f-579a-89c4-580887b6cffb/scratchpad/realtime/run2c_wsevents.jsonl` | 30 s poller health samples; RTDS open/stall/close events |
| `/tmp/claude-0/-home-user/0b0b89e3-1d8f-579a-89c4-580887b6cffb/scratchpad/realtime/analyze_fills.py`, `/tmp/claude-0/-home-user/0b0b89e3-1d8f-579a-89c4-580887b6cffb/scratchpad/realtime/fills_analysis.txt`, `/tmp/claude-0/-home-user/0b0b89e3-1d8f-579a-89c4-580887b6cffb/scratchpad/realtime/fills_analysis.json` | Receipt decoding of 30 fills vs Data API (role, amounts, fee) |
| `/tmp/claude-0/-home-user/0b0b89e3-1d8f-579a-89c4-580887b6cffb/scratchpad/realtime/scan_orders.py`, `/tmp/claude-0/-home-user/0b0b89e3-1d8f-579a-89c4-580887b6cffb/scratchpad/realtime/scan_orders.out`, `/tmp/claude-0/-home-user/0b0b89e3-1d8f-579a-89c4-580887b6cffb/scratchpad/realtime/wallet_logs.json` | 45,000-block scan: roles, fills per order, fills per tx |
| `/tmp/claude-0/-home-user/0b0b89e3-1d8f-579a-89c4-580887b6cffb/scratchpad/realtime/sell_check.py`, `/tmp/claude-0/-home-user/0b0b89e3-1d8f-579a-89c4-580887b6cffb/scratchpad/realtime/sell_check.out` | SELL-side validation on other wallets |
| `/tmp/claude-0/-home-user/0b0b89e3-1d8f-579a-89c4-580887b6cffb/scratchpad/realtime/ratelimit_probe.py`, `/tmp/claude-0/-home-user/0b0b89e3-1d8f-579a-89c4-580887b6cffb/scratchpad/realtime/ratelimit_probe.out` | Block-range limits and burst tests |
| `/tmp/claude-0/-home-user/0b0b89e3-1d8f-579a-89c4-580887b6cffb/scratchpad/realtime/ws_filter_test.mjs`, `/tmp/claude-0/-home-user/0b0b89e3-1d8f-579a-89c4-580887b6cffb/scratchpad/realtime/ws_filter_test.out`, `/tmp/claude-0/-home-user/0b0b89e3-1d8f-579a-89c4-580887b6cffb/scratchpad/realtime/ws_probe.mjs` | RTDS filter variants and generic WS probe |
| `/tmp/claude-0/-home-user/0b0b89e3-1d8f-579a-89c4-580887b6cffb/scratchpad/realtime/ws_ethsub_probe.mjs`, `/tmp/claude-0/-home-user/0b0b89e3-1d8f-579a-89c4-580887b6cffb/scratchpad/realtime/ws_ethsub_probe.out` | `eth_subscribe` acceptance probe |
| `/tmp/claude-0/-home-user/0b0b89e3-1d8f-579a-89c4-580887b6cffb/scratchpad/realtime/sigs.mjs`, `/tmp/claude-0/-home-user/0b0b89e3-1d8f-579a-89c4-580887b6cffb/scratchpad/realtime/rcpt_e8d9.json`, `/tmp/claude-0/-home-user/0b0b89e3-1d8f-579a-89c4-580887b6cffb/scratchpad/realtime/goldsky_probe.out` | Event-signature hash search, sample receipt, Goldsky response |
| `/tmp/claude-0/-home-user/0b0b89e3-1d8f-579a-89c4-580887b6cffb/scratchpad/realtime/docs_dl/` | Polymarket docs pages as fetched 2026-11-13 |
