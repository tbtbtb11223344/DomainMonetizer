# Operations runbook

## Safety invariants

- Never change the apex, MX, DKIM, SPF, or DMARC records of `multibrands.net`.
- Control-plane DNS is limited to `admin.multibrands.net`, `preview.multibrands.net`, and `webhooks.multibrands.net`.
- Portfolio nameserver changes are exact-list operations after preview and rollback verification.
- A pilot domain must be `parking` + `available`, have no `Traffic2` label, carry the `DomainMonetizer` protection label before nameserver mutation, and pass a final registrar/API readback immediately before mutation. Domain Manager treats that label as a built-in block on automatic nameserver changes; an explicit manual nameserver action can still override it.
- Publish first, validate through an alternate hostname, then change one domain, verify TLS/DNS/HTTP/telemetry, and only then continue the pilot.
- Use `preview.multibrands.net` for visual QA. Use `/healthz` only for shared Worker liveness and each apex domain's `/readyz` for tenant readiness. Neither endpoint records a visitor event; do not repeatedly load live apex pages during the measurement window.
- The operator's currently available public IPv4/IPv6 addresses are excluded through a salted-hash Worker secret. Run `pnpm exclude:operator-ip` from the repository root whenever the operator's ISP address or VPN changes. The command never prints or persists the raw address, replaces the secret exclusion set with the current addresses, and verifies all pilot domains with telemetry-safe `HEAD` requests. An excluded tenant response carries `X-DM-Telemetry: excluded`.
- `HEAD` probes do not create page-view events on root or legacy paths. Browser `GET` requests do. Safe legacy paths render the canonical `noindex` guide and contribute only coarse intent classes; sensitive and scanner paths fail closed as `404` without telemetry.
- Tenant HTML must return `Cache-Control: no-store` while views are recorded server-side. Public HTML caching is a measurement defect; static `/__dm/` assets remain immutable and cacheable. The protected admin shell is also `no-store`, while its fingerprinted scripts, styles, fonts, and images keep their immutable asset caching so a normal reload follows the deployed Worker version.

## Commands

```powershell
pnpm check
pnpm exec wrangler d1 migrations apply domain-monetizer --local --config apps/control/wrangler.jsonc
pnpm sync:cloudflare-zones
pnpm --filter @domain-monetizer/site-edge dev
pnpm --filter @domain-monetizer/control dev
```

Production resource IDs are written into the Worker configs only after Cloudflare creates them. Secrets are installed with `wrangler secret put`; they never enter Git.

## Marketcall economic pilot

The code represents a provider offer separately from its affiliate campaign and exact website placements. A Marketcall route is eligible only when the offer, campaign, and domain-specific routing policy are all active. Redirect destinations must be HTTPS. Phone destinations must be E.164 and are returned only after `/go/:slot` records the click; the number is never rendered in tenant HTML.

Use one static Marketcall tracking number per domain when available. Marketcall permits a DID to appear on multiple websites, and the committed contract may explicitly allow that reuse for an exact vertical match. Dedicated numbers preserve conversion attribution and remain the safer default. A shared static DID still preserves DomainMonetizer click-to-call diagnostics by website, but a provider conversion without an exact click ID must keep `domain_id` null because the DID alone cannot identify the originating website. User-facing call-request analytics count each measurement-eligible U.S. phone handoff only when `visitor_id_hash` contains the valid 64-character lowercase hexadecimal hash derived from the first-party visitor cookie. Do not substitute the click ID for a missing cookie, do not include operator-excluded traffic, and do not deduplicate separate valid requests. Keep Marketcall records as a separate reconciliation ledger: every provider record appears as pending, qualified (`accepted`), or unsuccessful (`rejected`). A valid call request proves that a browser reached the phone handoff, not that a telephone call completed. Do not embed Marketcall's browser call-tracking script: it sends the current landing URL and referrer and can read advertising-attribution cookies, which exceeds this project's current privacy boundary.

Before any Marketcall activation:

