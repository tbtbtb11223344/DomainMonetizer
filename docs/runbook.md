# Operations runbook

## Safety invariants

- Never change the apex, MX, DKIM, SPF, or DMARC records of `multibrands.net`.
- Control-plane DNS is limited to `admin.multibrands.net`, `preview.multibrands.net`, and `webhooks.multibrands.net`.
- Portfolio nameserver changes are exact-list operations after preview and rollback verification.
- A pilot domain must be `parking` + `available`, have no `Traffic2` label at action time, and pass a final registrar/API readback immediately before mutation.
- Publish first, validate through an alternate hostname, then change one domain, verify TLS/DNS/HTTP/telemetry, and only then continue the pilot.

## Commands

```powershell
pnpm check
pnpm exec wrangler d1 migrations apply domain-monetizer --local --config apps/control/wrangler.jsonc
pnpm --filter @domain-monetizer/site-edge dev
pnpm --filter @domain-monetizer/control dev
```

Production resource IDs are written into the Worker configs only after Cloudflare creates them. Secrets are installed with `wrangler secret put`; they never enter Git.

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

The committed pilot evidence collector is read-only. Exact verification should be run immediately before a registrar mutation:

```powershell
python ops/collect_pilot_evidence.py `
  --domain-manager-root C:\Users\ttttb\OneDrive\Documents\Projects\DomainManager `
  --domains example.com `
  --parklogic-checks 1
```

`preview.multibrands.net` is a seven-day KV alias of one approved release. It is not a portfolio record and must never be imported into the domains table. Publishing a preview does not change the selected domain's DNS.

## Emergency rollback

1. Pause the affected hostname in the admin API.
2. If the release is the fault, select the last known-good release and invoke rollback.
3. If edge routing is the fault, restore the exact nameservers captured in the DomainManager action record.
4. Confirm authoritative and recursive DNS, TLS, page response, and telemetry after every action.
