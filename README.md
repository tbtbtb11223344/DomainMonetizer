# DomainMonetizer

DomainMonetizer is one multi-tenant Cloudflare application that serves many portfolio domains. Hostnames select immutable, structured releases; domains are not deployed as separate websites.

## Architecture

- `apps/site-edge`: public Worker. Resolves the hostname from KV, renders an immutable release, records privacy-preserving telemetry, and delegates outbound clicks to the control Worker.
- `apps/control`: protected Hono API. Owns D1, publication, rollback, preview aliases, audit records, and the click ledger. Production requests require Cloudflare Access or the independent operator bearer secret.
- `apps/admin`: React/Vite operator interface served by the control Worker.
- `packages/core`: schemas, release compiler, hostname rules, and shared contracts.
- `migrations`: versioned D1 schema.

See [docs/architecture.md](docs/architecture.md), [docs/runbook.md](docs/runbook.md), [docs/cost-controls.md](docs/cost-controls.md), and the requirement-by-requirement [implementation and scale-gate ledger](docs/implementation-status.md).

## Local development

Requirements: Node 22+ and pnpm 11+.

```powershell
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

Copy `.env.example` to `.dev.vars` only for local Worker development. Never commit either `.env` or `.dev.vars`.

The first pilot is intentionally traffic-measurement only. Clean telemetry begins on `2026-08-05` UTC; launch checks before that boundary are excluded. Exact qualified-visitor evidence uses a server-signed daily browser marker beginning with the first full UTC day configured by `EXACT_SESSION_MIN_DATE`, so one qualified browser emits one minimal session point per hostname and UTC day. That stream is indexed by domain, matching its rollup query and avoiding the sampled high-cardinality browser index used by the superseded v2 stream. The admin makes U.S. qualified human uniques and their percentage of all qualified human uniques the primary audience KPI. It reports the KPI as unavailable—not zero—until the first exact day completes. It also reports likely-human views, engagement, classification reason, network origin, privacy-safe entry-intent classes, coarse US state and local-time context, Analytics Engine sampling, rollup coverage, telemetry-canary reconciliation, current end-to-end readiness, and scheduled reliability. Safe legacy paths render the same canonical `noindex` guide while sensitive scanner paths fail closed; raw paths, query strings, referrer URLs, city, ZIP, coordinates, exact local hour, raw timezone, and raw IP addresses are never stored. A day counts toward review only when its exact-visitor query is unsampled and its trusted canaries verify; bad days remain visible and delay rather than permanently poison the window. Incomplete coverage, failed readiness, or less than 95% per-domain health coverage/readiness still blocks scale review. Readiness probes use `/readyz`; authenticated probes create only excluded health canaries, never page-view events.

Marketcall remains disabled until campaign moderation, destination routing, and postback attribution are implemented and verified. The traffic gate and the economic monetization gate are separate decisions: traffic evidence can justify a larger pilot, but cannot prove profitability.
