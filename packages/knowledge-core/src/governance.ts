import { and, eq, inArray, isNull, or } from "drizzle-orm";
import {
  knowledgeDocuments as documents,
  knowledgeSourceSnapshots as snapshots,
  knowledgeSources as sources,
  knowledgeConflicts as conflicts,
  knowledgeEntries as entries,
  knowledgeVersions as versions,
  type TenantTransaction,
} from "@yummyai/database";
import { createEntityId } from "@yummyai/contracts";
import type { KnowledgeFields, KnowledgeSearch } from "@yummyai/contracts/knowledge";
import { knowledgeChecksum, knowledgeDay } from "./documents.js";

export function knowledgeScopeMatches(fields: KnowledgeFields, scope: KnowledgeSearch) {
  return (
    (scope.topic === "all" || scope.topic === fields.topic) &&
    (fields.platform === "all" || fields.platform === scope.platform) &&
    (fields.market === "ALL" || fields.market === scope.market) &&
    (!fields.spuId || scope.spuIds.includes(fields.spuId))
  );
}
export function knowledgeScopeOverlaps(a: KnowledgeFields, b: KnowledgeFields) {
  return (
    (a.platform === "all" || b.platform === "all" || a.platform === b.platform) &&
    (a.market === "ALL" || b.market === "ALL" || a.market === b.market) &&
    (!a.spuId || !b.spuId || a.spuId === b.spuId)
  );
}
export async function knowledgeEvidenceIssues(
  tx: TenantTransaction,
  fields: KnowledgeFields,
  at = new Date(),
): Promise<string[]> {
  const issues: string[] = [];
  if (fields.verifiedOn > knowledgeDay(at) || fields.reviewDueOn < knowledgeDay(at))
    issues.push("知识卡尚未核对或已到复查期限");
  if (fields.claims?.some((c) => c.validFrom > knowledgeDay(at) || c.validUntil < knowledgeDay(at)))
    issues.push("登记主张不在适用有效期内");
  for (const id of fields.documentIds ?? []) {
    const [document] = await tx.select().from(documents).where(eq(documents.id, id));
    if (!document || document.kind !== "reference" || document.state !== "confirmed")
      issues.push("原资料不存在、未经确认或属于账户证据域");
    else if (document.fields.reviewDueOn < knowledgeDay(at))
      issues.push(`原资料“${document.fileName}”需要复查`);
    else if (
      !knowledgeScopeMatches(document.fields, {
        query: "scope",
        topic: "all",
        platform: fields.platform,
        market: fields.market,
        spuIds: fields.spuId ? [fields.spuId] : [],
      })
    )
      issues.push("原资料范围不能覆盖这张知识卡的适用范围");
  }
  for (const id of fields.sourceSnapshotIds ?? []) {
    const [row] = await tx
      .select({ snapshot: snapshots, source: sources })
      .from(snapshots)
      .innerJoin(sources, eq(sources.id, snapshots.sourceId))
      .where(eq(snapshots.id, id));
    if (!row || row.source.archivedAt) {
      issues.push("来源证据不存在或已归档");
      continue;
    }
    const [latest] = row.source.latestSnapshotId
      ? await tx.select().from(snapshots).where(eq(snapshots.id, row.source.latestSnapshotId))
      : [];
    const effective = latest?.checksum === row.snapshot.checksum ? latest : row.snapshot;
    if (effective.validUntil <= at) issues.push(`来源“${row.source.label}”证据已过期`);
    if (fields.sourceUrl && new URL(fields.sourceUrl).hostname !== new URL(row.source.url).hostname)
      issues.push("官方来源与知识原文域名不符");
  }
  return issues;
}
export async function recordKnowledgeConflicts(
  tx: TenantTransaction,
  tenantId: string,
  version: typeof versions.$inferSelect,
) {
  if (!version.fields.claims?.length) return;
  const others = await tx
    .select({ version: versions })
    .from(versions)
    .innerJoin(entries, eq(entries.id, versions.entryId))
    .where(
      and(
        isNull(entries.archivedAt),
        or(
          eq(versions.version, entries.activeVersion),
          eq(versions.version, entries.latestVersion),
        ),
      ),
    );
  for (const { version: other } of others) {
    if (other.entryId === version.entryId || !knowledgeScopeOverlaps(version.fields, other.fields))
      continue;
    for (const a of version.fields.claims)
      for (const b of other.fields.claims ?? []) {
        if (
          a.key.trim().toLowerCase() !== b.key.trim().toLowerCase() ||
          (a.value.trim() === b.value.trim() && a.unit === b.unit) ||
          a.validFrom > b.validUntil ||
          b.validFrom > a.validUntil
        )
          continue;
        const [left, right] = [version.id, other.id].sort();
        const fingerprint = knowledgeChecksum([left, right, a.key.trim().toLowerCase()]);
        await tx
          .insert(conflicts)
          .values({
            id: createEntityId(),
            tenantId,
            key: a.key,
            leftVersionId: left!,
            rightVersionId: right!,
            fingerprint,
            severity:
              a.severity === "blocking" || b.severity === "blocking" ? "blocking" : "warning",
          })
          .onConflictDoNothing();
      }
  }
}
export async function knowledgeBlockingConflicts(tx: TenantTransaction, versionId: string) {
  const rows = await tx
    .select()
    .from(conflicts)
    .where(
      and(
        or(eq(conflicts.leftVersionId, versionId), eq(conflicts.rightVersionId, versionId)),
        eq(conflicts.severity, "blocking"),
        inArray(conflicts.state, ["open", "needs_evidence", "superseded"]),
      ),
    );
  const result = [];
  for (const row of rows) {
    const otherId = row.leftVersionId === versionId ? row.rightVersionId : row.leftVersionId;
    const [other] = await tx
      .select({ id: versions.id })
      .from(versions)
      .innerJoin(entries, eq(entries.id, versions.entryId))
      .where(
        and(
          eq(versions.id, otherId),
          isNull(entries.archivedAt),
          eq(entries.activeVersion, versions.version),
        ),
      );
    if (other) result.push(row);
  }
  return result;
}
