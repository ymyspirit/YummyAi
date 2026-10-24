import { ForbiddenError, Permission } from "@yummyai/authz";
import {
  CatalogError,
  catalogFingerprint,
  type CatalogPackageService,
} from "@yummyai/catalog-core";
import { PodOwnerError, type PodArtworkOwner } from "@yummyai/pod-core";
import {
  CreatePodArtworkTaskInputSchema,
  PodExecutableToolKeySchema,
  createEntityId,
  type TenantContext,
  type WorkflowNode,
} from "@yummyai/contracts";
import {
  WORKFLOW_EXECUTOR_VERSION,
  WorkflowExecutionSnapshotSchema,
  type WorkflowExecutionSnapshot,
} from "@yummyai/contracts/workflow/execution";
import {
  loadCurrentMembershipContext,
  productPlans,
  workflowRuns,
  workflowNodeRuns,
  workflowNodeAttempts,
  workflowDefinitionVersions,
  workflowRunEvents,
  workflowArtifactLinks,
  withTenant,
  type DatabaseConnection,
  type TenantTransaction,
} from "@yummyai/database";
import { and, desc, eq, sql } from "drizzle-orm";
import { ZodError } from "zod";
import { completeWorkflowNode } from "./transition.js";
import { WorkflowExecutionError } from "./errors.js";
import { HarnessContractError } from "@yummyai/ai-core";
import { workflowHarness, assertWorkflowHarness } from "./harness.js";
import { assertWorkflowMethod, selectWorkflowMethod } from "./methods.js";

export type WorkflowAttemptRef = { runId: string; nodeRunId: string; attemptId: string };
type Attempt = typeof workflowNodeAttempts.$inferSelect;
type Run = typeof workflowRuns.$inferSelect;
type NodeRun = typeof workflowNodeRuns.$inferSelect;
type Locked = {
  run: Run;
  nodeRun: NodeRun;
  attempt: Attempt;
  node: WorkflowNode;
  graph: (typeof workflowDefinitionVersions.$inferSelect)["graph"];
};
type Claim = Locked & {
  context: TenantContext;
  snapshot: WorkflowExecutionSnapshot;
  token: string;
};
type Outcome = {
  artifactId: string;
  artifactType: "product_facts" | "product_package" | "design_version";
  checksum: string;
  label: string;
};
const scopeRank = { self: 0, team: 1, tenant: 2 };

export class WorkflowNodeRuntime {
  constructor(
    private readonly database: DatabaseConnection,
    private readonly catalog: CatalogPackageService,
    private readonly pod: PodArtworkOwner,
  ) {}

  async settleLegacy(context: TenantContext, ref: WorkflowAttemptRef) {
    return withTenant(this.database.db, context, async (tx) => {
      const locked = await loadLocked(tx, ref);
      if (
        !locked ||
        !isCurrent(locked) ||
        !["queued", "running", "waiting"].includes(locked.attempt.status) ||
        (locked.attempt.inputSnapshot && locked.attempt.requestedBy)
      )
        return false;
      const code = "WORKFLOW_LEGACY_INPUT_MISSING";
      await tx
        .update(workflowNodeAttempts)
        .set({
          status: "failed",
          errorCode: code,
          errorMessage: diagnostic(code),
          leaseToken: null,
          leaseExpiresAt: null,
          finishedAt: sql`clock_timestamp()`,
        })
        .where(eq(workflowNodeAttempts.id, ref.attemptId));
      await this.failNode(tx, locked.run, locked.nodeRun, locked.attempt.id, null, code);
      return true;
    });
  }

