import { describe, expect, it } from "vitest";
import seed from "../../../ops/pilot_seed.json" with { type: "json" };
import { contentSchema, domainImportSchema } from ".";

describe("pilot seed", () => {
  it("contains only valid eligible domains and content", () => {
    expect(seed.domains).toHaveLength(3);
    const imagePaths = new Set<string>();
    for (const domain of seed.domains) {
      const parsedDomain = domainImportSchema.parse(domain);
      expect(parsedDomain.sourceLabels.map((label) => label.toLowerCase())).not.toContain("traffic2");
      const content = contentSchema.parse(seed.content[domain.hostname as keyof typeof seed.content]);
      imagePaths.add(content.image.assetPath);
    }
    expect(imagePaths.size).toBe(3);
  });
});
