# Implementation and scale-gate status

This ledger maps the approved DomainMonetizer architecture to authoritative evidence. It separates implementation completeness from the natural-traffic and economic decisions that software tests cannot prove.

## Current operating state

- Pilot allowlist: `mcneillsappliance.com`, `heavenlyaircondition.com`, and `phoenixroofcoating.net`.
- Mode: natural-traffic measurement only; no active offer, routing policy, outbound affiliate action, click ledger entry, postback, or conversion.
- Clean evidence boundary: `2026-08-05 UTC`.
- Decision window: at least 14 complete clean UTC days and at least 10 exact qualified anonymous sessions across the pilot.
- Runtime: two Cloudflare Workers, one D1 database, one KV namespace, and Analytics Engine; no VPS, Queue, R2, Workflow, Durable Object, or paid Cloudflare subscription.
- Expansion authority: none. `review_scale_candidate` requests human review; it never publishes another domain.

## Requirement ledger

| Requirement | Current state | Authoritative evidence | Before a larger pilot |
| --- | --- | --- | --- |
| One hostname-routed multi-tenant application | Implemented and live | `site-edge` resolves immutable KV snapshots by canonical hostname; every pilot `/readyz` returns its exact active release | Keep this model |
| Fail-closed public runtime | Implemented and live | Missing, paused, malformed, scanner, and sensitive paths are covered by edge tests and deterministic HEAD/readiness checks | Keep this invariant |
| Central control database | Implemented and migrated | D1 migrations, domain/content/release/deployment/audit tables, and remote migration readback | Add bounded version retention before high-volume publishing |
| Immutable publish and rollback | Implemented and live | D1 release snapshots, KV active pointers, compensating publication tests, admin publish/pause/rollback controls | Preserve active and rollback releases during retention design |
| Neutral structured content | Implemented for the pilot | Shared schema, escaped deterministic renderer, neutral guide identity, approved content versions, and visually verified pilot releases | Generate only schema-constrained drafts; no raw AI HTML |
| Automated content assistance | Implemented but intentionally operator-gated | Constrained local Codex runner, independent runner secret, JSON Schema output, draft-only submission | Batch only after candidate verticals are justified; keep preview/approval |
| Protected administration | Implemented and live | Cloudflare Access JWT validation, exact operator email, independent service/operator secrets, same-origin mutation checks, audit log | Preserve credential isolation |
| Natural-traffic telemetry | Implemented and collecting | Privacy-safe edge events, bot/unknown/human classification, qualified hashed sessions, country/source/intent/state/time rollups | Interpret only completed, exact, unsampled days |
| Tenant health and telemetry canaries | Implemented and live | Four daily exact-release checks, signed distinct canaries, same-day grace-aware reconciliation, completed-day reconciliation | Replace the 20-domain bounded checker before domain 21 |
| Deterministic decision handoff | Implemented | `pnpm audit:pilot` emits `continue_collecting`, `repair_pilot`, `do_not_scale`, or `review_scale_candidate` and fails closed on contract drift | Human review remains mandatory |
| Source eligibility | Implemented for the exact pilot | `pnpm audit:sources` re-reads Domain Manager and DomainAnalyzer for parking + available + no Traffic2, expected US/vertical classification, and risk flags | Re-run candidate selection and exact pre-mutation readback for every approved batch |
| Cost containment | Implemented for the pilot | `pnpm audit:cloudflare-costs` proves zero positive-price subscriptions, exact resources/bindings/hostnames, and D1 below 50 MiB | Obtain user approval for any paid product or VPS |
| Control-data recovery | Sufficient for pilot | D1 Time Travel bookmark readback and seven-day Free retention; destructive restore requires explicit approval | Select, cost, and restore-test encrypted longer-retention backup storage |
| Thousands-domain routing | Designed, not activated | Current full-zone topology and documented 1,000-routed-zone Worker ceiling | Before 900 routes, canary Cloudflare for SaaS or approve deterministic Worker shards |
| Marketcall monetization | Deliberately deferred by user | Offer/routing/click/postback/conversion schema exists; all live counts are required to remain zero | Moderate the exact campaign, implement provider-specific routing/postbacks, then prove settled revenue |
| Profitability | Unknown and not inferable yet | No monetization is active; traffic evidence is not payout evidence | Evaluate accepted revenue per valid session only after Marketcall is implemented and conversions settle |

## Repeatable evidence commands

Run from the repository root:

```powershell
pnpm check
pnpm audit:pilot
pnpm audit:sources
pnpm audit:cloudflare-costs
```

`pnpm audit:pilot` is the primary operational and decision contract. It does not request tenant HTML or create visitor views. `audit:sources` and `audit:cloudflare-costs` are independent read-only guards; a passing pilot audit does not replace either one.

## When user attention is required

The unattended monitor should remain quiet while the result is a healthy `continue_collecting`. It should request attention only when:

1. an operational/source/cost guard fails and cannot be safely repaired in scope;
2. the complete evidence window reaches `do_not_scale`; or
3. the complete evidence window reaches `review_scale_candidate` and per-domain traffic quality has been inspected.

At that review, the recommendation must distinguish:

- whether these domains receive real likely-human traffic;
- whether it is predominantly eligible US traffic;
- whether network, entry-intent, state, local-time, and engagement evidence fit the selected services;
- whether any result is sampled or the telemetry pipeline is unverified;
- which individual domains or verticals, if any, justify a larger measurement pilot; and
- that traffic quality alone does not authorize Marketcall, paid infrastructure, or a claim of profitability.

## Deliberately deferred work

Do not implement these merely to make the system look more complete during the traffic experiment:

- Marketcall API integration, numbers, CTAs, postbacks, or offer optimization;
- paid Cloudflare products, Cloudflare for SaaS, Worker shards, or a VPS;
- bulk registrar/nameserver mutations or publishing additional domains;
- a Queue/Workflow automation plane;
- indexable SEO pages, cross-domain linking, or cached tenant HTML;
- AI auto-approval or auto-publication;
- experimental allocation or bandit optimization without conversion volume.

These are post-evidence decisions, not missing pilot functionality.
