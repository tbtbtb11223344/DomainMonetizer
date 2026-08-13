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

The first pilot began as traffic-measurement only and now runs a guarded economic pilot while evidence collection continues. Clean telemetry begins on `2026-08-05` UTC; launch checks before that boundary are excluded. Exact qualified-visitor evidence uses a server-signed daily browser marker beginning with the first full UTC day configured by `EXACT_SESSION_MIN_DATE`, so one qualified browser emits one minimal session point per hostname and UTC day. That stream uses a dedicated low-volume per-domain index, matching its rollup query while isolating qualified sessions from both the sampled high-cardinality browser index used by the superseded v2 stream and each tenant's noisy view index. The admin makes U.S. qualified human uniques and their percentage of all qualified human uniques the primary audience KPI. Until the first exact day completes, it shows the latest historical sampled counts with an approximation marker and date instead of hiding them or presenting them as exact. It also reports likely-human views, engagement, classification reason, network origin, privacy-safe entry-intent classes, coarse US state and local-time context, Analytics Engine sampling, rollup coverage, telemetry-canary reconciliation, current end-to-end readiness, and scheduled reliability. Safe legacy paths render the same canonical `noindex` guide while sensitive scanner paths fail closed; raw paths, query strings, referrer URLs, city, ZIP, coordinates, exact local hour, raw timezone, and raw IP addresses are never stored. A day counts toward review only when its exact-visitor query is unsampled and its trusted canaries verify; bad days remain visible and delay rather than permanently poison the window. Incomplete coverage, failed readiness, or less than 95% per-domain health coverage/readiness still blocks scale review. Readiness probes use `/readyz`; authenticated probes create only excluded health canaries, never page-view events.

The Marketcall economic pilot is active for appliance repair, HVAC, and replacement-qualified roofing. Three approved SEO campaigns power four exact website placements: each original pilot domain uses its dedicated DID, while `anamechanical.com` shares the approved HVAC DID after provider confirmation that reuse is permitted. Phone destinations are returned only after a tracked `/go/primary` handoff and never appear in tenant HTML. CTA handoffs remain internal diagnostics; user-facing call totals come only from Marketcall postbacks and are separated into pending, qualified, and unsuccessful outcomes. Provider postbacks use a secret-path webhook and retain only approved economic fields. Because a static shared DID carries no website identifier, HVAC conversions without an exact DomainMonetizer click ID remain deliberately unattributed instead of being assigned to the wrong domain.
