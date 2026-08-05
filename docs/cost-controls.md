# Cloudflare cost controls

DomainMonetizer stays on Cloudflare's free products until clean natural-traffic evidence justifies scale. A paid Cloudflare plan, paid add-on, external VPS, queue, or hosted AI service requires an explicit cost review and user authorization.

D1 Time Travel is already active at no additional charge and provides seven days of recovery history on Workers Free. It is the pilot recovery mechanism, not a long-term backup. A longer-retention D1 export destination must be selected, costed, and restore-tested before scale; the current project must not activate R2 or Workflows merely to create a premature backup pipeline.

## Verified baseline

The live account was audited on `2026-08-05` Singapore time through both the Cloudflare API and the signed-in Billing page:

- `Teams Free Base`: active at `$0.00/month`. Its displayed renewal remains `$0.00/month`; it is not a paid trial conversion.
- `Beta Analytics Engine API`: active at `$0.00/month`.
- Four zones used by this project: Cloudflare Free Plan.
- Two Workers: `domain-monetizer-site-edge` and `domain-monetizer-control`.
- One D1 database, approximately `0.6 MB` at the 2026-08-05 audit.
- One KV namespace, one Analytics Engine dataset, two Cron schedules, one Access app, and zero Queues.
- No R2 binding, Workers AI binding, Workflow, Durable Object, or external VPS.

Cloudflare's [Zero Trust pricing](https://www.cloudflare.com/plans/zero-trust-services/) lists the Free plan as `$0 forever` for up to 50 users. DomainMonetizer has one operator. The [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) says Free is the default plan; Free-plan operations stop at their limits instead of producing metered overage charges.

The repository deliberately does not use the R2/S3 credentials present in the local environment. Static assets are bundled with the Workers, which is simpler and avoids an unnecessary storage product.

## Free-plan operating envelope

These are account-wide Cloudflare limits, not per-domain allocations:

| Product | Free allowance relevant to this pilot | Failure behavior |
| --- | ---: | --- |
| Workers | 100,000 requests/day; 10 ms CPU/invocation | Requests over the daily limit fail |
| D1 | 5 million rows read/day; 100,000 rows written/day; 5 GB total | Queries over a daily limit fail until reset |
| KV | 100,000 reads/day; 1,000 writes, deletes, and list requests/day; 1 GB | Operations over the daily limit fail until reset |
| Analytics Engine | 100,000 points written/day; 10,000 read queries/day | Free allowance; billing is not active as of this audit |
| Zero Trust | 50 users | Remain below the seat limit |

Sources: [Workers and D1 pricing](https://developers.cloudflare.com/workers/platform/pricing/), [KV pricing](https://developers.cloudflare.com/kv/platform/pricing/), and [Analytics Engine pricing](https://developers.cloudflare.com/analytics/analytics-engine/pricing/).

Analytics Engine deserves a separate watch: Cloudflare currently says it is not billing usage, but has published future pricing. Recheck its Billing subscription and current documentation before the portfolio is expanded.

## Repeatable audit

Run this read-only command from the repository root:

```powershell
pnpm audit:cloudflare-costs
```

The script reads the existing Cloudflare API credentials, redacts credentials and billing identity, and prints only plan names/prices plus DomainMonetizer's resource inventory. It exits with code `2` if any positive-price account subscription is found, any required inventory read cannot be proven, or the project differs from the committed free-pilot contract: exactly two Workers, the two expected control schedules, the exact eight admin/preview/pilot Worker hostnames, one D1 database no larger than the `50 MiB` pilot guard, one KV namespace, one protected admin app, no project Queue, and no paid or out-of-scope Worker binding. The account is shared, so a billing failure requires attribution in the Cloudflare Billing page before changing anything. An intentional architecture change requires updating this contract in the same reviewed change.

## D1 growth boundary

Cloudflare currently limits a Workers Free D1 database to `500 MB`. The live 2026-08-05 sample measured an average immutable release snapshot of `9,471.5 bytes` and an average content version of `3,006.7 bytes`. At the pilot's current depth of seven releases and five content versions, that is about `81 KB` of version payload per domain before indexes, audit history, readiness checks, and daily metrics. Keeping every version forever is therefore not a scale-safe retention policy.

The `50 MiB` contract guard is an early pilot alarm, not a capacity target. Before publishing more than 1,000 domains, measure the then-current per-domain footprint and choose one of two explicit paths: retain only a bounded number of superseded releases and content versions while preserving every active pointer, or move the control database to a paid capacity plan. Keep at least 25% database headroom after accounting for telemetry and indexes. See Cloudflare's current [D1 limits](https://developers.cloudflare.com/d1/platform/limits/).

Run the audit:

1. before publishing domain 21;
2. before enabling Marketcall automation or any new Cloudflare product;
3. before adding a VPS;
4. whenever Cloudflare announces Analytics Engine billing; and
5. monthly while the pilot is active.

Publishing domain 21 also requires redesigning the scheduled readiness monitor, whose current 20-domain cap is an intentional Workers Free safety limit.

## Domain-routing scale boundary

The current `site-edge` Worker uses one full Cloudflare zone per portfolio apex. Cloudflare's [Workers limits](https://developers.cloudflare.com/workers/platform/limits/#routes-and-domains) currently allow at most 1,000 routed zones per Worker, so `900` is the maximum planning boundary for this topology, not a target to fill automatically.

Standard [Cloudflare for SaaS plans](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/plans/) include 100 custom hostnames, permit up to 50,000, and charge `$0.10/month` for each additional hostname. Because the portfolio zones already use Cloudflare authoritative DNS, a standard custom-hostname design can use an apex CNAME; Cloudflare [flattens apex CNAMEs automatically](https://developers.cloudflare.com/dns/cname-flattening/set-up-cname-flattening/). This must still be proven with a same-account canary because certificate validation, hostname priority, rollback, and billing are production concerns.

Illustrative hostname charges, excluding every other cost:

| Total hostnames | Monthly Cloudflare for SaaS hostname charge |
| ---: | ---: |
| 100 | `$0` |
| 1,000 | `$90` |
| 5,000 | `$490` |
| 10,000 | `$990` |

Do not activate Cloudflare for SaaS or create Worker shards during the three-domain measurement pilot. At a future scale review, compare these charges with measured accepted revenue per valid session and renewal cost. Prefer Cloudflare for SaaS at multi-thousand scale when the unit economics cover it; use Worker shards only when the fee is material enough to justify their greater deployment and rollback complexity.

## Authorization boundary

Do not enable Workers Paid, Zero Trust pay-as-you-go, R2, Queues, Workflows, Durable Objects, Workers AI, Logpush, Stream, Images, or an external VPS without a concrete capacity need, a projected monthly cost, and user approval. Exceeding a free limit is an availability signal to investigate; it is not permission to upgrade automatically.