  /** Called inside the node activation transaction, before any queue side effect. */
  async prepare(
    tx: TenantTransaction,
    context: TenantContext,
    runId: string,
    node: WorkflowNode,
    override?: Record<string, unknown>,
  ): Promise<WorkflowAttemptRef | undefined> {
    if (node.kind !== "internal_action") return undefined;
    const [run] = await tx
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.id, runId))
      .for("update");
    const [nodeRun] = await tx
      .select()
      .from(workflowNodeRuns)
      .where(and(eq(workflowNodeRuns.runId, runId), eq(workflowNodeRuns.nodeId, node.id)))
      .for("update");
    if (
      !run ||
      !nodeRun ||
      run.currentNodeId !== node.id ||
      run.status !== "active" ||
      nodeRun.status !== "in_progress"
    )
      return undefined;
    const [previous] = await tx
      .select()
      .from(workflowNodeAttempts)
      .where(eq(workflowNodeAttempts.nodeRunId, nodeRun.id))
      .orderBy(desc(workflowNodeAttempts.attemptNumber))
      .limit(1);
    if (override !== undefined && previous) {
      const priorInput = WorkflowExecutionSnapshotSchema.safeParse(previous.inputSnapshot);
      if (priorInput.success && priorInput.data.input.kind === "pod") await this.pod.assertReconfigurationSafe(tx, context, priorInput.data.input.value.input.idempotencyKey);
    }
    if (previous && ["queued", "running", "waiting"].includes(previous.status)) {
      if (override === undefined) return { runId, nodeRunId: nodeRun.id, attemptId: previous.id };
      await tx
        .update(workflowNodeAttempts)
        .set({
          status: "cancelled",
          leaseToken: null,
          leaseExpiresAt: null,
          finishedAt: sql`clock_timestamp()`,
        })
        .where(eq(workflowNodeAttempts.id, previous.id));
    }
    const id = createEntityId(),
      number = nodeRun.attemptCount + 1;
    let snapshot: WorkflowExecutionSnapshot | undefined, failure: string | undefined;
    try {
      const reusable =
        override === undefined &&
        previous?.status === "failed" &&
        previous.inputSnapshot &&
        previous.requestedBy === context.userId
          ? WorkflowExecutionSnapshotSchema.parse(previous.inputSnapshot)
          : undefined;
      if (reusable && reusable.capabilityKey === node.config.capabilityKey) snapshot = reusable;
      else {
        const completed = await tx
          .select({ parameters: workflowNodeRuns.parameterSnapshot })
          .from(workflowNodeRuns)
          .where(and(eq(workflowNodeRuns.runId, runId), eq(workflowNodeRuns.status, "completed")))
          .orderBy(desc(workflowNodeRuns.completedAt));
        const inherited =
          completed.find(
            (row) => row.parameters.researchSnapshotId || row.parameters.researchItemId,
          )?.parameters ?? {};
        const parameters = {
          ...inherited,
          ...node.config.parameters,
          ...nodeRun.parameterSnapshot,
          ...override,
        };
        const capability = node.config.capabilityKey;
        if (
          capability === "yummyai.custom_product.generate_provisional_facts" ||
          capability === "yummyai.custom_product.export_package"
        ) {
          const value = await this.catalog.prepareOperation(
            tx,
            context,
            run.productPlanId,
            capability.endsWith("generate_provisional_facts") ? "profile" : "package",
            parameters,
            id,
          );
          snapshot = {
            executorVersion: WORKFLOW_EXECUTOR_VERSION,
            capabilityKey: capability,
            dataScope: context.dataScope,
            input: { kind: "catalog", value },
            requiredPermissions: [],
          };
        } else if (capability?.startsWith("pod.")) {
          const toolKey = PodExecutableToolKeySchema.parse(capability.slice(4));
          const input = CreatePodArtworkTaskInputSchema.parse({
            idempotencyKey: id,
            toolKey,
            title: parameters.title ?? node.title,
            skuId: parameters.skuId,
            inputAssetIds: parameters.inputAssetIds ?? [],
            parameterSnapshot: parameters.parameterSnapshot,
          });
          const value = await this.pod.prepareOperation(tx, context, run.productPlanId, input);
          snapshot = {
            executorVersion: WORKFLOW_EXECUTOR_VERSION,
            capabilityKey: capability,
            dataScope: context.dataScope,
            input: { kind: "pod", value },
            requiredPermissions: [],
          };
        } else throw new WorkflowExecutionError("WORKFLOW_CAPABILITY_UNSUPPORTED");
        snapshot.requiredPermissions = requiredPermissions(snapshot, node);
        const harness = workflowHarness(snapshot.capabilityKey);
        snapshot.executionContract = harness.registry.pin(harness.skill);
        snapshot.methodSelection = await selectWorkflowMethod(tx, context, snapshot);
      }
      assertWorkflowHarness(snapshot.capabilityKey, snapshot.executionContract, snapshot.input.value);
      assertPermissions(context, snapshot, node);
      await assertWorkflowMethod(tx, context, snapshot, { lock: true });
      snapshot = WorkflowExecutionSnapshotSchema.parse(snapshot);
    } catch (error) {
      if (!(
        error instanceof WorkflowExecutionError ||
        error instanceof CatalogError ||
        error instanceof PodOwnerError ||
        error instanceof ForbiddenError ||
        error instanceof ZodError
      ))
        throw error;
      failure =
        error instanceof WorkflowExecutionError
          ? error.code
          : error instanceof ForbiddenError
            ? "WORKFLOW_ACCESS_REVOKED"
            : "WORKFLOW_INPUT_INVALID";
    }
    await tx
      .update(workflowNodeRuns)
      .set({ attemptCount: number, updatedAt: sql`clock_timestamp()` })
      .where(eq(workflowNodeRuns.id, nodeRun.id));
    await tx
      .insert(workflowNodeAttempts)
      .values({
        id,
        tenantId: context.tenantId,
        nodeRunId: nodeRun.id,
        attemptNumber: number,
        status: failure ? "failed" : "queued",
        requestedBy: context.userId,
        inputSnapshot: failure ? null : snapshot,
        inputChecksum: failure ? null : catalogFingerprint(snapshot),
        errorCode: failure ?? null,
        errorMessage: failure ? diagnostic(failure) : null,
        ...(failure ? { finishedAt: sql`clock_timestamp()` } : {}),
      });
    if (failure) {
      await this.failNode(tx, run, nodeRun, id, context.userId, failure);
      return undefined;
    }
    return { runId, nodeRunId: nodeRun.id, attemptId: id };
  }

  async execute(base: Pick<TenantContext, "tenantId" | "userId">, ref: WorkflowAttemptRef) {
    const context: TenantContext = { ...base, permissions: [], dataScope: "tenant" };
    const claim = await this.claim(context, ref);
    if (!claim) return { state: "skipped" };
    const guard = async (tx: TenantTransaction) => {
      await this.guard(tx, claim);
    };
    try {
      const harness = assertWorkflowHarness(claim.snapshot.capabilityKey, claim.snapshot.executionContract, claim.snapshot.input.value);
      let outcome: Outcome;
      if (claim.snapshot.input.kind === "catalog") {
        const input = claim.snapshot.input.value;
        if (input.operation === "profile") {
          const result = await this.catalog.executePreparedProfile(claim.context, input, guard);
          outcome = {
            artifactId: result.receiptId,
            artifactType: "product_facts",
            checksum: catalogFingerprint(result.profile),
            label: "待核实产品事实",
          };
        } else {
          const result = await this.catalog.executePreparedExport(claim.context, input, guard);
          outcome = {
            artifactId: result.receiptId,
            artifactType: "product_package",
            checksum: String(result.sha256),
            label: input.mode === "release" ? "产品包正式导出" : "产品包草稿",
          };
        }
      } else {
        const input = claim.snapshot.input.value;
        const priorId = claim.attempt.outputSnapshot?.delegatedTaskId;
        const task =
          typeof priorId === "string"
            ? await this.pod.get(claim.context, priorId)
            : await this.pod.create(claim.context, input.input, {
                pinned: input,
                guard,
                deferDispatch: true,
                onCreated: async (tx, taskId) => {
                  await tx
                    .update(workflowNodeAttempts)
                    .set({ outputSnapshot: { delegatedTaskId: taskId } })
                    .where(eq(workflowNodeAttempts.id, claim.attempt.id));
                },
              });
        if (["queued", "running"].includes(task.status)) {
          harness.registry.checkOutput(claim.snapshot.executionContract, harness.skill, harness.toolKey, { delegatedTaskId: task.id, state: "waiting" });
          let queueFailed = false;
          if (task.status === "queued") {
            await withTenant(this.database.db, claim.context, guard);
            try {
              await this.pod.dispatchPending(claim.context, task.id);
            } catch {
              queueFailed = true;
            }
          }
          return this.wait(claim, task.id, queueFailed ? "WORKFLOW_POD_QUEUE_UNAVAILABLE" : null);
        }
        if (
          !["awaiting_review", "approved", "partially_succeeded"].includes(task.status) ||
          !task.resultVersionId
        )
          throw new WorkflowExecutionError("WORKFLOW_POD_TASK_FAILED");
        outcome = {
          artifactId: task.resultVersionId,
          artifactType: "design_version",
          checksum: catalogFingerprint({ taskId: task.id, versionId: task.resultVersionId }),
          label: "POD 设计结果待审核",
        };
      }
      harness.registry.checkOutput(claim.snapshot.executionContract, harness.skill, harness.toolKey, outcome);
      return await this.finish(claim, outcome);
    } catch (error) {
      if (error instanceof WorkflowExecutionError && error.code === "WORKFLOW_LEASE_LOST")
        return { state: "fenced" };
      const code =
        error instanceof HarnessContractError ? "WORKFLOW_OUTPUT_INVALID" :
        error instanceof WorkflowExecutionError
          ? error.code
          : error instanceof ForbiddenError
            ? "WORKFLOW_ACCESS_REVOKED"
            : error instanceof CatalogError && error.status === 422
              ? "WORKFLOW_QUALITY_BLOCKED"
              : error instanceof CatalogError ||
                  error instanceof PodOwnerError ||
                  error instanceof ZodError
                ? "WORKFLOW_INPUT_CHANGED"
                : "WORKFLOW_EXECUTION_UNAVAILABLE";
      return this.fail(
        claim,
        code,
        error instanceof WorkflowExecutionError
          ? error.retryable
          : code === "WORKFLOW_EXECUTION_UNAVAILABLE",
      );
    }
  }

  private async claim(context: TenantContext, ref: WorkflowAttemptRef): Promise<Claim | undefined> {
    return withTenant(this.database.db, context, async (tx) => {
      const locked = await loadLocked(tx, ref);
      if (!locked || locked.attempt.requestedBy !== context.userId || !isCurrent(locked))
        return undefined;
      const now = await workflowDatabaseNow(tx),
        attempt = locked.attempt;
      if (
        ["failed", "completed", "cancelled"].includes(attempt.status) ||
        attempt.nextAttemptAt > now
      )
        return undefined;
      if (attempt.status === "running" && attempt.leaseExpiresAt && attempt.leaseExpiresAt > now)
        return undefined;
      let snapshot: WorkflowExecutionSnapshot, current: TenantContext;
      try {
        snapshot = parseSnapshot(locked);
        current = await currentWorkflowContext(tx, context);
        assertPermissions(current, snapshot, locked.node);
        assertPlanScope(current, await currentPlan(tx, locked.run.productPlanId));
        await assertWorkflowMethod(tx, current, snapshot);
        if (attempt.status === "running" && attempt.recoveryCount >= 3)
          throw new WorkflowExecutionError("WORKFLOW_RECOVERY_EXHAUSTED");
        if (now.getTime() - attempt.queuedAt.getTime() > 24 * 3600_000)
          throw new WorkflowExecutionError("WORKFLOW_ATTEMPT_EXPIRED");
      } catch (error) {
        if (!(
          error instanceof WorkflowExecutionError ||
          error instanceof ForbiddenError ||
          error instanceof ZodError
        ))
          throw error;
        const code =
          error instanceof WorkflowExecutionError ? error.code : "WORKFLOW_ACCESS_REVOKED";
        await tx
          .update(workflowNodeAttempts)
          .set({
            status: "failed",
            errorCode: code,
            errorMessage: diagnostic(code),
            leaseToken: null,
            leaseExpiresAt: null,
            finishedAt: now,
          })
          .where(eq(workflowNodeAttempts.id, attempt.id));
        await this.failNode(tx, locked.run, locked.nodeRun, attempt.id, context.userId, code);
        return undefined;
      }
      const token = createEntityId(), harness = workflowHarness(snapshot.capabilityKey);
      await tx
        .update(workflowNodeAttempts)
        .set({
          status: "running",
          leaseToken: token,
          leaseExpiresAt: new Date(now.getTime() + harness.registry.descriptor(snapshot.executionContract, harness.skill, harness.toolKey).timeout.milliseconds),
          recoveryCount: attempt.recoveryCount + (attempt.status === "running" ? 1 : 0),
          startedAt: attempt.startedAt ?? now,
        })
        .where(eq(workflowNodeAttempts.id, attempt.id));
      return { ...locked, context: current, snapshot, token };
    });
  }

  private async guard(tx: TenantTransaction, claim: Claim) {
    const ref = { runId: claim.run.id, nodeRunId: claim.nodeRun.id, attemptId: claim.attempt.id };
    const locked = await loadLocked(tx, ref),
      now = await workflowDatabaseNow(tx);
    if (
      !locked ||
      !isCurrent(locked) ||
      locked.attempt.status !== "running" ||
      locked.attempt.leaseToken !== claim.token ||
      !locked.attempt.leaseExpiresAt ||
      locked.attempt.leaseExpiresAt <= now
    )
      throw new WorkflowExecutionError("WORKFLOW_LEASE_LOST");
    const context = await loadCurrentMembershipContext(tx, claim.context, { lock: true });
    const snapshot = parseSnapshot(locked);
    assertPermissions(context, snapshot, locked.node);
    assertPlanScope(context, await currentPlan(tx, locked.run.productPlanId));
    await assertWorkflowMethod(tx, context, snapshot, { lock: true });
    return { ...locked, context, now };
  }

  private async finish(claim: Claim, outcome: Outcome) {
    return withTenant(this.database.db, claim.context, async (tx) => {
      const current = await this.guard(tx, claim);
      if (claim.snapshot.input.kind === "catalog")
        await this.catalog.assertPreparedCurrent(
          tx,
          current.context,
          claim.snapshot.input.value,
          outcome.artifactType === "product_facts" ? outcome.checksum : undefined,
        );
      else await this.pod.assertPreparedCurrent(tx, current.context, claim.snapshot.input.value);
      const advanced = await completeWorkflowNode(
        tx,
        current.context,
        current.run.id,
        current.graph,
        current.node,
        current.nodeRun,
        { parameters: {}, parameterSnapshot: current.nodeRun.parameterSnapshot },
        current.now,
      );
      const revision = current.run.revision + 1;
      await tx
        .update(workflowRuns)
        .set({
          status: advanced.nextRunStatus,
          currentNodeId: advanced.currentNodeId,
          revision,
          completedAt: advanced.nextRunStatus === "completed" ? current.now : null,
          updatedAt: current.now,
        })
        .where(eq(workflowRuns.id, current.run.id));
      await tx
        .update(workflowNodeAttempts)
        .set({
          status: "completed",
          outputSnapshot: { ...current.attempt.outputSnapshot, ...outcome },
          leaseToken: null,
          leaseExpiresAt: null,
          errorCode: null,
          errorMessage: null,
          finishedAt: current.now,
        })
        .where(eq(workflowNodeAttempts.id, current.attempt.id));
      const [existing] = await tx
        .select({ id: workflowArtifactLinks.id })
        .from(workflowArtifactLinks)
        .where(
          and(
            eq(workflowArtifactLinks.nodeRunId, current.nodeRun.id),
            eq(workflowArtifactLinks.artifactId, outcome.artifactId),
            eq(workflowArtifactLinks.artifactType, outcome.artifactType),
          ),
        )
        .limit(1);
      if (!existing)
        await tx
          .insert(workflowArtifactLinks)
          .values({
            id: createEntityId(),
            tenantId: current.context.tenantId,
            runId: current.run.id,
            nodeRunId: current.nodeRun.id,
            artifactType: outcome.artifactType,
            artifactId: outcome.artifactId,
            artifactVersion: outcome.checksum,
            label: outcome.label,
            validationStatus: "pending",
          });
      await tx
        .insert(workflowRunEvents)
        .values({
          id: createEntityId(),
          tenantId: current.context.tenantId,
          runId: current.run.id,
          nodeId: current.node.id,
          type: "node_completed",
          fromStatus: "in_progress",
          toStatus: "completed",
          actorUserId: current.context.userId,
          runRevision: revision,
          payload: {
            attemptId: current.attempt.id,
            artifactId: outcome.artifactId,
            checksum: outcome.checksum,
          },
          occurredAt: current.now,
        });
      const next = advanced.activatedNode
        ? await this.prepare(tx, current.context, current.run.id, advanced.activatedNode)
        : undefined;
      return { state: "completed", next };
    });
  }

  private async wait(claim: Claim, taskId: string, errorCode: string | null) {
    return withTenant(this.database.db, claim.context, async (tx) => {
      const current = await this.guard(tx, claim);
      await tx
        .update(workflowNodeAttempts)
        .set({
          status: "waiting",
          outputSnapshot: { delegatedTaskId: taskId },
          leaseToken: null,
          leaseExpiresAt: null,
          errorCode,
          errorMessage: errorCode ? diagnostic(errorCode) : null,
          nextAttemptAt: new Date(current.now.getTime() + 60_000),
        })
        .where(eq(workflowNodeAttempts.id, claim.attempt.id));
      return { state: "waiting" };
    });
  }

  private async fail(claim: Claim, code: string, retryable: boolean) {
    return withTenant(this.database.db, claim.context, async (tx) => {
      const locked = await loadLocked(tx, {
          runId: claim.run.id,
          nodeRunId: claim.nodeRun.id,
          attemptId: claim.attempt.id,
        }),
        now = await workflowDatabaseNow(tx);
      if (
        !locked ||
        !isCurrent(locked) ||
        locked.attempt.leaseToken !== claim.token ||
        locked.attempt.status !== "running" ||
        !locked.attempt.leaseExpiresAt ||
        locked.attempt.leaseExpiresAt <= now
      )
        return { state: "fenced" };
      const queued = retryable && locked.attempt.recoveryCount < 3;
      await tx
        .update(workflowNodeAttempts)
        .set({
          status: queued ? "queued" : "failed",
          errorCode: code,
          errorMessage: diagnostic(code),
          leaseToken: null,
          leaseExpiresAt: null,
          recoveryCount: Math.min(3, locked.attempt.recoveryCount + (queued ? 1 : 0)),
          nextAttemptAt: new Date(now.getTime() + 60_000),
          finishedAt: queued ? null : now,
        })
        .where(eq(workflowNodeAttempts.id, claim.attempt.id));
      if (!queued)
        await this.failNode(
          tx,
          locked.run,
          locked.nodeRun,
          locked.attempt.id,
          claim.context.userId,
          code,
        );
      return { state: queued ? "queued" : "failed" };
    });
  }

  private async failNode(
    tx: TenantTransaction,
    run: Run,
    nodeRun: NodeRun,
    attemptId: string,
    actor: string | null,
    code: string,
  ) {
    const now = await workflowDatabaseNow(tx),
      revision = run.revision + 1;
    await tx
      .update(workflowNodeRuns)
      .set({ status: "failed", blockerReason: diagnostic(code), updatedAt: now })
      .where(eq(workflowNodeRuns.id, nodeRun.id));
    await tx
      .update(workflowRuns)
      .set({ status: "failed", revision, updatedAt: now })
      .where(eq(workflowRuns.id, run.id));
    await tx
      .insert(workflowRunEvents)
      .values({
        id: createEntityId(),
        tenantId: run.tenantId,
        runId: run.id,
        nodeId: nodeRun.nodeId,
        type: "node_failed",
        fromStatus: nodeRun.status,
        toStatus: "failed",
        note: diagnostic(code),
        actorUserId: actor,
        runRevision: revision,
        payload: { attemptId, code },
        occurredAt: now,
      });
  }
}

