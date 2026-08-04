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

export function compileHomeServicesHtml(input: {
  content: DomainContent;
  hostname: string;
  releaseId: string;
  offerEnabled: boolean;
}): string {
  const { content, hostname, releaseId, offerEnabled } = input;
  const e = escapeHtml;
  const place = locationLabel(content);
  const serviceItems = content.services
    .map(
      (service, index) => `<li class="service"><span>0${index + 1}</span><div><h3>${e(service.title)}</h3><p>${e(service.description)}</p></div></li>`,
    )
    .join("");
  const guide = content.guide.paragraphs.map((paragraph) => `<p>${e(paragraph)}</p>`).join("");
  const faqs = content.faqs
    .map((faq) => `<details><summary>${e(faq.question)}</summary><p>${e(faq.answer)}</p></details>`)
    .join("");
  const cta = offerEnabled
    ? `<a class="cta" href="/go/${e(content.cta.slot)}" rel="nofollow sponsored">${e(content.cta.label)} <span aria-hidden="true">→</span></a>`
    : `<span class="cta disabled" aria-disabled="true">Service matching is coming soon</span>`;

  return `<!doctype html>
<html lang="en-US"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${e(content.seo.title)}</title><meta name="description" content="${e(content.seo.description)}">
<link rel="canonical" href="https://${e(hostname)}/"><link rel="stylesheet" href="/__dm/site.css">
</head><body data-release="${e(releaseId)}">
<header class="mast"><a href="/" class="brand" aria-label="Home">${e(hostname)}</a><span>Independent local service guide</span></header>
<main>
<section class="hero"><div class="hero-copy"><p class="eyebrow">${e(content.hero.eyebrow)}</p><h1>${e(content.hero.title)}</h1><p class="lede">${e(content.hero.summary)}</p>${cta}<p class="support">${e(content.cta.supportingText)}</p></div><figure><img src="${e(content.image.assetPath)}" alt="${e(content.image.alt)}" width="960" height="1120"><figcaption>${place ? `Serving people researching services around ${e(place)}.` : "A practical guide for comparing local service providers."}</figcaption></figure></section>
<section class="services"><div class="section-intro"><p class="eyebrow">What to look for</p><h2>${e(content.servicesHeading)}</h2></div><ol>${serviceItems}</ol></section>
<section class="guide"><div><p class="eyebrow">Before you choose</p><h2>${e(content.guide.heading)}</h2></div><div class="prose">${guide}</div></section>
<section class="faq"><p class="eyebrow">Common questions</p><h2>${e(content.faqHeading)}</h2>${faqs}</section>
<section class="final"><h2>Compare your options with confidence.</h2>${cta}<p>${e(content.cta.supportingText)}</p></section>
</main>
<footer><p>${e(content.disclosure)}</p><p>© ${new Date().getUTCFullYear()} ${e(hostname)}</p></footer>
<script src="/__dm/site.js" defer></script></body></html>`;
}

export function pausedHtml(hostname: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Temporarily unavailable</title><link rel="stylesheet" href="/__dm/site.css"></head><body class="system-page"><main><h1>Temporarily unavailable</h1><p>${escapeHtml(hostname)} is being updated. Please check back soon.</p></main></body></html>`;
}

export function publicSnapshot(snapshot: ReleaseSnapshot): Omit<ReleaseSnapshot, "content"> {
  const { content: _content, ...rest } = snapshot;
  return rest;
}
