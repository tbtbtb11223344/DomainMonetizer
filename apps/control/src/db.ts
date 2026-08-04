import { randomId } from "@domain-monetizer/core";

export function nowIso(): string {
  return new Date().toISOString();
}

export function auditStatement(
  db: D1Database,
  input: { actor: string; action: string; entityType: string; entityId: string; requestId?: string; before?: unknown; after?: unknown },
): D1PreparedStatement {
  return db
    .prepare("INSERT INTO audit_log (id, actor, action, entity_type, entity_id, request_id, before_json, after_json, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(
      randomId("audit"),
      input.actor,
      input.action,
      input.entityType,
      input.entityId,
      input.requestId ?? null,
      input.before === undefined ? null : JSON.stringify(input.before),
      input.after === undefined ? null : JSON.stringify(input.after),
      nowIso(),
    );
}

export async function nextVersion(db: D1Database, table: "content_versions" | "release_versions", domainId: string): Promise<number> {
  const result = await db.prepare(`SELECT COALESCE(MAX(version), 0) + 1 AS version FROM ${table} WHERE domain_id = ?`).bind(domainId).first<{ version: number }>();
  return result?.version ?? 1;
}
