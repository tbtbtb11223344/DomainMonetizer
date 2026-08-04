import { hostnameSchema } from "./schemas";

export function canonicalHostname(value: string): string {
  const withoutPort = value.trim().toLowerCase().replace(/\.$/, "").split(":", 1)[0] ?? "";
  return hostnameSchema.parse(withoutPort.startsWith("www.") ? withoutPort.slice(4) : withoutPort);
}

export function activePointerKey(hostname: string): string {
  return `site:${canonicalHostname(hostname)}:active`;
}

export function releaseKey(releaseId: string): string {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(releaseId)) throw new Error("Invalid release ID");
  return `release:${releaseId}`;
}
