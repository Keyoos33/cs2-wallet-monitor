# Infrastructure notes: always-on poller, push, dashboard

Researched 2026-11-13. One user, zero budget, poll every 3-10 s, push to one iPhone, small dashboard.

## How to read the sourcing

- **[read today]** means I read the page (or its source file) on 2026-11-13.
- **[memory]** means I could not open the page today; verify before relying on it.
- **[search snippet]** means a web-search summary only, usually third-party; treat as unverified.
- `developers.cloudflare.com` is not reachable from this container. All Cloudflare numbers come from the docs source repository (`cloudflare/cloudflare-docs`, branch `production`), which is what that site is built from. Each one is cited with the public docs URL.
- Also blocked from here: `core.telegram.org`, `api.telegram.org`, `pushover.net`, `docs.deno.com`, `docs.github.com`, `docs.val.town`, `docs.ntfy.sh` and the Polymarket API hosts. Nothing was deployed or tested end to end.
- Wrangler findings come from reading the published `wrangler@4.161.0` bundle (latest on npm today). I did not run it.

## Recommendation in short

1. **Host:** Cloudflare Workers Free, one Worker plus one SQLite-backed Durable Object (DO). The DO re-arms an alarm every 5 s; a 1-minute cron restarts the chain if it ever stops. Rows live in the DO's own SQLite, so D1 and KV are not needed.
2. **Push:** keep the existing Telegram bot as the primary channel. The ntfy iOS app has open "no push at all" reports right now, including for ntfy.sh topics. Bark is the free second channel; Pushover is the paid one ($4.99 once).
3. **Dashboard:** a long random token in the URL, stored as a Worker secret.
4. **Deploy:** `wrangler deploy` with a dummy `CLOUDFLARE_API_TOKEN`, a real `CLOUDFLARE_ACCOUNT_ID`, and the proxy injecting `Authorization` for `api.cloudflare.com`.

---

## 1. Cloudflare Workers Free as host

### Limits [read today]

| Item | Free plan limit | Source |
|---|---|---|
| Worker requests | 100,000/day, resets 00:00 UTC, then Error 1027 | https://developers.cloudflare.com/workers/platform/limits/#daily-requests |
| CPU time per HTTP request | 10 ms | https://developers.cloudflare.com/workers/platform/limits/#cpu-time |
| CPU time per Cron Trigger | 10 ms | same |
| Wall time, Cron Trigger | 15 min | https://developers.cloudflare.com/workers/platform/limits/#duration |
| Wall time, DO alarm handler | 15 min | same |
| `waitUntil()` after an HTTP response | up to 30 s | same |
| Subrequests per invocation | 50 (1,000 to internal services) | https://developers.cloudflare.com/workers/platform/limits/#subrequests |
| Connections waiting for headers | 6 | https://developers.cloudflare.com/workers/platform/limits/#simultaneous-open-connections |
| Cron Triggers per account | 5 | https://developers.cloudflare.com/workers/platform/limits/#account-plan-limits |
| Cron minimum interval | 1 minute (5-field cron); changes take up to 15 min to propagate; runs "on underutilized machines" | https://developers.cloudflare.com/workers/configuration/cron-triggers/ |
| DO on Free | SQLite-backed classes only | https://developers.cloudflare.com/durable-objects/platform/pricing/ |
| DO requests | 100,000/day; alarm invocations count as requests | same |
| DO duration | 13,000 GB-s/day, billed at 128 MB while active or unable to hibernate | same |
| DO SQLite rows read | 5 million/day | same |
| DO SQLite rows written | 100,000/day; each `setAlarm()` is one row written | same |
| DO storage | 5 GB total per account | https://developers.cloudflare.com/durable-objects/platform/limits/ |
| Over a free limit | "further operations of that type will fail with an error" until 00:00 UTC | https://developers.cloudflare.com/durable-objects/platform/pricing/ |
| DO alarms | one per object, at-least-once, retried with exponential backoff from 2 s, up to 6 retries; no minimum interval documented | https://developers.cloudflare.com/durable-objects/api/alarms/ |
| DO hibernation | idle and hibernatable is not billed; `setTimeout`/`setInterval` or an in-flight request blocks it | https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/ |
| D1 rows read / written | 5 million/day / 100,000/day | https://developers.cloudflare.com/d1/platform/pricing/ |
| D1 size | 500 MB per database, 5 GB per account, 10 databases | https://developers.cloudflare.com/d1/platform/limits/ |
| D1 queries per invocation | 50 (a `db.batch()` counts as one) | same |
| KV writes | 1,000/day to different keys, 1/s to the same key | https://developers.cloudflare.com/kv/platform/limits/ |
| KV reads | 100,000/day | same |

