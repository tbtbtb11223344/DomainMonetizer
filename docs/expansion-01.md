# Expansion 01: ten-domain local-service cohort

This cohort is the next build set after the original three-domain pilot. The source decision is deliberately conservative: every domain is a parking domain marked available, has no `Traffic2` label, has a DomainAnalyzer summary/keyword/category signal, and has at least two sanitized Local Directory evidence rows. The 30-day visitor total is a prioritization baseline, not a claim about future qualified traffic.

## Selected domains

`accentpwp.com`, `americraftsw.com`, `homespirewindows.com`, `sniperpestcontrol.net`, `piedmontfloor.com`, `361treeandlandscape.com`, `a-1garagedoorsportland.com`, `adamsfoundationrepair.com`, `anamechanical.com`, and `marbleshooters.net` are stored in `ops/expansion_seed.json` under cohort key `expansion-01`. The seed keeps renewal-sensitive names out of the first wave and records the observed GiantPanda coverage, non-zero days, median daily visitors, and maximum-day share.

## Safe rollout

1. Apply `migrations/0013_expansion_cohorts.sql` to the control D1 database and deploy the control Worker. Keep the site Worker deployment on the existing pilot routes until the new zones exist.
2. Run `node ops/audit_expansion_state.mjs` against the authenticated control URL. This checks source type/status, labels, cohort membership, AI categories, local evidence, and traffic-profile completeness.
3. Run `node ops/seed_expansion.mjs` to import the ten domains and approved manual content as `ready` drafts. The script does not publish by default.
4. Review the ten previews, confirm the independent-guide disclosure and disabled provider state. Create/read back the ten Cloudflare zones and delegate the exact registrar nameservers; only then add the routes and deploy the site Worker.
5. Run `node ops/seed_expansion.mjs --publish --activate-cohort` at the launch boundary. Activation starts telemetry and exact-session measurement on the next UTC day, avoiding a partial-day baseline.
6. Use the admin cohort selector to review `expansion-01` independently from the original pilot. Keep all offers, routing policies, clicks, conversions, and postbacks at zero during the observation window.

## Review gate

The expansion cohort remains measurement-only until it has the same evidence contract as the pilot: complete daily rollups, the required exact-session and telemetry days, fresh matching readiness checks for every published hostname, reliable scheduled coverage, and zero monetization state. `ops/audit_expansion_state.mjs` is a source/inventory guard; the existing `audit_pilot_state.mjs` remains scoped to the original pilot cohort.
