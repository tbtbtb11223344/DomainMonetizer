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

export function siteMarkSvg(content: DomainContent): string {
  const initials = guideBrandInitials(content);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="30" fill="#0b202a"/><circle cx="32" cy="32" r="21" fill="none" stroke="#f6b84a" stroke-width="2"/><text x="32" y="36" fill="#fffdf8" font-family="Arial,Helvetica,sans-serif" font-size="17" font-weight="800" letter-spacing="1" text-anchor="middle">${initials}</text></svg>`;
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
    : `<div class="matching-status" role="status"><span class="status-dot" aria-hidden="true"></span><div><span class="status-label">Coverage update</span><strong>Local matching is not open yet</strong><span>${e(content.cta.disabledText ?? "Provider coverage is still being set up. No request form or call line is live yet.")}</span></div></div>`;
  const headerAction = offerEnabled
    ? `<a class="mast-cta" href="/go/${e(content.cta.slot)}" rel="nofollow sponsored">Check availability <span aria-hidden="true">&rarr;</span></a>`
    : `<span class="mast-status"><span aria-hidden="true"></span> Matching opening soon</span>`;
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
<meta name="theme-color" content="#0b202a">
<link rel="canonical" href="https://${e(hostname)}/"><link rel="icon" href="/__dm/assets/site-mark.svg" type="image/svg+xml"><link rel="stylesheet" href="/__dm/site-v2.css">
</head><body data-release="${e(releaseId)}" data-vertical="${e(verticalSlug(content.vertical))}" data-offer="${offerEnabled ? "enabled" : "disabled"}">
<header class="mast"><div class="mast-inner"><a href="/" class="brand" aria-label="${e(brand)} home"><span class="brand-mark" aria-hidden="true">${e(brandInitials)}</span><span>${e(brand)}</span></a>${headerAction}</div></header>
<main>
<section class="hero"><div class="hero-media"><img src="${e(content.image.assetPath)}"${responsive ? ` srcset="${e(responsive.compactPath)} 960w, ${e(content.image.assetPath)} ${responsive.sourceWidth}w" sizes="100vw"` : ""} alt="${e(content.image.alt)}" width="${responsive?.sourceWidth ?? 1200}" height="${responsive?.sourceHeight ?? 900}" fetchpriority="high" decoding="async"><div class="hero-shade"></div></div><div class="hero-inner"><div class="hero-copy"><p class="eyebrow">${e(content.hero.eyebrow)}</p><h1>${e(content.hero.title)}</h1><p class="lede">${e(content.hero.summary)}</p>${action}<p class="hero-disclosure">Independent referral guide <span aria-hidden="true">&middot;</span> Provider terms and availability vary</p></div></div><div class="hero-caption"><span>${e(content.vertical)} guidance for ${locationText}</span>${creditHtml}</div></section>
<section class="trust-band" aria-label="Why use this guide"><div class="trust-inner"><div><span class="trust-number">01</span><p><strong>Focused on ${locationText}</strong><span>Built around nearby ${e(vertical)} needs.</span></p></div><div><span class="trust-number">02</span><p><strong>Know before you book</strong><span>Useful questions, clearer estimates, fewer surprises.</span></p></div><div><span class="trust-number">03</span><p><strong>Clear, practical guidance</strong><span>Choose your next step with more confidence.</span></p></div></div></section>
<section class="services section" data-reveal><div class="section-intro"><p class="eyebrow">A smarter first call</p><h2>${e(content.servicesHeading)}</h2></div><ol>${serviceItems}</ol></section>
<section class="guide" data-reveal><div class="guide-inner"><div class="guide-heading"><p class="eyebrow">Your 60-second prep</p><h2>${e(content.guide.heading)}</h2></div><ol class="prep-list">${guide}</ol></div></section>
<section class="faq section" data-reveal><div class="section-intro"><p class="eyebrow">Straight answers</p><h2>${e(content.faqHeading)}</h2></div><div class="faq-list">${faqs}</div></section>
<section class="final" data-reveal><div class="final-inner"><div><p class="eyebrow">${offerEnabled ? "Your next step" : "Coverage update"}</p><h2>${offerEnabled ? `Ready to explore ${e(vertical)} options in ${locationText}?` : `We're building a better way to find ${e(vertical)} help in ${locationText}.`}</h2></div>${action}</div></section>
</main>
<footer><div class="footer-brand"><span class="brand-mark" aria-hidden="true">${e(brandInitials)}</span><strong>${e(brand)}</strong></div><p>${e(content.disclosure)}</p><p class="copyright">&copy; ${new Date().getUTCFullYear()} ${e(hostname)}</p></footer>
${mobileAction}<script src="/__dm/site-v2.js" defer></script></body></html>`;
}

export function pausedHtml(hostname: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Temporarily unavailable</title><link rel="stylesheet" href="/__dm/site-v2.css"></head><body class="system-page"><main><h1>Temporarily unavailable</h1><p>${escapeHtml(hostname)} is being updated. Please check back soon.</p></main></body></html>`;
}

export function publicSnapshot(snapshot: ReleaseSnapshot): Omit<ReleaseSnapshot, "content"> {
  const { content: _content, ...rest } = snapshot;
  return rest;
}
