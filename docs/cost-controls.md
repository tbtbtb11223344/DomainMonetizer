# Cloudflare cost controls

DomainMonetizer stays on Cloudflare's free products until clean natural-traffic evidence justifies scale. A paid Cloudflare plan, paid add-on, external VPS, queue, or hosted AI service requires an explicit cost review and user authorization.

## Verified baseline

The live account was audited on `2026-08-05` Singapore time through both the Cloudflare API and the signed-in Billing page:

- `Teams Free Base`: active at `$0.00/month`. Its displayed renewal remains `$0.00/month`; it is not a paid trial conversion.
- `Beta Analytics Engine API`: active at `$0.00/month`.
- Four zones used by this project: Cloudflare Free Plan.
- Two Workers: `domain-monetizer-site-edge` and `domain-monetizer-control`.
- One D1 database, approximately `0.4 MB` at audit time.
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

The script reads the existing Cloudflare API credentials, redacts credentials and billing identity, and prints only plan names/prices plus DomainMonetizer's resource inventory. It exits with code `2` if any positive-price account subscription is found. The account is shared, so a failure requires attribution in the Cloudflare Billing page before changing anything.

Run the audit:

1. before publishing domain 21;
2. before enabling Marketcall automation or any new Cloudflare product;
3. before adding a VPS;
4. whenever Cloudflare announces Analytics Engine billing; and
5. monthly while the pilot is active.

Publishing domain 21 also requires redesigning the scheduled readiness monitor, whose current 20-domain cap is an intentional Workers Free safety limit.

## Authorization boundary

Do not enable Workers Paid, Zero Trust pay-as-you-go, R2, Queues, Workflows, Durable Objects, Workers AI, Logpush, Stream, Images, or an external VPS without a concrete capacity need, a projected monthly cost, and user approval. Exceeding a free limit is an availability signal to investigate; it is not permission to upgrade automatically.
