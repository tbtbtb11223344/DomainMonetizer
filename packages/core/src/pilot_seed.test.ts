import { describe, expect, it } from "vitest";
import seed from "../../../ops/pilot_seed.json" with { type: "json" };
import { contentSchema, domainImportSchema } from ".";

describe("pilot seed", () => {
  it("contains only valid eligible domains and content", () => {
    expect(seed.domains).toHaveLength(3);
    for (const domain of seed.domains) {
      const parsedDomain = domainImportSchema.parse(domain);
      expect(parsedDomain.sourceLabels.map((label) => label.toLowerCase())).not.toContain("traffic2");
      contentSchema.parse(seed.content[domain.hostname as keyof typeof seed.content]);
    }
  });
});