Two things the docs do not settle:

- **CPU limit for a DO alarm on Free.** The DO FAQ says DOs "have the same per invocation CPU limits as any Workers" and also "by default 30 seconds". Assume 10 ms per alarm and keep each tick to one small `JSON.parse`. Watch for `exceededCpu` after deploy.
- **Whether cron invocations count against the 100,000/day Worker requests.** At 1,440/day it does not matter.

### Design arithmetic

One poll every 5 s is 86,400 / 5 = **17,280 polls/day**. At 3 s it is 28,800.

**(A) Cron every minute, handler loops 12 polls with sleeps**

- 1,440 invocations/day, each about 55 s wall time; the 15 min limit is fine. A scheduled handler can simply `await` the loop, so `waitUntil` is not needed.
- Subrequests per invocation: 12 polls + pushes + storage calls must stay under 50. It fits normally, but a burst of new rows can exceed it.
- CPU: 12 JSON parses plus storage calls share one 10 ms budget. This is the weak point.
- No memory between invocations, so the cursor must be read from D1 every minute. KV cannot hold it: 1,000 writes/day.
- Cron start time is not exact, so there are gaps or overlaps at each minute boundary.
- Verdict: works, but fragile on CPU and timing.

**(B) DO alarm chain every 5 s plus 1-minute cron watchdog (recommended)**

| Meter | Use per day at 5 s | Limit | Share |
|---|---|---|---|
| DO requests: 17,280 alarms + 1,440 watchdog calls | 18,720 | 100,000 | 19% |
| Rows written: 17,280 `setAlarm` + new rows (assume under 1,000) | about 18,300 | 100,000 | 18% |
| Duration: 17,280 x 1 s (assumed fetch time) x 0.128 GB | 2,212 GB-s | 13,000 | 17% |
| Worker requests: 1,440 cron + dashboard views | about 1,500 | 100,000 | 2% |
| Rows read: one dashboard view of 3,000 rows | 3,000 per view | 5,000,000 | about 1,600 views/day |

- At 3 s: 30,240 DO requests and about 29,800 rows written per day, both about 30%.
- The floor is roughly 1 s: 100,000 alarms/day is one every 0.86 s, and rows written hits the same cap.
- Worst case for duration, the DO never hibernates: 86,400 s x 0.128 GB = 11,059 GB-s, still under 13,000.
- Each alarm is a fresh invocation, so the 50-subrequest and CPU budgets reset every tick.
- Rules to keep it inside the budget: write to storage only when a new row appears, keep the cursor in memory and reload it in the constructor, and never use `setTimeout` in the DO.
- If the handler throws, Cloudflare retries up to 6 times and then the chain stops. So catch all errors, call `setAlarm` first in the handler, and let the cron re-arm when `getAlarm()` is null or stale.

**(C) DO holding an outbound WebSocket**

- Only useful if the source offers a WebSocket feed for the data needed; the brief describes an HTTPS GET API.
- An outbound WebSocket blocks hibernation, so the DO is billed all day: 11,059 GB-s, 85% of the allowance.
- A pending operation protects the DO from eviction for at most 15 minutes, and code deploys reset it. It still needs the alarm and watchdog for reconnects.
- Verdict: more moving parts and five times the duration use of B.

**Storage choice:** DO SQLite. It has the same row allowances as D1, needs no extra token permission, and no network hop. KV is ruled out by 1,000 writes/day.

---

## 2. API token and wrangler

### Permissions

Cloudflare's own CI guide says to use the **Edit Cloudflare Workers** template. [read today] https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/

That template contains: Workers Scripts Write, Workers KV Storage Write, Workers R2 Storage Write, Workers Tail Read, Account Settings Read (account); Workers Routes Write (zone); User Details Read, User Memberships Read (user). [read today] https://developers.cloudflare.com/fundamentals/api/reference/template/

