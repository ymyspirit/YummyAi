import { and, eq, sql } from "drizzle-orm";
import { Permission, authorize } from "@yummyai/authz";
import { catalogOwnerFilter } from "@yummyai/catalog-core";
import type { AgentMethodDefinition } from "@yummyai/contracts/harness/methods";
import type { TenantContext } from "@yummyai/contracts";
import type { AssistInputAuthority } from "@yummyai/contracts/ai/assist";
import type { KnowledgeReference } from "@yummyai/contracts/knowledge";
import {
  knowledgeEntries,
  knowledgeVersions,
  knowledgeEvents,
  knowledgeDocuments,
  marketplaceAccounts,
  type TenantTransaction,
  AgentMethodAuthorityError,
} from "@yummyai/database";
import { knowledgeChecksum, knowledgeDay } from "./documents.js";
import { knowledgeEvidenceIssues, knowledgeBlockingConflicts } from "./governance.js";
import { knowledgeProductsVisible } from "./knowledge-search-owner.js";

/** A method's bibliography is provenance, not additional task fact citations. */
export async function assertMethodKnowledge(tx: TenantTransaction, context: TenantContext, definition: AgentMethodDefinition | null, options: { lock?: boolean } = {}) {
  if (!definition) return;
  authorize(context, Permission.WorkflowRead);
  if (options.lock) {
    // Serialize source withdrawal with the owning write transaction, in stable order.
    for (const entryId of [...new Set(definition.knowledgeReferences.map(ref => ref.entryId))].sort())
      await tx.select({ id: knowledgeEntries.id }).from(knowledgeEntries).where(eq(knowledgeEntries.id, entryId)).for("share");
  }
  if ((await knowledgeExecutionAuthority(tx,context,definition.knowledgeReferences)).some(row=>row.count!==1))
    throw new AgentMethodAuthorityError("assist_method_sources_unavailable");
}

/** Reuse knowledge governance for pinned evidence; a later publication never replaces an old pin. */
export async function knowledgeExecutionAuthority(
  tx: TenantTransaction,
  context: TenantContext,
  references: KnowledgeReference[] = [],
  storeId: string | null = null,
): Promise<AssistInputAuthority["resources"]> {
  const result: AssistInputAuthority["resources"] = [];
  for (const [index, reference] of references.entries()) {
    let usable = false;
    let evidence: unknown = null;
    if (reference.sourceId.startsWith("account:")) {
      const allowed = context.permissions.includes(Permission.StoreRead) && context.permissions.includes(Permission.FinanceRead);
      const [document] = await tx
        .select()
        .from(knowledgeDocuments)
        .where(and(eq(knowledgeDocuments.id, reference.versionId), allowed ? and(
          catalogOwnerFilter(context, Permission.StoreRead, knowledgeDocuments.createdBy),
          catalogOwnerFilter(context, Permission.FinanceRead, knowledgeDocuments.createdBy),
        ) : sql`false`));
      const [store] = storeId
        ? await tx
            .select({ id: marketplaceAccounts.id, deletedAt: marketplaceAccounts.deletedAt })
            .from(marketplaceAccounts)
            .where(and(eq(marketplaceAccounts.id, storeId), allowed ? and(
              catalogOwnerFilter(context, Permission.StoreRead, marketplaceAccounts.createdBy),
              catalogOwnerFilter(context, Permission.FinanceRead, marketplaceAccounts.createdBy),
            ) : sql`false`))
        : [];
      usable = !!(
        document &&
        store &&
        !store.deletedAt &&
        context.permissions.includes(Permission.FinanceRead) &&
        context.permissions.includes(Permission.WorkflowRead) &&
        await knowledgeProductsVisible(tx, context, document.fields.spuId ? [document.fields.spuId] : []) &&
        document.kind === "account" &&
        document.state === "confirmed" &&
        document.storeId === storeId &&
        document.fields.verifiedOn <= knowledgeDay() &&
        document.fields.reviewDueOn >= knowledgeDay() &&
        knowledgeChecksum(document.safeText) === reference.checksum
      );
      evidence = document
        ? {
            id: document.id,
            state: document.state,
            content: knowledgeChecksum(document.safeText),
            account: document.account,
            fields: document.fields,
            storeId: document.storeId,
          }
        : null;
    } else {
      const [row] = await tx
        .select({ entry: knowledgeEntries, version: knowledgeVersions })
        .from(knowledgeVersions)
        .innerJoin(knowledgeEntries, eq(knowledgeEntries.id, knowledgeVersions.entryId))
        .where(
          and(
            eq(knowledgeVersions.id, reference.versionId),
            eq(knowledgeVersions.entryId, reference.entryId),
            eq(knowledgeVersions.version, reference.version),
          ),
        );
      const [publication] = row
        ? await tx
            .select({ id: knowledgeEvents.id })
            .from(knowledgeEvents)
            .where(
              and(
                eq(knowledgeEvents.entryId, reference.entryId),
                eq(knowledgeEvents.version, reference.version),
                eq(knowledgeEvents.action, "publish"),
              ),
            )
            .limit(1)
        : [];
      const issues = row ? await knowledgeEvidenceIssues(tx, row.version.fields) : ["missing"];
      const conflicts = row ? await knowledgeBlockingConflicts(tx, row.version.id) : [];
      usable = !!(
        row &&
        !row.entry.archivedAt &&
        row.entry.activeVersion !== null &&
        publication &&
        row.version.checksum === reference.checksum &&
        context.permissions.includes(Permission.WorkflowRead) &&
        await knowledgeProductsVisible(tx, context, row.version.scopeSpuId ? [row.version.scopeSpuId] : []) &&
        !issues.length &&
        !conflicts.length
      );
      evidence = row
        ? {
            id: row.version.id,
            checksum: row.version.checksum,
            enabled: row.entry.activeVersion !== null,
            archivedAt: row.entry.archivedAt,
            published: !!publication,
            issues,
            conflicts: conflicts.map((c) => c.id).sort(),
          }
        : null;
    }
    result.push({
      key: `knowledge.pinned.${index}`,
      required: true,
      count: usable ? 1 : 0,
      checksum: knowledgeChecksum({ usable, evidence }),
    });
  }
  return result;
}
