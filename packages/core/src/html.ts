import type { DomainContent, ReleaseSnapshot } from "./schemas";

const TEMPLATE_ASSET_REVISION = "natural-guide-1";

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

function guideBrand(content: DomainContent): string {
  const place = content.location.city ?? content.location.region ?? "Local";
  const vertical = content.vertical
    .split(/\s+/)
    .map((word) => word === word.toUpperCase() ? word : `${word.charAt(0).toUpperCase()}${word.slice(1).toLowerCase()}`)
    .join(" ");
  return `${place} ${vertical} Guide`;
}

export function guideBrandInitials(content: DomainContent): string {
  const place = content.location.city ?? content.location.region ?? "Local";
  const initial = (value: string) => value.match(/[a-z0-9]/i)?.[0]?.toUpperCase() ?? "";
  return `${initial(place)}${initial(content.vertical)}` || "LG";
}

function sitePalette(content: DomainContent): { background: string; accent: string } {
  const slug = verticalSlug(content.vertical);
  return slug === "hvac"
    ? { background: "#0a2b36", accent: "#74cde0" }
    : slug === "roof-coating" || slug === "roofing"
      ? { background: "#21332f", accent: "#e5a067" }
      : { background: "#0b202a", accent: "#f6b84a" };
}

export function siteMarkSvg(content: DomainContent): string {
  const initials = guideBrandInitials(content);
  const palette = sitePalette(content);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="30" fill="${palette.background}"/><circle cx="32" cy="32" r="21" fill="none" stroke="${palette.accent}" stroke-width="2"/><text x="32" y="36" fill="#fffdf8" font-family="Arial,Helvetica,sans-serif" font-size="17" font-weight="800" letter-spacing="1" text-anchor="middle">${initials}</text></svg>`;
}

function sentenceVertical(vertical: string): string {
  return vertical
    .split(/\s+/)
    .map((word) => word.length > 1 && word === word.toUpperCase() ? word : word.toLowerCase())
    .join(" ");
}

function verticalSlug(vertical: string): string {
  return vertical.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
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

function responsiveImage(assetPath: string): { compactPath: string; sourceWidth: number; sourceHeight: number } | null {
  const images: Record<string, { compactPath: string; sourceWidth: number; sourceHeight: number }> = {
    "/__dm/assets/appliance-repair.webp": { compactPath: "/__dm/assets/appliance-repair-960.webp", sourceWidth: 1600, sourceHeight: 2133 },
    "/__dm/assets/home-services-hero.webp": { compactPath: "/__dm/assets/home-services-hero-960.webp", sourceWidth: 1122, sourceHeight: 1402 },
    "/__dm/assets/hvac-service.webp": { compactPath: "/__dm/assets/hvac-service-960.webp", sourceWidth: 1600, sourceHeight: 1137 },
    "/__dm/assets/roof-coating.webp": { compactPath: "/__dm/assets/roof-coating-960.webp", sourceWidth: 1400, sourceHeight: 1050 },
  };
  return images[assetPath] ?? null;
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
  const brand = guideBrand(content);
  const brandInitials = guideBrandInitials(content);
  const palette = sitePalette(content);
  const vertical = sentenceVertical(content.vertical);
  const credit = photoCredit(content.image.assetPath);
  const responsive = responsiveImage(content.image.assetPath);
  const serviceItems = content.services
    .map(
      (service, index) => `<li class="service"><span class="service-number">0${index + 1}</span><div><h3>${e(service.title)}</h3><p>${e(service.description)}</p></div></li>`,
    )
    .join("");
  const guide = content.guide.paragraphs
    .map((paragraph, index) => `<li><span>0${index + 1}</span><p>${e(paragraph)}</p></li>`)
    .join("");
  const faqs = content.faqs
    .map((faq) => `<details><summary>${e(faq.question)}<span aria-hidden="true"></span></summary><p>${e(faq.answer)}</p></details>`)
    .join("");
  const action = offerEnabled
    ? `<div class="action"><a class="cta" href="/go/${e(content.cta.slot)}" rel="nofollow sponsored"><span>${e(content.cta.label)}</span><span class="cta-arrow" aria-hidden="true">&rarr;</span></a><p>${e(content.cta.supportingText)}</p></div>`
    : `<div class="guide-action"><a class="guide-cta" href="#what-to-ask"><span>Start with the local guide</span><span class="cta-arrow" aria-hidden="true">&darr;</span></a><p role="status"><span class="status-dot" aria-hidden="true"></span><span><strong>Provider matching is not open yet.</strong> ${e(content.cta.disabledText ?? "Provider coverage is still being set up. No request form or call line is live yet.")}</span></p></div>`;
  const headerAction = offerEnabled
    ? `<a class="mast-cta" href="/go/${e(content.cta.slot)}" rel="nofollow sponsored" aria-label="Check provider availability"><span><span class="mast-cta-prefix">Check </span>Availability</span><span class="mast-cta-arrow" aria-hidden="true">&rarr;</span></a>`
    : `<span class="mast-status"><span aria-hidden="true"></span> Independent guide</span>`;
  const mobileAction = offerEnabled
    ? `<div class="mobile-action"><a href="/go/${e(content.cta.slot)}" rel="nofollow sponsored"><span>${e(content.cta.label)}</span><span aria-hidden="true">&rarr;</span></a></div>`
    : "";
  const creditHtml = credit
    ? `<span class="photo-credit">Photo: <a href="${e(credit.href)}" target="_blank" rel="noopener noreferrer">${e(credit.label)}</a></span>`
    : "";
  const locationText = place ? e(place) : "United States";

  return `<!doctype html>
<html lang="en-US"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${e(content.seo.title)}</title><meta name="description" content="${e(content.seo.description)}">
<meta name="theme-color" content="${palette.background}">
<link rel="canonical" href="https://${e(hostname)}/"><link rel="icon" href="/__dm/assets/site-mark.svg?rev=${e(releaseId)}" type="image/svg+xml"><link rel="stylesheet" href="/__dm/site-v2.css?rev=${TEMPLATE_ASSET_REVISION}">
</head><body data-release="${e(releaseId)}" data-vertical="${e(verticalSlug(content.vertical))}" data-offer="${offerEnabled ? "enabled" : "disabled"}">
<header class="mast"><div class="mast-inner"><a href="/" class="brand" aria-label="${e(brand)} home"><span class="brand-mark" aria-hidden="true">${e(brandInitials)}</span><span class="brand-copy"><strong>${e(brand)}</strong><small>Independent local guide</small></span></a><nav class="mast-nav" aria-label="Guide sections"><a href="#what-to-ask">What to ask</a><a href="#before-you-call">Before you call</a><a href="#common-questions">FAQs</a></nav>${headerAction}</div></header>
<main>
<section class="hero"><div class="hero-media"><img src="${e(content.image.assetPath)}"${responsive ? ` srcset="${e(responsive.compactPath)} 960w, ${e(content.image.assetPath)} ${responsive.sourceWidth}w" sizes="100vw"` : ""} alt="${e(content.image.alt)}" width="${responsive?.sourceWidth ?? 1200}" height="${responsive?.sourceHeight ?? 900}" fetchpriority="high" decoding="async"><div class="hero-shade"></div></div><div class="hero-inner"><div class="hero-copy"><p class="eyebrow">${e(content.hero.eyebrow)}</p><h1>${e(content.hero.title)}</h1><p class="lede">${e(content.hero.summary)}</p>${action}<p class="hero-disclosure">Independent information guide <span aria-hidden="true">&middot;</span> Not a service provider</p></div></div><div class="hero-caption"><span>${e(content.vertical)} guidance for ${locationText}</span>${creditHtml}</div></section>
<section class="guide-nav" aria-label="Explore this guide"><div class="guide-nav-inner"><a href="#what-to-ask"><span class="guide-nav-number">01</span><p><strong>What to ask</strong><span>Understand scope, cost, and warranty.</span></p><span class="guide-nav-arrow" aria-hidden="true">&darr;</span></a><a href="#before-you-call"><span class="guide-nav-number">02</span><p><strong>Before you call</strong><span>Gather details that make the conversation useful.</span></p><span class="guide-nav-arrow" aria-hidden="true">&darr;</span></a><a href="#common-questions"><span class="guide-nav-number">03</span><p><strong>Common questions</strong><span>Get clear answers before you decide.</span></p><span class="guide-nav-arrow" aria-hidden="true">&darr;</span></a></div></section>
<section class="services section" id="what-to-ask" data-reveal><div class="section-intro"><p class="eyebrow">What to ask first</p><h2>${e(content.servicesHeading)}</h2></div><ol>${serviceItems}</ol></section>
<section class="guide" id="before-you-call" data-reveal><div class="guide-inner"><div class="guide-heading"><p class="eyebrow">Before you call</p><h2>${e(content.guide.heading)}</h2></div><ol class="prep-list">${guide}</ol></div></section>
<section class="faq section" id="common-questions" data-reveal><div class="section-intro"><p class="eyebrow">Common questions</p><h2>${e(content.faqHeading)}</h2></div><div class="faq-list">${faqs}</div></section>
<section class="final" data-reveal><div class="final-inner"><div><p class="eyebrow">${offerEnabled ? "Your next step" : "Keep this handy"}</p><h2>${offerEnabled ? `Ready to explore ${e(vertical)} options in ${locationText}?` : `Use this guide before you compare ${e(vertical)} options in ${locationText}.`}</h2></div>${action}</div></section>
</main>
<footer><div class="footer-brand"><span class="brand-mark" aria-hidden="true">${e(brandInitials)}</span><strong>${e(brand)}</strong></div><nav class="footer-nav" aria-label="Footer guide sections"><a href="#what-to-ask">What to ask</a><a href="#before-you-call">Before you call</a><a href="#common-questions">FAQs</a></nav><p class="footer-disclosure">${e(content.disclosure)}</p><p class="copyright">&copy; ${new Date().getUTCFullYear()} ${e(hostname)}</p></footer>
${mobileAction}<script src="/__dm/site-v2.js?rev=${TEMPLATE_ASSET_REVISION}" defer></script></body></html>`;
}

export function pausedHtml(hostname: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Temporarily unavailable</title><link rel="stylesheet" href="/__dm/site-v2.css"></head><body class="system-page"><main><h1>Temporarily unavailable</h1><p>${escapeHtml(hostname)} is being updated. Please check back soon.</p></main></body></html>`;
}

export function publicSnapshot(snapshot: ReleaseSnapshot): Omit<ReleaseSnapshot, "content"> {
  const { content: _content, ...rest } = snapshot;
  return rest;
}
