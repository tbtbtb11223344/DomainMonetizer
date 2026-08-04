import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluatePilotSources } from "./pilot_source_contract.mjs";

const opsDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(opsDirectory, "..");
const domainManagerRoot = resolve(process.env.DOMAIN_MANAGER_ROOT || resolve(repositoryRoot, "..", "DomainManager"));
const seed = JSON.parse(await readFile(new URL("./pilot_seed.json", import.meta.url), "utf8"));
const expectedDomains = seed.domains;
const python = process.env.PYTHON || "python";
const result = spawnSync(python, [
  resolve(opsDirectory, "collect_pilot_evidence.py"),
  "--domain-manager-root", domainManagerRoot,
  "--domains", ...expectedDomains.map((domain) => domain.hostname),
  "--limit", String(expectedDomains.length),
  "--parklogic-checks", "0",
], {
  cwd: repositoryRoot,
  encoding: "utf8",
  maxBuffer: 10 * 1024 * 1024,
  windowsHide: true,
});

if (result.error) throw result.error;
if (result.status !== 0) {
  throw new Error(`Pilot source collector failed (${result.status}): ${(result.stderr || "no diagnostic").trim().slice(0, 500)}`);
}

const collected = JSON.parse(result.stdout);
const candidates = new Map((collected.scored_candidates ?? []).map((candidate) => [candidate.domain, candidate]));
const issues = evaluatePilotSources(expectedDomains, collected);
const report = {
  auditedAt: new Date().toISOString(),
  guard: issues.length ? "FAIL" : "PASS",
  source: "live Domain Manager and DomainAnalyzer databases",
  domains: expectedDomains.map((expected) => {
    const candidate = candidates.get(expected.hostname);
    return {
      hostname: expected.hostname,
      sourceEligible: Boolean(candidate),
      vertical: candidate?.vertical ?? null,
      countrySignal: candidate?.country_signal ?? null,
      labels: candidate?.labels ?? [],
      riskFlags: candidate?.risk_flags ?? [],
      cachedVisitors30d: candidate?.visitors_30d ?? null,
      evidenceUpdatedAt: candidate?.parking_updated_at ?? null,
    };
  }),
  issues,
  notes: [
    "This audit is read-only and makes no registrar, DNS, provider, or DomainMonetizer mutation.",
    "ParkLogic is intentionally skipped here; clean Cloudflare telemetry is the scale-decision source after cutover.",
  ],
};

console.log(JSON.stringify(report, null, 2));
if (issues.length) process.exitCode = 2;
