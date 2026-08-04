import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { compileHomeServicesHtml } from "../packages/core/src/html.ts";

const seed = JSON.parse(await readFile(new URL("./pilot_seed.json", import.meta.url), "utf8"));
const assets = new URL("../apps/site-edge/public/__dm/", import.meta.url);
const output = new URL("../output/playwright/local-preview/", import.meta.url);

for (const offerEnabled of [false, true]) {
  const state = offerEnabled ? "enabled" : "disabled";
  for (const domain of seed.domains) {
    const hostname = domain.hostname;
    const target = new URL(`./${state}/${hostname}/`, output);
    await mkdir(target, { recursive: true });
    await cp(assets, new URL("./__dm/", target), { recursive: true, force: true });
    const html = compileHomeServicesHtml({
      content: seed.content[hostname],
      hostname,
      releaseId: `preview_${state}`,
      offerEnabled,
    }).replaceAll("/__dm/", "./__dm/");
    await writeFile(new URL("./index.html", target), html, "utf8");
  }
}

console.log(`Rendered disabled and enabled pilot previews to ${output.pathname}`);
