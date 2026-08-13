import { describe, expect, it } from "vitest";
import seed from "../../../ops/expansion_seed.json" with { type: "json" };
import marketcallScopeContent from "../../../ops/marketcall_scope_content.json" with { type: "json" };
import { compileHomeServicesHtml, contentSchema, domainImportSchema } from ".";

describe("expansion seed", () => {
  it("contains ten eligible local-service domains with source evidence", () => {
    expect(seed.domains).toHaveLength(10);
    expect(seed.cohortKey).toBe("expansion-01");
    const imagePaths = new Set<string>();
    for (const domain of seed.domains) {
      const parsedDomain = domainImportSchema.parse(domain);
      expect(parsedDomain.sourceType).toBe("parking");
      expect(parsedDomain.sourceStatus).toBe("available");
      expect(parsedDomain.sourceLabels.map((label) => label.toLowerCase())).not.toContain("traffic2");
      expect(parsedDomain.localEvidence.length).toBeGreaterThanOrEqual(2);
      expect(parsedDomain.trafficProfile?.coveredDays).toBeGreaterThanOrEqual(10);
      const rawContent = marketcallScopeContent[domain.hostname as keyof typeof marketcallScopeContent]
        ?? seed.content[domain.hostname as keyof typeof seed.content];
      const content = contentSchema.parse(rawContent);
      expect(content.disclosure).toMatch(/^This website is an independent information and referral guide\./);
      expect(content.cta.disabledText).toBeTruthy();
      imagePaths.add(content.image.assetPath);
      const html = compileHomeServicesHtml({ content, hostname: domain.hostname, releaseId: "rel_test", offerEnabled: false });
      expect(html).toContain("Provider matching is not open yet.");
    }
    expect(imagePaths.size).toBeGreaterThanOrEqual(5);
  });
});
