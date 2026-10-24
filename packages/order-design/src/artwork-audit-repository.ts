import { and, desc, eq, isNull } from "drizzle-orm";
import { artworkAuditReport, assistFingerprint, validateAssistResult, type AssistContext, type SecretVault } from "@yummyai/ai-core";
import { authorize, Permission } from "@yummyai/authz";
import type { TenantContext } from "@yummyai/contracts";
import { ARTWORK_AUDIT_POLICY, type ArtworkAuditReport } from "@yummyai/contracts/ai/artwork-audit";
import { aiAssistRuns, productionEditorProjects, productionEditorVersions, orderWorkItems, orderWorkRevisions, amazonOrderReportLines, withTenant, type DatabaseConnection } from "@yummyai/database";

/** API approval and Worker rendering share this tenant-authorized read. Never use
 * a client report to clear gates, or reuse checks for a different file or order. */
export class ArtworkAuditRepository {
  constructor(private readonly database: DatabaseConnection, private readonly vault: SecretVault) {}
  async current(context: TenantContext, projectId: string, versionId: string): Promise<ArtworkAuditReport | null> {
    authorize(context, Permission.DesignRead); authorize(context, Permission.OrderRead); authorize(context, Permission.OrderPiiRead);
    return withTenant(this.database.db, context, async tx => {
      const [project] = await tx.select().from(productionEditorProjects).where(eq(productionEditorProjects.id, projectId));
      if (!project?.sourceWorkItemId || !project.encryptedDataKey || project.currentVersionId !== versionId || project.archivedAt || project.status !== "active" || project.expiresAt && project.expiresAt <= new Date()) return null;
      const [work] = await tx.select().from(orderWorkItems).where(eq(orderWorkItems.id, project.sourceWorkItemId));
      if (!work?.encryptedDataKey || work.held || work.archivedAt || work.expiresAt <= new Date() || work.pushedRevisionId !== project.sourceWorkRevisionId) return null;
      const [revision] = await tx.select().from(orderWorkRevisions).where(eq(orderWorkRevisions.id, work.pushedRevisionId!));
      if (!revision || revision.revision !== work.revision) return null;
      if (work.reportLineId) {
        const [report] = await tx.select().from(amazonOrderReportLines).where(eq(amazonOrderReportLines.id, work.reportLineId));
        // Workspace review is pinned by the pushed work revision. The separate
        // legacy report-review checkbox is not a prerequisite for that workflow.
        if (!report || report.currentVersionId !== work.sourceVersionId || report.expiresAt <= new Date()) return null;
      }
      const [version] = await tx.select().from(productionEditorVersions).where(and(eq(productionEditorVersions.id, versionId), eq(productionEditorVersions.projectId, projectId)));
      if (!version) return null;
      const rows = await tx.select().from(aiAssistRuns).where(and(eq(aiAssistRuns.kind, "artwork_preflight"), eq(aiAssistRuns.orderLineId, work.id), isNull(aiAssistRuns.benchmarkItemId))).orderBy(desc(aiAssistRuns.createdAt)).limit(50);
      for (const row of rows) {
        if (!row.encryptedInput || row.expiresAt <= new Date()) continue;
        const input = await this.vault.withSecret(row.encryptedInput, value => JSON.parse(value) as AssistContext);
        const basis = input.artworkAudit;
        if (!basis || basis.versionId !== versionId || basis.revision !== work.revision) continue;
        // A newer pending/failed attempt invalidates an older successful report.
        if (basis.policy !== ARTWORK_AUDIT_POLICY || basis.projectId !== projectId || basis.orderLineId !== work.id || basis.sourceVersionId !== work.sourceVersionId || basis.documentHash !== version.checksum || assistFingerprint(input) !== row.inputFingerprint) return null;
        const output = row.encryptedOutput ? await this.vault.withSecret(row.encryptedOutput, value => JSON.parse(value) as {result: unknown; images?: Array<{sourceId: string}>}) : null;
        const imageIds = output?.images?.map(i => i.sourceId) ?? [];
        const result = row.status === "completed" && output ? validateAssistResult(output.result, input, imageIds) : null;
        return artworkAuditReport(input, result, imageIds, row.status === "completed" && !!result);
      }
      return null;
    });
  }
}
