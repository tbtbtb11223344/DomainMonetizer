import { describe, expect, it } from "vitest";
import { canonicalHostname, compileHomeServicesHtml, contentSchema, escapeHtml } from ".";

const content = contentSchema.parse({
  schemaVersion: 1,
  locale: "en-US",
  brandName: "Tulsa Appliance Guide",
  vertical: "appliance repair",
  location: { city: "Tulsa", region: "OK", country: "US" },
  seo: { title: "Appliance repair guide in Tulsa", description: "Learn how to compare appliance repair providers in Tulsa, Oklahoma." },
  hero: { eyebrow: "A practical local guide", title: "Find the right appliance repair option", summary: "Compare providers, understand useful questions, and make a more informed choice." },
  servicesHeading: "A clearer way to compare repair providers",
  services: [
    { title: "Check experience", description: "Ask whether the provider regularly handles your appliance type and brand." },
    { title: "Confirm the estimate", description: "Understand diagnostic charges, parts, labor, and warranty terms before work starts." },
  ],
  guide: { heading: "Questions worth asking", paragraphs: ["Describe the symptom and ask what diagnostic process the provider uses.", "Confirm availability, pricing structure, licensing requirements, and workmanship guarantees."] },
  faqHeading: "Appliance repair questions",
  faqs: [
    { question: "Should I repair or replace?", answer: "Age, repair cost, efficiency, and parts availability all matter." },
    { question: "What should an estimate include?", answer: "Look for diagnostic fees, labor, parts, taxes, and warranty information." },
  ],
  cta: { label: "Compare local options", supportingText: "Availability and eligibility vary by location.", disabledText: "Matching is still being set up in Tulsa.", slot: "primary" },
  disclosure: "This is an independent referral website and is not the former business that may have used this domain. We may receive compensation when you contact a provider.",
  image: { assetPath: "/__dm/assets/home-services-hero.webp", alt: "A technician checking a home appliance" },
});

describe("core contracts", () => {
  it("canonicalizes safe hostnames", () => {
    expect(canonicalHostname("WWW.Example.COM:443")).toBe("example.com");
    expect(() => canonicalHostname("bad host")) .toThrow();
  });

  it("escapes untrusted content", () => {
    expect(escapeHtml('<img src=x onerror="x">')).toBe("&lt;img src=x onerror=&quot;x&quot;&gt;");
  });

  it("compiles a disclosure-forward page without arbitrary inline scripts", () => {
    const html = compileHomeServicesHtml({ content, hostname: "example.com", releaseId: "rel_1", offerEnabled: true });
    expect(html).toContain("independent referral website");
    expect(html).toContain("Tulsa Appliance Guide");
    expect(html).toContain('data-offer="enabled"');
    expect(html).toContain('class="mobile-action"');
    expect(html).toContain('href="/go/primary"');
    expect(html).toContain('href="/__dm/site-v2.css"');
    expect(html).toContain('href="/__dm/assets/site-mark.svg"');
    expect(html).toContain('srcset="/__dm/assets/home-services-hero-960.webp 960w, /__dm/assets/home-services-hero.webp 1122w"');
    expect(html).toContain('src="/__dm/site-v2.js"');
    expect(html).not.toContain("<script>");
  });

  it("renders an honest non-interactive status when matching is disabled", () => {
    const html = compileHomeServicesHtml({ content, hostname: "example.com", releaseId: "rel_2", offerEnabled: false });
    expect(html).toContain('data-offer="disabled"');
    expect(html).toContain("Matching is still being set up in Tulsa.");
    expect(html).not.toContain('class="mobile-action"');
    expect(html).not.toContain('class="mast-cta"');
    expect(html).not.toContain('href="/go/primary"');
  });
});