1. Re-read the live offer and exact campaign rules. Confirm the domain's service intent, geography, accepted SEO traffic, call hours, qualified-call definition, hold period, and required disclosure.
2. Obtain provider approval for the exact landing page and campaign. Prefer one dedicated campaign number per domain; add a shared-DID placement only after explicit provider approval and an exact vertical/content review.
3. Add `webhooks.multibrands.net` as a custom domain on the control Worker without changing the apex, mail, or other `multibrands.net` records. Keep Cloudflare Access on `admin.multibrands.net`; the webhook hostname is public only at the secret path.
4. Generate a new independent `MARKETCALL_POSTBACK_SECRET` and install it with `wrangler secret put`. Do not reuse the internal-control, operator, Access, or runner secrets and do not store the webhook URL in Git.
5. Configure provider postbacks so Parsed and HOLD map to `outcome=pending`, Approved maps to `outcome=accepted`, and Refused, Non-qualified, and No connect map to `outcome=rejected`. Each URL passes only the call ID, campaign/program ID, provider status, USD payout, and currency. Static campaign numbers do not preserve a DomainMonetizer click ID, so do not invent or pass `subid`.
6. Test the provider callback and status transition before sending traffic. Verify inbox authentication, campaign attribution, exact click attribution where available, honest null-domain handling for a shared DID, idempotent retries, accepted payout, and a later refusal/clawback update. Never include caller phone, name, email, address, recording, raw landing URL, or referrer in the postback.
7. Deploy the explicit economic-pilot contract before activation. It requires the exact approved campaign and website-placement set, permits real click and conversion counters, and fails on route drift or failed/rejected postback processing.

The activation helper verifies the current provider offers, campaign attachment, and placement-domain verticals before it mutates D1. It requires an explicit postback-readiness assertion, records a D1 Time Travel bookmark, activates the exact committed routes, republishes every placement domain, and verifies the resulting route set:

```powershell
pnpm activate:marketcall
pnpm activate:marketcall -- --apply --postbacks-configured
```

## Control-data recovery

The production D1 database supports [Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/), which is always enabled and incurs no separate restore charge. Workers Free retains only seven days of point-in-time history. Confirm that recovery is available and record the current bookmark before a schema migration or other exceptional high-risk control-plane operation:

```powershell
pnpm --dir apps/control exec wrangler d1 time-travel info domain-monetizer --config wrangler.jsonc
```

The bookmark read is safe and non-mutating. A Time Travel restore overwrites the live database and cancels in-flight queries; never run `d1 time-travel restore` from an automation or as a speculative diagnostic. A restore requires the exact intended timestamp or bookmark, a fresh current bookmark that can undo the restore, and explicit user approval at action time.

