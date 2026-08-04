import { z } from "zod";

const text = (max: number) => z.string().trim().min(1).max(max);

export const hostnameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .refine(
    (value) =>
      value.split(".").length >= 2 &&
      value.split(".").every((label) => /^(?!-)[a-z0-9-]{1,63}(?<!-)$/.test(label)),
    "Invalid hostname",
  );

export const serviceSchema = z.object({
  title: text(80),
  description: text(260),
});

export const faqSchema = z.object({
  question: text(140),
  answer: text(500),
});

export const contentSchema = z.object({
  schemaVersion: z.literal(1),
  locale: z.literal("en-US").default("en-US"),
  vertical: text(60),
  location: z.object({
    city: text(80).optional(),
    region: text(80).optional(),
    country: z.literal("US"),
  }),
  seo: z.object({
    title: text(65),
    description: text(160),
  }),
  hero: z.object({
    eyebrow: text(80),
    title: text(100),
    summary: text(320),
  }),
  servicesHeading: text(100),
  services: z.array(serviceSchema).min(2).max(6),
  guide: z.object({
    heading: text(100),
    paragraphs: z.array(text(700)).min(2).max(5),
  }),
  faqHeading: text(100),
  faqs: z.array(faqSchema).min(2).max(6),
  cta: z.object({
    label: text(48),
    supportingText: text(180),
    disabledText: text(200).optional(),
    slot: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/),
  }),
  disclosure: text(400),
  image: z.object({
    assetPath: z.string().regex(/^\/__dm\/assets\/[a-z0-9/_-]+\.(avif|webp|jpe?g)$/),
    alt: text(160),
  }),
});

export type DomainContent = z.infer<typeof contentSchema>;

export const offerSlotSchema = z.object({
  slot: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/),
  enabled: z.boolean(),
});

export const releaseSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  releaseId: z.string().min(1).max(100),
  domainId: z.string().min(1).max(100),
  hostname: hostnameSchema,
  state: z.enum(["live", "paused"]),
  templateKey: z.literal("home-services"),
  content: contentSchema,
  offerSlots: z.array(offerSlotSchema).max(8),
  html: z.string().min(100).max(250_000),
  compiledAt: z.string().datetime(),
});

export type ReleaseSnapshot = z.infer<typeof releaseSnapshotSchema>;

export const domainImportSchema = z.object({
  hostname: hostnameSchema,
  registrar: z.string().max(80).nullable().optional(),
  sourceType: z.literal("parking"),
  sourceStatus: z.literal("available"),
  sourceLabels: z.array(z.string().max(80)).max(50).default([]),
  vertical: z.string().max(60).nullable().optional(),
  country: z.string().max(30).nullable().optional(),
  aiSummary: z.string().max(2000).nullable().optional(),
  aiKeywords: z.array(z.string().max(120)).max(50).default([]),
  traffic30dVisitors: z.number().int().min(0).nullable().optional(),
  parking30dRevenueUsd: z.number().min(0).nullable().optional(),
  trafficEvidenceAt: z.string().datetime().nullable().optional(),
});

export type DomainImport = z.infer<typeof domainImportSchema>;

export const contentMutationSchema = z.object({
  content: contentSchema,
  provenance: z.enum(["manual", "import", "codex"]),
});