- For the recommended design (Worker + DO + cron + workers.dev), the template is enough. DO classes, migrations, cron schedules and the workers.dev toggle are all under `/accounts/{id}/workers/...`.
- **D1 is not in the template.** If D1 is used, add **Account > D1 > Edit**. [read today] https://developers.cloudflare.com/fundamentals/api/reference/permissions/
- A minimal custom token would be Account > Workers Scripts > Edit, plus Account Settings Read. This is my inference from the endpoints wrangler calls; I did not test it. The template is the safe choice.
- With `CLOUDFLARE_ACCOUNT_ID` set, wrangler does not need to look up accounts and memberships, so the two User permissions are optional.

### Owner steps (labels from the docs read today; the dashboard may differ slightly)

1. Sign up at https://dash.cloudflare.com and verify the email. No card is needed for Workers Free [memory].
2. Open **Workers & Pages** once and accept the `workers.dev` subdomain. Wrangler has code to register one, but it prompts, which does not work unattended.
3. Go to **My Profile > API Tokens** (https://dash.cloudflare.com/profile/api-tokens) and select **Create Token**. https://developers.cloudflare.com/fundamentals/api/get-started/create-token/
4. Choose the **Edit Cloudflare Workers** template. In the newer layout this is under **Permission policies > Custom dropdown > Edit Cloudflare Workers**.
5. Under account resources select only this account. For zone resources choose that account's zones (there are none; it is harmless).
6. Optional: add D1 Edit, set an expiry.
7. **Continue to summary > Create Token**. Copy the secret once (it starts with `cfut_`) and enter it in the proxy's secret form for host `api.cloudflare.com`, header `Authorization`, prefix `Bearer`.
8. Send the agent the **Account ID** (Workers & Pages overview, right-hand side). It is not a secret.

An account-owned token (**Manage account > Account API tokens**, prefix `cfat_`) also works and is not tied to the user. https://developers.cloudflare.com/fundamentals/api/get-started/account-owned-tokens/

### Hosts wrangler contacts (from the 4.161.0 bundle)

| Host | When | Needed |
|---|---|---|
| `api.cloudflare.com` | every API call: upload, DO migrations, schedules, workers.dev toggle, secrets | Yes. Reachable from this container today. |
| `registry.npmjs.org` | install, and an update check at startup | Install only. The update check has a timeout and is not fatal. |
| `sparrow.cloudflare.com` | usage telemetry | No. Set `WRANGLER_SEND_METRICS=false`. |
| `platform.dash.cloudflare.com` | crash reports (Sentry) | No. Set `WRANGLER_SEND_ERROR_REPORTS=false`. |
| `dash.cloudflare.com`, `welcome.developers.workers.dev` | OAuth `wrangler login` only | No, not used with a token. |
| `<name>.<subdomain>.workers.dev` | not contacted by wrangler; needed by the agent to smoke-test the deploy | Add to the allowlist. |

The API base URL defaults to `https://api.cloudflare.com/client/v4`. [read today] https://developers.cloudflare.com/workers/wrangler/system-environment-variables/

### Dummy token behind the injecting proxy

Yes, this should work, with one check to run first.

- Wrangler reads `CLOUDFLARE_API_TOKEN` and uses it as-is; I found no format check in `getAuthFromEnv`. It sends `Authorization: Bearer <dummy>`, so the proxy must **replace** the header, not add a second one.
- Set `CLOUDFLARE_ACCOUNT_ID`, otherwise wrangler calls `/memberships` and `/accounts` to pick an account.
- Wrangler's HTTP client is undici with `EnvHttpProxyAgent`, so it follows `HTTPS_PROXY`. Set `NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt` for the proxy's CA.
- Pass secrets (dashboard token, Telegram token) with `wrangler secret put` or `wrangler deploy --secrets-file`; both go to `api.cloudflare.com`. The agent would see those values, so the owner may prefer to set them in the dashboard.
- First command to run: `wrangler whoami`. If it lists the account, the injection works.

```sh
export CLOUDFLARE_API_TOKEN=dummy CLOUDFLARE_ACCOUNT_ID=<id>
export WRANGLER_SEND_METRICS=false WRANGLER_SEND_ERROR_REPORTS=false
export NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt
npx wrangler whoami && npx wrangler deploy
```

---

## 3. Alternatives if Cloudflare is refused

| Option | Verdict | Sourcing |
|---|---|---|
| Deno Deploy cron | Cron syntax bottoms out at every minute; free organisations get at most 10 cron jobs per revision. Sub-minute needs an in-handler loop, and the handler time limit is unverified. | [read today] https://docs.deno.com/deploy/reference/cron/ |
| Val Town | Blocked: free crons run at most every 15 minutes; 1 minute needs Pro. | [search snippet] https://docs.val.town/vals/cron |
| Fly.io | Blocked on budget: new accounts get a short trial only, card required. | [search snippet, third-party] https://www.saaspricepulse.com/blog/flyio-pricing-history |
| Render free web service | Blocked: spins down after about 15 idle minutes; staying up needs an external pinger. | [search snippet, third-party] https://render.com/articles/platforms-with-a-real-free-tier-for-developers-in-2026 |
| Koyeb free instance | Blocked: scales to zero when idle; card with a hold reportedly required since Feb 2026. | [search snippet, third-party] https://snapdeploy.dev/state-of-free-hosting |
| Oracle Always Free VM | Works technically (a real VM running a loop). Needs a card at signup [memory], and idle instances can be reclaimed when 95th-percentile CPU is under 20% over 7 days. Reports of a reduced A1 allowance in 2026 are unconfirmed. | https://docs.oracle.com/en-us/iaas/Content/FreeTier/resourceref.htm [search snippet] |
| GitHub Actions, public repo, self-re-dispatching job | Works technically: free minutes on public repos, 6 h job limit, re-dispatch before timeout [memory]. Code and logs become public, there are gaps at each hand-over, and using Actions as a permanent server risks a terms-of-service shutdown. Best free fallback. | [memory] https://docs.github.com/en/actions/reference/limits |
| Google Cloud e2-micro free VM | Works technically, always-on; card required. | [memory] https://cloud.google.com/free |

---

## 4. iPhone push channel

| Channel | Cost | Owner setup | Seconds-level reliability today | Limits |
|---|---|---|---|---|
| **Telegram bot** | Free | None, already working | Good. Telegram's own APNs path; delivery does not depend on a small third-party app. | About 1 message/s per chat, 30/s overall [search snippet] https://core.telegram.org/bots/faq ; 4,096 characters per message [memory] |
| **Bark** | Free, open source | Install app, copy device key | Good [memory]: direct APNs, supports time-sensitive and critical levels. Relies on the author's free server `api.day.app`. | Payload about 4 KB [memory] https://github.com/Finb/Bark |
| **Pushover** | $4.99 once per platform after a 30-day trial | Install app, create account and app token | Very good; built for alerting. | 10,000 messages/month [search snippet] https://pushover.net/pricing |
| **ntfy.sh** | Free | Install app, subscribe to topic | **Poor right now.** See below. | 250 messages/day on ntfy.sh, 4,096 bytes per message, title 1 KB [read today] https://docs.ntfy.sh/publish/#limitations |
| Apple Shortcuts | Free | Build an automation | Not suitable: Shortcuts cannot receive a server push; it can only poll on a schedule, at minute granularity at best [memory]. | |

### ntfy on iOS [read today]

- Issue #2117, opened 2026-10-28, still open: "iOS 27.0.1: no push notifications at all, messages only appear when opening the app", confirmed by five users, including for ntfy.sh topics. Restarting or reinstalling fixed it for some. The maintainer suspects a lost Firebase registration and said on Nov 3 he will "soon work on the iOS app again". https://github.com/binwiederhier/ntfy/issues/2117
- Issue #1844, opened 2026-07-15, still open: same symptom; a collaborator wrote "It's known that iOS notifications are finicky (but it's not known exactly why)". https://github.com/binwiederhier/ntfy/issues/1844
- The maintainer's own plan lists "Push notifications stop arriving with no visible error" as the top problem. https://github.com/binwiederhier/ntfy/issues/1680
- The docs call the iOS app "very bare bones and quite frankly a little buggy". https://docs.ntfy.sh/faq/
- iOS has no "instant delivery" mode; that is Android only. iOS delivery goes ntfy.sh to Firebase to APNs. https://docs.ntfy.sh/config/#ios-instant-notifications
- Privacy: the topic name is the password; anyone who knows it can read and publish. Use a long random name. https://docs.ntfy.sh/faq/
- Click URL is documented as supported on iOS. https://docs.ntfy.sh/publish/#click-action Priority handling on iOS is weaker than on Android [memory].

### Verdict

Telegram first: zero setup, already proven with this owner, and reliable. Bark second as the free independent backup; choose Pushover instead if $4.99 is acceptable. Sending to two channels costs one extra subrequest per new row.

Telegram has no priority field. The equivalent is `disable_notification: false`, plus the owner giving the bot chat a distinct sound and allowing Telegram through Focus modes.

### Exact requests

Telegram (title in bold, button as click URL) [memory for field names; `api.telegram.org` could not be reached to test]:

```http
POST https://api.telegram.org/bot<BOT_TOKEN>/sendMessage
Content-Type: application/json

{"chat_id": "<CHAT_ID>",
 "text": "<b>New trade</b>\nwallet 0xabc bought 500 YES @ 0.62",
 "parse_mode": "HTML",
 "disable_notification": false,
 "link_preview_options": {"is_disabled": true},
 "reply_markup": {"inline_keyboard": [[{"text": "Open dashboard", "url": "https://<worker>.workers.dev/d/<token>"}]]}}
```

Bark [JSON shape read today in the Bark tutorial; `level` value from memory] https://github.com/Finb/Bark/blob/master/docs/en-us/tutorial.md :

```http
POST https://api.day.app/push
Content-Type: application/json; charset=utf-8

{"device_key": "<KEY>", "title": "New trade", "body": "wallet 0xabc bought 500 YES @ 0.62",
 "url": "https://<worker>.workers.dev/d/<token>", "level": "timeSensitive"}
```

Pushover [memory] https://pushover.net/api :

```http
POST https://api.pushover.net/1/messages.json
Content-Type: application/x-www-form-urlencoded

token=<APP_TOKEN>&user=<USER_KEY>&title=New+trade&message=wallet+0xabc+bought+500+YES&url=https%3A%2F%2F...&url_title=Open+dashboard&priority=1
```

ntfy, for reference [read today] https://docs.ntfy.sh/publish/ :

```http
POST https://ntfy.sh/<long-random-topic>
Title: New trade
Priority: high
Click: https://<worker>.workers.dev/d/<token>

wallet 0xabc bought 500 YES @ 0.62
```

---

## 5. Dashboard protection on workers.dev

| Option | Effort | Notes |
|---|---|---|
| **Secret token in the path** (recommended) | Minutes | `https://<worker>.workers.dev/d/<32+ random chars>`; return 404 for anything else. Works as a home-screen bookmark and as the push click URL. |
| HTTP Basic auth | Minutes | Works, but iOS Safari re-prompts and home-screen web apps handle it badly [memory]. |
| Cloudflare Access (Zero Trust free) | 15-30 min of owner clicks | Real login by email code, free for up to 50 users, can be switched on for workers.dev [memory]. Adds a login step when tapping a notification, and the token would need Access permissions. Overkill here. |

The data is public on-chain, so the goal is only to stop strangers and crawlers from using up the daily quotas. A path token does that.

Implementation notes:

- Store the token as a Worker secret, compare in constant time, and apply it to the JSON API as well.
- Send `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex` and `Cache-Control: private`.
- Rotating the token is a one-line secret update.

---

## Risks

1. **Free-tier terms can change.** DOs on the Free plan are fairly recent. When a daily limit is hit, operations fail until 00:00 UTC; nothing is billed.
2. **CPU limit on alarms is ambiguous** (10 ms or 30 s). Keep ticks tiny and check for `exceededCpu`.
3. **Alarm chain can stop** after 6 failed retries or a platform incident. The cron watchdog covers this; worst-case gap is about a minute, or up to 15 minutes right after the first deploy while the cron propagates.
4. **Polymarket may rate-limit or block Cloudflare egress IPs.** Not testable from here; check on the first deploy and add backoff on 429/403.
5. **Alarm timing is not guaranteed** to the millisecond; expect 5 s plus fetch time between polls.
6. **Telegram depends on the phone's notification settings** (mute, Focus). There is no server-side override.
7. **Untested pieces:** the dummy-token flow, the minimal token scope, and every push request above.
8. **Container allowlist** must include `api.cloudflare.com` (already open) and the final `*.workers.dev` hostname for smoke tests.