async function loadLocked(
  tx: TenantTransaction,
  ref: WorkflowAttemptRef,
): Promise<Locked | undefined> {
  const [run] = await tx
    .select()
    .from(workflowRuns)
    .where(eq(workflowRuns.id, ref.runId))
    .for("update");
  if (!run) return undefined;
  const [nodeRun] = await tx
    .select()
    .from(workflowNodeRuns)
    .where(and(eq(workflowNodeRuns.id, ref.nodeRunId), eq(workflowNodeRuns.runId, ref.runId)))
    .for("update");
  const [attempt] = await tx
    .select()
    .from(workflowNodeAttempts)
    .where(
      and(
        eq(workflowNodeAttempts.id, ref.attemptId),
        eq(workflowNodeAttempts.nodeRunId, ref.nodeRunId),
      ),
    )
    .for("update");
  const [version] = await tx
    .select()
    .from(workflowDefinitionVersions)
    .where(eq(workflowDefinitionVersions.id, run.definitionVersionId))
    .limit(1);
  const node = version?.graph.nodes.find((item) => item.id === nodeRun?.nodeId);
  return nodeRun && attempt && version && node?.kind === "internal_action"
    ? { run, nodeRun, attempt, graph: version.graph, node }
    : undefined;
}
function isCurrent(locked: Locked) {
  return (
    locked.run.status === "active" &&
    locked.run.currentNodeId === locked.node.id &&
    locked.nodeRun.status === "in_progress" &&
    locked.attempt.attemptNumber === locked.nodeRun.attemptCount
  );
}
function parseSnapshot(locked: Locked) {
  if (!locked.attempt.inputSnapshot || !locked.attempt.inputChecksum)
    throw new WorkflowExecutionError("WORKFLOW_LEGACY_INPUT_MISSING");
  const parsed = WorkflowExecutionSnapshotSchema.parse(locked.attempt.inputSnapshot);
  assertWorkflowHarness(parsed.capabilityKey, parsed.executionContract, parsed.input.value);
  if (
    catalogFingerprint(parsed) !== locked.attempt.inputChecksum ||
    parsed.capabilityKey !== locked.node.config.capabilityKey
  )
    throw new WorkflowExecutionError("WORKFLOW_INPUT_CHANGED");
  return parsed;
}
function requiredPermissions(snapshot: WorkflowExecutionSnapshot, node: WorkflowNode) {
  const harness = workflowHarness(snapshot.capabilityKey);
  const permissions: string[] = [...harness.registry.descriptor(harness.registry.pin(harness.skill), harness.skill, harness.toolKey).requiredPermissions];
  if (snapshot.input.kind === "catalog") {
    if (snapshot.input.value.operation === "profile" || snapshot.input.value.sources.length)
      permissions.push(Permission.ResearchRead);
  }
  if (node.requiredPermission) permissions.push(node.requiredPermission);
  return [...new Set(permissions)].sort();
}
function assertPermissions(
  context: TenantContext,
  snapshot: WorkflowExecutionSnapshot,
  node: WorkflowNode,
) {
  const required = requiredPermissions(snapshot, node);
  if (
    scopeRank[context.dataScope] < scopeRank[snapshot.dataScope] ||
    required.some((permission) => !context.permissions.includes(permission)) ||
    required.some((permission) => !snapshot.requiredPermissions.includes(permission))
  )
    throw new WorkflowExecutionError("WORKFLOW_ACCESS_REVOKED");
}
function assertPlanScope(
  context: TenantContext,
  plan: typeof productPlans.$inferSelect | undefined,
) {
  if (
    !plan ||
    plan.status === "archived" ||
    (context.dataScope !== "tenant" && plan.createdBy !== context.userId)
  )
    throw new WorkflowExecutionError("WORKFLOW_PRODUCT_SCOPE_CHANGED");
}
async function currentPlan(tx: TenantTransaction, id: string) {
  return (await tx.select().from(productPlans).where(eq(productPlans.id, id)).limit(1))[0];
}
export async function workflowDatabaseNow(tx: TenantTransaction) {
  const rows = await tx.execute<{ now: string }>(sql`select clock_timestamp()::text as now`);
  return new Date(rows[0]!.now);
}
export async function currentWorkflowContext(
  tx: TenantTransaction,
  base: Pick<TenantContext, "tenantId" | "userId">,
): Promise<TenantContext> {
  return loadCurrentMembershipContext(tx, base);
}
function diagnostic(code: string) {
  const labels: Record<string, string> = {
    WORKFLOW_INPUT_INVALID: "节点缺少有效业务输入，请补齐研究快照或商品/素材参数后重试",
    WORKFLOW_INPUT_CHANGED: "节点固定的商品、素材或执行输入已变化，请核对后重新配置",
    WORKFLOW_QUALITY_BLOCKED: "产品包缺少已核实事实或授权素材，请在商品模块补齐并复核后导出",
    WORKFLOW_ACCESS_REVOKED: "当前权限或数据范围已变化，任务已停止",
    WORKFLOW_LEGACY_INPUT_MISSING: "旧任务缺少执行快照，未使用当前数据自动补填，请人工核对后重试",
    WORKFLOW_CONTRACT_MISSING: "旧任务缺少工具与执行方法快照，未自动补填；请核对原操作后明确重新配置",
    WORKFLOW_CONTRACT_CHANGED: "工具或执行方法契约无法核验，节点已停止，请核对固定版本后处理",
    WORKFLOW_METHOD_UNAVAILABLE: "已固定的方法、撤回状态或知识依据不可用，节点已停止；请核对原回执或子任务后处理",
    WORKFLOW_OUTPUT_INVALID: "业务返回的产物不满足工具契约，未推进节点；请核对原回执或子任务",
    WORKFLOW_POD_TASK_FAILED: "POD 任务未形成可用结果，请在原任务处理，工作流不会重新创建付费请求",
    WORKFLOW_POD_QUEUE_UNAVAILABLE: "POD 派发暂不可用，保留原任务等待恢复",
  };
  return labels[code] ?? "节点执行未完成，请检查执行记录后处理";
}