Wrangler can also [export D1 to SQL](https://developers.cloudflare.com/d1/best-practices/import-export-data/). Treat every export as a sensitive database dump: write it only to an explicitly chosen encrypted location outside this repository, never print its contents, and never commit or deploy it. The seven-day built-in window is sufficient for the three-domain pilot. Before scaling, choose and test a longer-retention encrypted backup target; enabling R2, Workflows, or another hosted backup service remains a separate cost and architecture decision.

Content jobs are queued from the admin and consumed on demand from an authenticated machine with Codex already signed in. Use an independent `CODEX_RUNNER_SECRET` in both the control Worker and the runner process; do not reuse the site-edge/control secret. The runner produces a schema-constrained draft that still requires preview and explicit approval:

```powershell
$env:CODEX_RUNNER_SECRET = '<retrieve from your secret manager>'
$env:CODEX_MODEL = 'gpt-5.6-terra'
$env:CODEX_TIMEOUT_SECONDS = '1200'
pnpm runner:codex
```

When the deployment API token cannot manage zone routes, create custom domains in the Cloudflare dashboard once and deploy versioned code without changing triggers:

```powershell
pnpm --dir apps/control exec wrangler versions upload --keep-vars
pnpm --dir apps/control exec wrangler versions deploy <version-id>@100% --yes
```

After a control deployment, do not immediately publish content. First confirm `wrangler deployments status` reports the intended version at 100%, then call an authenticated `/api/content/:id/preview` for an approved test item until its rendered HTML contains the expected current-template marker or identity. Cloudflare can briefly serve the outgoing Worker while a new deployment propagates; a successful deployment command alone is not proof that the compiler serving API requests has changed.

The committed pilot evidence collector is read-only. Exact verification should be run immediately before a registrar mutation:

```powershell
python ops/collect_pilot_evidence.py `
  --domain-manager-root C:\Users\ttttb\OneDrive\Documents\Projects\DomainManager `
  --domains example.com `
  --parklogic-checks 1
```

`preview.multibrands.net` is a seven-day KV alias of one approved release. It is not a portfolio record and must never be imported into the domains table. Publishing a preview does not change the selected domain's DNS.

After creating or reviewing a Cloudflare zone, record its assignment with `pnpm sync:cloudflare-zones`. The command reads each approved zone directly from Cloudflare, fails closed if its zone ID or assigned pair differs from `ops/pilot_seed.json`, writes the verified metadata through the authenticated control API, and checks the API readback. It never changes registrar delegation or Cloudflare DNS.

## Scheduled evidence and readiness

The analytics rollup runs at `04:17 UTC`. It compares D1 with every completed UTC day from `TELEMETRY_MIN_DATE`, then rolls up the oldest five missing dates. Normal operation processes one day; the bounded replay automatically repairs gaps without exceeding the Free-plan subrequest budget. `TELEMETRY_MIN_DATE` is the retained clean-data boundary; a rollup before it records a `skipped` run and writes no domain metrics. Stream selection is independent of evidence eligibility: August 10–11 are read from the v3 qualified-session stream (including its U.S. field), while `EXACT_SESSION_MIN_DATE` is the first full UTC day eligible for the v4 stream and decision-grade evidence. A server-signed daily marker limits each browser to one qualified point per hostname and UTC day. The v4 point uses one of sixteen deterministic `qualified_v4:<domain-id>:<hex-shard>` indexes selected from the daily visitor hash; the hash itself is not written to this stream. The rollup issues one bounded query per published domain across its index allowlist, preventing a busy domain from forcing portfolio-wide session sampling while remaining under the Worker subrequest limit. Preview-host events are always excluded. Every rollup stores the maximum `_sample_interval` across all queries and the maximum interval from the qualified-session query. A day counts toward the 14-day decision window only when every domain's v4 session query is unsampled and the same day's telemetry canaries verify. Earlier v2/v3, sampled, or failed days remain visible as latest-day context but do not count and must never be presented as zero exact uniques. Other sampled breakdowns remain sampling-adjusted estimates and must be interpreted with their displayed maximum interval.

The 09:00 Asia/Singapore pilot audit runs before that daily rollup. It tolerates exactly one pending completed UTC day only until `04:27 UTC`, and only when every earlier day is covered and the latest rollup succeeded. A multi-day gap, a prior failed attempt, or any gap at or after that deadline remains an operational failure.

Tenant readiness runs at `00:47`, `06:47`, `12:47`, and `18:47 UTC`. It checks up to 20 published domains through their public `/readyz` endpoint, requires the exact active release ID, and stores 90 days of results. Scheduled checks are labeled separately from operator-triggered checks and are idempotent for a domain/timestamp. The pilot must never exceed 20 published domains without replacing this bounded monitor with queued or cursor-batched work. A check is fresh for eight hours; stale, unchecked, unreachable, non-200, or release-mismatched tenants block scale review. After completed clean days exist, every tenant must also have at least 95% scheduled-check coverage and 95% ready scheduled checks. Manual checks can restore current readiness but cannot inflate historical reliability.

The overview and `pnpm audit:pilot` also enforce the current UTC day's schedule before rollup. Each cron slot is visible as expected at its scheduled minute and becomes required after a ten-minute grace period. A missing, duplicate, or non-ready per-domain check fails the operational guard immediately; do not substitute a manual check because manual rows cannot satisfy this contract. After the first slot becomes required, `audit:pilot` also reads the current UTC day's distinct scheduled canaries directly from Analytics Engine and reconciles them with the stored scheduled rows. Missing, extra-domain, extra-count, or sampled canaries therefore fail the same-day audit instead of waiting for tomorrow's rollup.

Every authenticated readiness request also writes a non-visitor `health_canary` event carrying the same unique check ID. The daily rollup compares scheduled D1 check IDs with distinct Analytics Engine canaries per tenant. `telemetry.pipelineVerified` is true only when every completed day has exact, unsampled canary coverage. Canary events are explicitly excluded from view, engagement, click, country, source, and qualified-session queries. A successful zero-traffic rollup is decision-grade only when this canary gate is also verified.

An authenticated operator can run the same safe check immediately. It creates no visitor telemetry:

```powershell
$headers = @{ Authorization = "Bearer $env:OPERATOR_API_TOKEN"; "CF-Access-Client-Id" = $env:CF_ACCESS_CLIENT_ID; "CF-Access-Client-Secret" = $env:CF_ACCESS_CLIENT_SECRET }
Invoke-RestMethod -Method Post -Uri https://admin.multibrands.net/api/health/check -Headers $headers
```

An authenticated operator can safely re-run a completed date. Current and future UTC dates are rejected at both the API and rollup-core layers. The operation is idempotent for metric rows and creates an audit record:

```powershell
$headers = @{ Authorization = "Bearer $env:OPERATOR_API_TOKEN"; "CF-Access-Client-Id" = $env:CF_ACCESS_CLIENT_ID; "CF-Access-Client-Secret" = $env:CF_ACCESS_CLIENT_SECRET; "Content-Type" = "application/json" }
Invoke-RestMethod -Method Post -Uri https://admin.multibrands.net/api/metrics/rollup -Headers $headers -Body '{"date":"2026-08-05"}'
```

Review `/api/metrics/overview` or the admin inspector after the run. `latestCompletedDate` is the coverage target; `rollupThrough` alone is not proof of completeness. A failed or missing rollup is an operational defect, keeps `rollupCoverageComplete=false`, and is retried by the next schedule. `sampling.kpiAvailable=false` means the exact qualified-unique KPI is unavailable and the UI must render a dash rather than zero. Confirm `telemetry.pipelineVerified=true` and `sampling.exactQualifiedSessions=true` before treating a zero qualified-session total as decision-grade. `sampling.detected=true` by itself means one or more weighted quality breakdowns were sampled, not that the session count was sampled.

For a deterministic, telemetry-safe portfolio readback, run `pnpm audit:pilot`. It compares the exact pilot allowlist with the control-plane inventory, validates source eligibility, resolves every public `/readyz` response against the active release ID, checks stored freshness and scheduled reliability, confirms the offer/click/conversion/postback ledgers remain dormant, and reports evidence-gate state plus per-domain totals. It exits with code `2` only for an operational problem; `observation_window` and `qualified_sessions` remain decision outcomes. Its `decision.action` is `continue_collecting`, `repair_pilot`, `do_not_scale`, or `review_scale_candidate`. Only the last two request operator attention, and `review_scale_candidate` still requires a per-domain quality review rather than authorizing expansion. The audit never requests tenant HTML and therefore creates no visitor events.

Run `pnpm audit:sources` alongside it to re-read the three exact pilots from the live Domain Manager and DomainAnalyzer databases. This second read-only guard fails if a domain no longer satisfies `parking` + `available` + no `Traffic2`, loses its required `DomainMonetizer` protection label, if the expected vertical/US classification drifts, or if a new identity/legal risk flag appears. It deliberately skips ParkLogic after cutover because Cloudflare's clean, bot-classified telemetry is the scale-decision source; use `collect_pilot_evidence.py` manually when a fresh parking-provider comparison is needed.

For traffic quality, inspect each domain's `sourceMetrics`, `intentMetrics`, and `contextMetrics` in `/api/domains/:hostname`, or the **Traffic quality**, **Entry intent**, and **Where and when** sections in the admin inspector. A browser-navigation classification is evidence, not proof by itself: review country, US state, ASN organization, engagement, concentration, path class, device class, referrer class, and local-time bucket. Hosting, cloud, research, or unexpected-country networks should be investigated before counting the traffic as commercially useful. Raw paths, query strings, referrer URLs, city, ZIP, coordinates, exact local hour, and raw timezone must never be added to the rollup or admin response.

## Emergency rollback

1. Pause the affected hostname in the admin API.
2. If the release is the fault, select the last known-good release and invoke rollback.
3. If edge routing is the fault, restore the exact nameservers captured in the DomainManager action record.
4. Confirm authoritative and recursive DNS, TLS, page response, and telemetry after every action.
