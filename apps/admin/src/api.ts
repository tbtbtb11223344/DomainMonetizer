export interface DomainSummary {
  id: string;
  hostname: string;
  lifecycleStatus: "draft" | "ready" | "published" | "paused" | "retired";
  registrar: string | null;
  sourceType: string | null;
  sourceStatus: string | null;
  sourceLabels: string[];
  vertical: string | null;
  country: string | null;
  aiSummary: string | null;
  aiKeywords: string[];
  traffic30dVisitors: number | null;
  parking30dRevenueUsd: number | null;
  trafficEvidenceAt: string | null;
  activeReleaseId: string | null;
  updatedAt: string;
}

export interface VersionSummary {
  id: string;
  version: number;
  status: string;
  provenance?: string;
  created_by: string;
  created_at: string;
  approved_at?: string | null;
  published_at?: string | null;
}

export interface DomainDetail {
  domain: DomainSummary;
  contents: VersionSummary[];
  releases: VersionSummary[];
  metrics: Array<Record<string, number | string>>;
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...options?.headers },
  });
  const payload = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(payload.error ?? `Request failed (${response.status})`);
  return payload;
}

export async function listDomains(search = ""): Promise<DomainSummary[]> {
  const result = await request<{ domains: DomainSummary[] }>(`/api/domains?limit=500&search=${encodeURIComponent(search)}`);
  return result.domains;
}

export async function getDomain(hostname: string): Promise<DomainDetail> {
  return request(`/api/domains/${encodeURIComponent(hostname)}`);
}

export async function mutate(path: string): Promise<Record<string, unknown>> {
  return request(path, { method: "POST", body: "{}" });
}
