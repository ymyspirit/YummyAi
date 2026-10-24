import { authorize, Permission } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { CreativeExecutionAuthoritySchema } from "@yummyai/contracts/harness";
import { captureCreativeExecutionAuthority, currentCreativeExecutionAuthority, creativeExecutions, creativeExecutionChecksum, type TenantTransaction } from "@yummyai/database";
import { and, eq, sql } from "drizzle-orm";
import { assertCreativeMethod, selectCreativeMethod, creativeHarness, CreativeOriginalInputSchema } from "./creative-harness.js";
import { readCreativeExecutionSource, type CreativeOperation } from "./creative-execution-input.js";
import { PodOwnerError } from "./errors.js";

export function creativeOwnerCondition(operation: CreativeOperation) {
  const field = { creative_candidate: creativeExecutions.candidateId, creative_adaptation: creativeExecutions.creativeVersionId,
    template_compile: creativeExecutions.inspectionId, mockup_render: creativeExecutions.mockupItemId, studio_generation: creativeExecutions.studioGenerationId }[operation.kind];
  return and(eq(creativeExecutions.kind, operation.kind), eq(field, operation.ownerId), eq(creativeExecutions.stepKey, operation.stepKey));
}
export function creativeOriginalFingerprint(operation: CreativeOperation, source: unknown,
  pinned: Pick<typeof creativeExecutions.$inferSelect, "authorityChecksum" | "executionContract" | "methodSelection" | "effect"> & { parentExecutionId?: string | null }) {
  return creativeExecutionChecksum({ version: "creative-input-v1", operation, source,
    parentExecutionId: pinned.parentExecutionId ?? null, authorityChecksum: pinned.authorityChecksum,
    executionContract: pinned.executionContract, methodSelection: pinned.methodSelection, effect: pinned.effect });
}

/** Only new original producers invoke this in their owning transaction. */
export async function stageCreativeExecution(tx: TenantTransaction, context: TenantContext, operation: CreativeOperation,
  effect: "external_request" | "internal_write") {
  if (operation.kind === "creative_adaptation" && (effect !== "internal_write" || !operation.stepKey.startsWith("spec:")))
    throw new PodOwnerError("CREATIVE_PARENT_REQUIRED", 409, "扩图必须由原适配步骤按实际几何需要激活");
  authorize(context, Permission.DesignWrite);
  const bundle = creativeHarness(operation.kind, effect);
  const captured = await captureCreativeExecutionAuthority(tx, context, bundle.requiredPermissions);
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${context.tenantId}:${operation.kind}:${operation.ownerId}:${operation.stepKey}:original-creative-execution`},0))`);
  const source = await readCreativeExecutionSource(tx, captured.authority, operation);
  authorize(captured.authority, Permission.DesignWrite, { ownerId: source.requestedBy });
  const [existing] = await tx.select().from(creativeExecutions).where(creativeOwnerCondition(operation));
  if (existing) {
    if (existing.requestedBy !== context.userId || existing.effect !== effect || creativeOriginalFingerprint(operation, source, existing) !== existing.inputFingerprint)
      throw new PodOwnerError("CREATIVE_ORIGINAL_INPUT_CHANGED", 409, "原执行输入已变化 不能替换权限或重新提交");
    return existing;
  }
  const method = await selectCreativeMethod(tx, captured.authority, operation.kind, effect);
  const input = CreativeOriginalInputSchema.parse({ ...operation, sourceChecksum: creativeExecutionChecksum(source) });
  bundle.registry.checkInput(method.executionContract, bundle.skill, bundle.key, input);
  const id = createEntityId(), authorityChecksum = captured.checksum;
  const [row] = await tx.insert(creativeExecutions).values({ id, tenantId: context.tenantId, requestedBy: context.userId,
    kind: operation.kind, stepKey: operation.stepKey,
    candidateId: operation.kind === "creative_candidate" ? operation.ownerId : null,
    creativeVersionId: operation.kind === "creative_adaptation" ? operation.ownerId : null,
    inspectionId: operation.kind === "template_compile" ? operation.ownerId : null,
    mockupItemId: operation.kind === "mockup_render" ? operation.ownerId : null,
    studioGenerationId: operation.kind === "studio_generation" ? operation.ownerId : null,
    authoritySnapshot: captured.snapshot, authorityChecksum, ...method, effect,
    inputFingerprint: creativeOriginalFingerprint(operation, source, { authorityChecksum, ...method, effect }),
  }).returning();
  return row!;
}

