import { describe, expect, it } from "vitest";
import seed from "../../../ops/pilot_seed.json" with { type: "json" };
import { compileHomeServicesHtml, contentSchema, domainImportSchema } from ".";

describe("pilot seed", () => {
  it("contains only valid eligible domains and content", () => {
    expect(seed.domains).toHaveLength(3);
    const imagePaths = new Set<string>();
    for (const domain of seed.domains) {
      const parsedDomain = domainImportSchema.parse(domain);
      expect(parsedDomain.sourceLabels.map((label) => label.toLowerCase())).not.toContain("traffic2");
      expect(parsedDomain.sourceLabels).toContain("DomainMonetizer");
      expect(parsedDomain.cloudflareZoneId).toMatch(/^[a-f0-9]{32}$/);
      expect(parsedDomain.assignedNameservers).toEqual(["mia.ns.cloudflare.com", "micah.ns.cloudflare.com"]);
      const rawContent = seed.content[domain.hostname as keyof typeof seed.content];
      expect(rawContent).not.toHaveProperty("brandName");
      const content = contentSchema.parse(rawContent);
      imagePaths.add(content.image.assetPath);
      const compactPath = content.image.assetPath.replace(/\.webp$/, "-960.webp");
      const html = compileHomeServicesHtml({ content, hostname: domain.hostname, releaseId: "rel_test", offerEnabled: false });
      expect(html).toContain(`${compactPath} 960w`);
      expect(html).toContain(content.location.city);
      expect(html).toContain("Guide");
      expect(content.disclosure).toMatch(/^This website is an independent information and referral guide\./);
    }
    expect(imagePaths.size).toBe(3);
  });

  it("requires Cloudflare zone IDs and assigned nameservers together", () => {
    const domain = seed.domains[0]!;
    const { assignedNameservers: _assignedNameservers, ...missingNameservers } = domain;
    const { cloudflareZoneId: _cloudflareZoneId, ...missingZoneId } = domain;
    expect(domainImportSchema.safeParse(missingNameservers).success).toBe(false);
    expect(domainImportSchema.safeParse(missingZoneId).success).toBe(false);
  });
});
