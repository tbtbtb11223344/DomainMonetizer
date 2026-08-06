import { describe, expect, it } from "vitest";
import { publicDomain } from "./api";
import type { DomainRow } from "./types";

function domainRow(overrides: Partial<DomainRow> = {}): DomainRow {
  return {
    id: "dom_test",
    hostname: "example.com",
    lifecycle_status: "published",
    registrar: "Example Registrar",
    source_type: "parking",
    source_status: "available",
    source_labels_json: '["DomainMonetizer"]',
    vertical: "test",
    country: "US",
    locale: "en-US",
    ai_summary: null,
    ai_keywords_json: "[]",
    ai_categories_json: "[]",
    local_evidence_json: "[]",
    traffic_profile_json: "{}",
    cohort_key: "pilot-2026-08-05",
    measurement_started_at: "2026-08-05T00:00:00.000Z",
    traffic_30d_visitors: 1,
    parking_30d_revenue_usd: 0,
    traffic_evidence_at: "2026-08-05T00:00:00.000Z",
    cloudflare_zone_id: "0123456789abcdef0123456789abcdef",
    assigned_nameservers_json: '["mia.ns.cloudflare.com","micah.ns.cloudflare.com"]',
    nameservers_verified_at: "2026-08-05T07:00:00.000Z",
    active_release_id: "rel_test",
    created_at: "2026-08-05T00:00:00.000Z",
    updated_at: "2026-08-05T07:00:00.000Z",
    ...overrides,
  };
}

describe("public domain Cloudflare metadata", () => {
  it("exposes the stored zone assignment and verification time", () => {
    expect(publicDomain(domainRow())).toMatchObject({
      cloudflareZoneId: "0123456789abcdef0123456789abcdef",
      assignedNameservers: ["mia.ns.cloudflare.com", "micah.ns.cloudflare.com"],
      nameserversVerifiedAt: "2026-08-05T07:00:00.000Z",
    });
  });

  it("fails closed to an empty nameserver list when legacy JSON is malformed", () => {
    expect(publicDomain(domainRow({ assigned_nameservers_json: "invalid" }))).toMatchObject({ assignedNameservers: [] });
  });
});