/** Activation is a delegation from a currently owned parent lease, never a new authority grant. */
export async function stageCreativeOutpaint(tx: TenantTransaction, identity: Pick<TenantContext, "tenantId" | "userId">,
  parentId: string, leaseToken: string) {
  const [parent] = await tx.select({ row: creativeExecutions,
    live: sql<boolean>`${creativeExecutions.leaseExpiresAt}>clock_timestamp()` }).from(creativeExecutions)
    .where(eq(creativeExecutions.id, parentId)).for("update");
  if (!parent || !parent.live || parent.row.leaseToken !== leaseToken || parent.row.phase !== "preparing"
    || parent.row.kind !== "creative_adaptation" || parent.row.effect !== "internal_write" || !parent.row.stepKey.startsWith("spec:"))
    throw new PodOwnerError("CREATIVE_PARENT_LEASE_LOST", 409, "原适配步骤不再拥有有效执行租约");
  const original = parent.row, parentBundle = creativeHarness(original.kind, original.effect);
  const authority = await currentCreativeExecutionAuthority(tx, identity, original, parentBundle.requiredPermissions);
  await assertCreativeMethod(tx, authority, original);
  const parentOperation: CreativeOperation = { kind: original.kind, ownerId: original.creativeVersionId!, stepKey: original.stepKey };
  const parentSource = await readCreativeExecutionSource(tx, authority, parentOperation);
  if (creativeOriginalFingerprint(parentOperation, parentSource, original) !== original.inputFingerprint)
    throw new PodOwnerError("CREATIVE_ORIGINAL_INPUT_CHANGED", 409, "原适配输入已变化");
  const operation: CreativeOperation = { kind: "creative_adaptation", ownerId: original.creativeVersionId!, stepKey: `outpaint:${original.stepKey.slice(5)}` };
  const source = await readCreativeExecutionSource(tx, authority, operation), effect = "external_request" as const;
  const child = creativeHarness(operation.kind, effect), input = CreativeOriginalInputSchema.parse({ ...operation, sourceChecksum: creativeExecutionChecksum(source) });
  parentBundle.registry.checkInput(original.executionContract, parentBundle.skill, child.key, input);
  const [existing] = await tx.select().from(creativeExecutions).where(creativeOwnerCondition(operation));
  if (existing) {
    if (existing.parentExecutionId !== original.id || existing.requestedBy !== identity.userId
      || creativeOriginalFingerprint(operation, source, existing) !== existing.inputFingerprint)
      throw new PodOwnerError("CREATIVE_ORIGINAL_INPUT_CHANGED", 409, "扩图原执行不匹配");
    return existing;
  }
  const snapshot = CreativeExecutionAuthoritySchema.parse({ ...original.authoritySnapshot, context: authority });
  const authorityChecksum = creativeExecutionChecksum(snapshot), method = await selectCreativeMethod(tx, authority, operation.kind, effect);
  const pins = { authorityChecksum, ...method, effect, parentExecutionId: original.id };
  const [created] = await tx.insert(creativeExecutions).values({ id: createEntityId(), tenantId: identity.tenantId,
    kind: operation.kind, creativeVersionId: operation.ownerId, stepKey: operation.stepKey,
    requestedBy: identity.userId, authoritySnapshot: snapshot, ...pins, inputFingerprint: creativeOriginalFingerprint(operation, source, pins) }).returning();
  return created!;
}
