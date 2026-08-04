import type { DomainContent, ReleaseSnapshot } from "./schemas";

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function locationLabel(content: DomainContent): string {
  return [content.location.city, content.location.region].filter(Boolean).join(", ");
}

function photoCredit(assetPath: string): { label: string; href: string } | null {
  const credits: Record<string, { label: string; href: string }> = {
    "/__dm/assets/appliance-repair.webp": {
      label: "Bulat843 / Pexels",
      href: "https://www.pexels.com/photo/repair-technician-working-on-appliance-38190070/",
    },
    "/__dm/assets/hvac-service.webp": {
      label: "Jose Andres Pacheco Cortes / Pexels",
      href: "https://www.pexels.com/photo/man-checking-an-air-conditioner-5463575/",
    },
    "/__dm/assets/roof-coating.webp": {
      label: "Roof Repair Today / Wikimedia Commons (CC BY-SA 4.0)",
      href: "https://commons.wikimedia.org/wiki/File:Foam_Roof_Restoration.jpg",
    },
  };
  return credits[assetPath] ?? null;
}

export function compileHomeServicesHtml(input: {
  content: DomainContent;
  hostname: string;
  releaseId: string;
  offerEnabled: boolean;
}): string {
  const { content, hostname, releaseId, offerEnabled } = input;
  const e = escapeHtml;
  const place = locationLabel(content);
  const credit = photoCredit(content.image.assetPath);
  const serviceItems = content.services
    .map(
      (service, index) => `<li class="service"><span class="service-number">${index + 1}</span><div><h3>${e(service.title)}</h3><p>${e(service.description)}</p></div></li>`,
    )
    .join("");
  const guide = content.guide.paragraphs.map((paragraph) => `<p>${e(paragraph)}</p>`).join("");
  const faqs = content.faqs
    .map((faq) => `<details><summary>${e(faq.question)}<span aria-hidden="true"></span></summary><p>${e(faq.answer)}</p></details>`)
    .join("");
  const action = offerEnabled
    ? `<div class="action"><a class="cta" href="/go/${e(content.cta.slot)}" rel="nofollow sponsored">${e(content.cta.label)} <span aria-hidden="true">&rarr;</span></a><p>${e(content.cta.supportingText)}</p></div>`
    : `<div class="matching-status" role="status"><span class="status-dot" aria-hidden="true"></span><div><strong>Provider matching is not live yet</strong><span>${e(content.cta.supportingText)}</span></div></div>`;
  const creditHtml = credit
    ? `<span class="photo-credit">Photo: <a href="${e(credit.href)}" target="_blank" rel="noopener noreferrer">${e(credit.label)}</a></span>`
    : "";
  const locationText = place ? e(place) : "United States";

  return `<!doctype html>
<html lang="en-US"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${e(content.seo.title)}</title><meta name="description" content="${e(content.seo.description)}">
<link rel="canonical" href="https://${e(hostname)}/"><link rel="stylesheet" href="/__dm/site.css">
</head><body data-release="${e(releaseId)}">
<header class="mast"><div class="mast-inner"><a href="/" class="brand" aria-label="${e(hostname)} home">${e(hostname)}</a><span class="guide-label">Independent ${e(content.vertical.toLowerCase())} guide</span></div></header>
<main>
<section class="hero"><div class="hero-inner"><div class="hero-copy"><p class="eyebrow">${e(content.hero.eyebrow)}</p><h1>${e(content.hero.title)}</h1><p class="lede">${e(content.hero.summary)}</p>${action}</div><figure class="hero-media"><img src="${e(content.image.assetPath)}" alt="${e(content.image.alt)}" width="1200" height="900"><figcaption><span>${e(content.vertical)} information for ${locationText}</span>${creditHtml}</figcaption></figure></div></section>
<section class="services section" data-reveal><div class="section-intro"><p class="eyebrow">Before you call</p><h2>${e(content.servicesHeading)}</h2></div><ol>${serviceItems}</ol></section>
<section class="guide" data-reveal><div class="guide-inner"><div class="guide-heading"><p class="eyebrow">What to have ready</p><h2>${e(content.guide.heading)}</h2></div><div class="prose">${guide}</div></div></section>
<section class="faq section" data-reveal><div class="section-intro"><p class="eyebrow">Common questions</p><h2>${e(content.faqHeading)}</h2></div><div class="faq-list">${faqs}</div></section>
<section class="final" data-reveal><div><p class="eyebrow">Coverage status</p><h2>${offerEnabled ? "Ready to compare local options?" : `Matching is still being set up for ${locationText}.`}</h2></div>${action}</section>
</main>
<footer><p>${e(content.disclosure)}</p><p>&copy; ${new Date().getUTCFullYear()} ${e(hostname)}</p></footer>
<script src="/__dm/site.js" defer></script></body></html>`;
}

export function pausedHtml(hostname: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Temporarily unavailable</title><link rel="stylesheet" href="/__dm/site.css"></head><body class="system-page"><main><h1>Temporarily unavailable</h1><p>${escapeHtml(hostname)} is being updated. Please check back soon.</p></main></body></html>`;
}

export function publicSnapshot(snapshot: ReleaseSnapshot): Omit<ReleaseSnapshot, "content"> {
  const { content: _content, ...rest } = snapshot;
  return rest;
}
