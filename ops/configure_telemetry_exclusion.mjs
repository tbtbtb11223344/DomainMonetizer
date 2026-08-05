import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const siteEdgeRoot = fileURLToPath(new URL("../apps/site-edge/", import.meta.url));
const wranglerBin = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));
const argumentsSet = new Set(process.argv.slice(2).filter((argument) => argument !== "--"));
const configureOnly = argumentsSet.has("--configure-only");
const verifyOnly = argumentsSet.has("--verify-only");

if (configureOnly && verifyOnly) throw new Error("Choose either --configure-only or --verify-only");
for (const argument of argumentsSet) {
  if (argument !== "--configure-only" && argument !== "--verify-only") throw new Error(`Unknown argument: ${argument}`);
}

function parseEnv(source) {
  const values = {};
  for (const rawLine of source.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const separator = line.indexOf("=");
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

async function repositoryEnvironment() {
  let fileValues = {};
  try {
    fileValues = parseEnv(await readFile(new URL("../.env", import.meta.url), "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return { ...fileValues, ...process.env };
}

async function discoverAddress(url) {
  const response = await fetch(url, {
    headers: { "User-Agent": "DomainMonetizer-telemetry-exclusion/1.0" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Address discovery failed (${response.status})`);
  const match = (await response.text()).match(/^ip=(.+)$/mu);
  const address = match?.[1]?.trim().toLowerCase();
  if (!address || !isIP(address)) throw new Error("Address discovery returned an invalid response");
  return address;
}

async function discoverPublicAddresses() {
  const results = await Promise.allSettled([
    discoverAddress("https://1.1.1.1/cdn-cgi/trace"),
    discoverAddress("https://[2606:4700:4700::1111]/cdn-cgi/trace"),
  ]);
  const addresses = [...new Set(results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []))];
  if (!addresses.length) throw new Error("Could not discover a public IPv4 or IPv6 address through Cloudflare");
  return addresses;
}

function exclusionSecret(addresses) {
  const salt = randomBytes(32).toString("hex");
  const hashes = addresses.map((address) => createHash("sha256").update(`${salt}:${address}`).digest("hex"));
  return `v1:${salt}:${hashes.join(",")}`;
}

async function installSecret(secret) {
  const environment = await repositoryEnvironment();
  const result = spawnSync(process.execPath, [wranglerBin, "secret", "put", "TELEMETRY_EXCLUSION_SECRET"], {
    cwd: siteEdgeRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      ...(environment.CLOUDFLARE_ACCOUNT_ID ? { CLOUDFLARE_ACCOUNT_ID: environment.CLOUDFLARE_ACCOUNT_ID } : {}),
      ...(environment.CLOUDFLARE_API_TOKEN ? { CLOUDFLARE_API_TOKEN: environment.CLOUDFLARE_API_TOKEN } : {}),
    },
    input: `${secret}\n`,
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "Wrangler exited without an error message").trim();
    throw new Error(`Could not install the telemetry exclusion secret: ${detail}`);
  }
}

async function pilotHostnames() {
  const seed = JSON.parse(await readFile(new URL("./pilot_seed.json", import.meta.url), "utf8"));
  const hostnames = seed.domains?.map((domain) => domain.hostname).filter(Boolean) ?? [];
  if (!hostnames.length) throw new Error("The pilot seed does not contain any hostnames");
  return hostnames;
}

async function verifyHost(hostname) {
  const response = await fetch(`https://${hostname}/`, {
    method: "HEAD",
    redirect: "manual",
    headers: { "User-Agent": "DomainMonetizer-telemetry-exclusion-verifier/1.0" },
    signal: AbortSignal.timeout(10_000),
  });
  return response.ok && response.headers.get("X-DM-Telemetry") === "excluded";
}

async function verifyExclusion() {
  const hostnames = await pilotHostnames();
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    const results = await Promise.all(hostnames.map(async (hostname) => ({ hostname, excluded: await verifyHost(hostname) })));
    const missing = results.filter((result) => !result.excluded);
    if (!missing.length) return hostnames.length;
    if (attempt === 6) throw new Error(`Telemetry exclusion was not confirmed for: ${missing.map((result) => result.hostname).join(", ")}`);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error("Telemetry exclusion verification did not complete");
}

if (!verifyOnly) {
  const addresses = await discoverPublicAddresses();
  await installSecret(exclusionSecret(addresses));
  process.stdout.write(`Installed salted exclusion hashes for ${addresses.length} current public address family${addresses.length === 1 ? "" : "ies"}.\n`);
}

if (!configureOnly) {
  const verified = await verifyExclusion();
  process.stdout.write(`Verified telemetry exclusion on ${verified} pilot domains with HEAD requests.\n`);
}
