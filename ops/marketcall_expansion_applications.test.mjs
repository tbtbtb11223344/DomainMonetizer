import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const applications = JSON.parse(await readFile(new URL("./marketcall_expansion_applications.json", import.meta.url), "utf8"));
const activePilot = JSON.parse(await readFile(new URL("./marketcall_pilot.json", import.meta.url), "utf8"));

const expectedHostnames = [
  "361treeandlandscape.com",
  "a-1garagedoorsportland.com",
  "accentpwp.com",
  "adamsfoundationrepair.com",
  "americraftsw.com",
  "homespirewindows.com",
  "marbleshooters.net",
  "piedmontfloor.com",
  "sniperpestcontrol.net",
];

describe("Marketcall expansion applications", () => {
  it("records every expansion website exactly once", () => {
    const hostnames = applications.campaigns
      .flatMap((campaign) => campaign.materials.map((material) => material.hostname))
      .sort();

    expect(hostnames).toEqual(expectedHostnames);
    expect(new Set(hostnames).size).toBe(hostnames.length);
  });

  it("keeps provider-moderated applications dormant", () => {
    expect(applications.provider).toBe("marketcall");
    expect(applications.activationReady).toBe(false);
    expect(applications.activationBlocker).toBe("provider_campaign_and_material_moderation");

    for (const campaign of applications.campaigns) {
      expect(campaign.campaignState).toBe("moderation");
      expect(campaign.didStatus).toBe("approved");
      expect(campaign.trafficSources).toEqual(["SEO"]);
      expect(campaign.did).toMatch(/^\+1\d{10}$/);
      for (const material of campaign.materials) {
        expect(material.materialState).toBe("manager_moderation");
      }
    }
  });

  it("does not add pending expansion websites to the active pilot contract", () => {
    const activeHostnames = new Set([
      ...activePilot.campaigns.map((campaign) => campaign.hostname),
      ...activePilot.placements.map((placement) => placement.hostname),
    ]);

    for (const hostname of expectedHostnames) expect(activeHostnames.has(hostname)).toBe(false);
  });

  it("uses unique provider and material identifiers", () => {
    const campaignIds = applications.campaigns.map((campaign) => campaign.campaignId);
    const materialIds = applications.campaigns.flatMap((campaign) => campaign.materials.map((material) => material.materialId));

    expect(new Set(campaignIds).size).toBe(campaignIds.length);
    expect(new Set(materialIds).size).toBe(materialIds.length);
  });
});
