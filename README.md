# DomainMonetizer

DomainMonetizer is one multi-tenant Cloudflare application that serves many portfolio domains. Hostnames select immutable, structured releases; domains are not deployed as separate websites.

## Architecture

- `apps/site-edge`: public Worker. Resolves the hostname from KV, renders an immutable release, records privacy-preserving telemetry, and delegates outbound clicks to the control Worker.
- `apps/control`: protected Hono API. Owns D1, publication, rollback, preview aliases, audit records, and the click ledger. Production requests require Cloudflare Access or the independent operator bearer secret.
- `apps/admin`: React/Vite operator interface served by the control Worker.
- `packages/core`: schemas, release compiler, hostname rules, and shared contracts.
- `migrations`: versioned D1 schema.

See [docs/architecture.md](docs/architecture.md) and [docs/runbook.md](docs/runbook.md).

## Local development

Requirements: Node 22+ and pnpm 11+.

```powershell
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

Copy `.env.example` to `.dev.vars` only for local Worker development. Never commit either `.env` or `.dev.vars`.

The first pilot is intentionally traffic-measurement only. Clean telemetry begins on `2026-08-05` UTC; launch checks before that boundary are excluded. The admin reports qualified anonymous sessions, likely-human views, engagement, US share, classification reason, network origin, Analytics Engine sampling, rollup coverage, and fresh end-to-end tenant readiness. Sampling of the distinct-session query, incomplete coverage, or failed readiness blocks scale review; sampling-adjusted quality breakdowns are labeled but do not misclassify exact sessions. Readiness probes use `/readyz` and never create page-view events.

Marketcall remains disabled until campaign moderation, destination routing, and postback attribution are implemented and verified. The traffic gate and the economic monetization gate are separate decisions: traffic evidence can justify a larger pilot, but cannot prove profitability.
