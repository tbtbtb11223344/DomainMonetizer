import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const seed = JSON.parse(await readFile(new URL("./expansion_seed.json", import.meta.url), "utf8"));
const managerRoot = process.env.DOMAIN_MANAGER_ROOT || new URL("../../DomainManager", import.meta.url).pathname.replace(/^\/(\w):/u, "$1:").replaceAll("/", "\\");
const domains = seed.domains.map((domain) => domain.hostname);
const { stdout } = await execFileAsync(process.env.PYTHON || "python", ["ops/collect_pilot_evidence.py", "--domain-manager-root", managerRoot, "--domains", ...domains, "--parklogic-checks", "0"], { cwd: new URL("..", import.meta.url), maxBuffer: 12 * 1024 * 1024 });
const report = JSON.parse(stdout);
const byHostname = new Map((report.scored_candidates ?? []).map((row) => [row.domain, row]));
const issues = [];
const classificationDrift = [];
for (const expected of seed.domains) {
  const actual = byHostname.get(expected.hostname);
  if (!actual) { issues.push(`${expected.hostname}: missing from live source evidence`); continue; }
  if (actual.vertical !== expected.vertical && !expected.vertical.includes(actual.vertical ?? "")) classificationDrift.push(`${expected.hostname}: collector rule classified as ${actual.vertical ?? "unclassified"}; retain the AI summary and Local Directory evidence for operator review`);
  if (actual.country_signal !== expected.country) issues.push(`${expected.hostname}: country signal drift (${actual.country_signal ?? "missing"})`);
  if ((actual.labels ?? []).some((label) => String(label).toLowerCase() === "traffic2")) issues.push(`${expected.hostname}: Traffic2 label is present`);
  if ((actual.risk_flags ?? []).length) issues.push(`${expected.hostname}: risk flags ${actual.risk_flags.join(", ")}`);
}
const output = { auditedAt: new Date().toISOString(), guard: issues.length ? "FAIL" : "PASS", source: "live Domain Manager and DomainAnalyzer databases", cohort: seed.cohortKey, domains: domains.sort(), classificationDrift, issues };
console.log(JSON.stringify(output, null, 2));
if (issues.length) process.exitCode = 1;
