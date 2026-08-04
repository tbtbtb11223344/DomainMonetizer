export const expectedProjectContract = Object.freeze({
  workers: ["domain-monetizer-control", "domain-monetizer-site-edge"],
  schedules: {
    "domain-monetizer-control": ["17 4 * * *", "47 */6 * * *"],
    "domain-monetizer-site-edge": [],
  },
  d1Databases: ["domain-monetizer"],
  kvNamespaces: ["domain-monetizer-site-config"],
  accessApps: [{ name: "DomainMonetizer Admin", domain: "admin.multibrands.net", type: "self_hosted" }],
});

const forbiddenBindingTypes = new Set([
  "ai",
  "browser",
  "dispatch_namespace",
  "durable_object_namespace",
  "hyperdrive",
  "images",
  "logfwdr",
  "mtls_certificate",
  "queue",
  "r2_bucket",
  "send_email",
  "vectorize",
  "version_metadata",
  "workflow",
]);

function sorted(values) {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function sameStrings(actual, expected) {
  const left = sorted(actual);
  const right = sorted(expected);
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function appKey(app) {
  return `${app.name}|${app.domain}|${app.type}`;
}

export function evaluateProjectContract(inventory) {
  const issues = [];
  if (inventory.billableSubscriptions.length) {
    issues.push(`${inventory.billableSubscriptions.length} positive-price Cloudflare subscription(s) detected`);
  }
  if (inventory.warnings.length) {
    issues.push(`Cloudflare inventory is incomplete: ${inventory.warnings.join("; ")}`);
  }
  if (!sameStrings(inventory.workers, expectedProjectContract.workers)) {
    issues.push(`Project Workers differ from the pilot contract (expected ${expectedProjectContract.workers.join(", ")}; observed ${sorted(inventory.workers).join(", ") || "none"})`);
  }
  for (const worker of expectedProjectContract.workers) {
    const actual = inventory.schedules[worker] ?? [];
    const expected = expectedProjectContract.schedules[worker];
    if (!sameStrings(actual, expected)) {
      issues.push(`${worker} schedules differ from the pilot contract (expected ${expected.join(", ") || "none"}; observed ${sorted(actual).join(", ") || "none"})`);
    }
  }
  if (!sameStrings(inventory.d1Databases, expectedProjectContract.d1Databases)) {
    issues.push(`Project D1 databases differ from the pilot contract (observed ${sorted(inventory.d1Databases).join(", ") || "none"})`);
  }
  if (!sameStrings(inventory.kvNamespaces, expectedProjectContract.kvNamespaces)) {
    issues.push(`Project KV namespaces differ from the pilot contract (observed ${sorted(inventory.kvNamespaces).join(", ") || "none"})`);
  }
  if (inventory.queues.length) {
    issues.push(`Unexpected project Queues detected: ${sorted(inventory.queues).join(", ")}`);
  }
  const actualApps = inventory.accessApps.map(appKey);
  const expectedApps = expectedProjectContract.accessApps.map(appKey);
  if (!sameStrings(actualApps, expectedApps)) {
    issues.push(`DomainMonetizer Access apps differ from the pilot contract (observed ${sorted(actualApps).join(", ") || "none"})`);
  }
  const forbiddenBindings = inventory.workerBindings.flatMap((worker) => worker.bindings
    .filter((binding) => forbiddenBindingTypes.has(binding.type))
    .map((binding) => `${worker.worker}:${binding.name}:${binding.type}`));
  if (forbiddenBindings.length) {
    issues.push(`Unexpected paid or out-of-scope Worker bindings detected: ${sorted(forbiddenBindings).join(", ")}`);
  }
  return issues;
}
