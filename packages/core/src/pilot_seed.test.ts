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
      const content = contentSchema.parse(seed.content[domain.hostname as keyof typeof seed.content]);
      imagePaths.add(content.image.assetPath);
      const compactPath = content.image.assetPath.replace(/\.webp$/, "-960.webp");
      const html = compileHomeServicesHtml({ content, hostname: domain.hostname, releaseId: "rel_test", offerEnabled: false });
      expect(html).toContain(`${compactPath} 960w`);
    }
    expect(imagePaths.size).toBe(3);
  });
});
