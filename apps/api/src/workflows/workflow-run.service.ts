import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  WorkflowNodeCommandSchema,
  WorkflowRunDetailSchema,
  WorkflowRunListSchema,
  createEntityId,
  type StartWorkflowRunInput,
  type TenantContext,
  type WorkflowGraph,
  type WorkflowNode,
  type WorkflowNodeCommand,
  type WorkflowNodeRunStatus,
  type WorkflowRunEventType,
  type WorkflowRunStatus,
} from "@yummyai/contracts";
import {
  amazonCustomWorkflowEvents,
  amazonCustomWorkflowSteps,
  amazonCustomWorkflows,
  productPlans,
  users,
  workflowArtifactLinks,
  workflowDefinitionVersions,
  workflowDefinitions,
  workflowNodeAttempts,
  workflowNodeRuns,
  workflowRunEvents,
  workflowRuns,
  type DatabaseConnection,
  type TenantTransaction,
  withTenant,
} from "@yummyai/database";
import { and, asc, desc, eq, inArray, ne } from "drizzle-orm";

import { DATABASE_CONNECTION } from "../platform.tokens.js";
import { AMAZON_CUSTOM_WORKFLOW_STABLE_KEY } from "./amazon-custom-workflow.blueprint.js";
import { WorkflowDefinitionService } from "./workflow-definition.service.js";
import { WorkflowExecutorRouter } from "./workflow-node.executor.js";

@Injectable()
export class WorkflowRunService {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(WorkflowDefinitionService) private readonly definitions: WorkflowDefinitionService,
    @Inject(WorkflowExecutorRouter) private readonly executors: WorkflowExecutorRouter,
  ) {}

  async list(context: TenantContext) {
    await this.ensureLegacyMigration(context);
    return withTenant(this.database.db, context, async (tx) => {
      const rows = await tx.select().from(workflowRuns).orderBy(desc(workflowRuns.updatedAt));
      if (!rows.length) return WorkflowRunListSchema.parse({ items: [] });
      const supporting = await loadRunSupportingData(tx, rows);
      return WorkflowRunListSchema.parse({
        items: rows.map((row) => runSummary(row, supporting)),
      });
    });
  }

  async get(context: TenantContext, id: string) {
    await this.ensureLegacyMigration(context);
    return withTenant(this.database.db, context, (tx) => loadRunDetail(tx, id));
  }

  async getByProductPlan(context: TenantContext, productPlanId: string) {
    await this.ensureLegacyMigration(context);
    const id = await withTenant(this.database.db, context, async (tx) => {
      const [row] = await tx
        .select({ id: workflowRuns.id })
        .from(workflowRuns)
        .where(eq(workflowRuns.productPlanId, productPlanId))
        .orderBy(desc(workflowRuns.updatedAt))
        .limit(1);
      return row?.id;
    });
    if (!id) throw new NotFoundException("Workflow run not found");
    return this.get(context, id);
  }

  async start(context: TenantContext, input: StartWorkflowRunInput) {
    await this.definitions.ensureOfficial(context);
    const created = await withTenant(this.database.db, context, async (tx) => {
      const [definition] = await tx
        .select()
        .from(workflowDefinitions)
        .where(eq(workflowDefinitions.id, input.definitionId))
        .limit(1);
      if (!definition?.currentPublishedVersionId || definition.status !== "published") {
        throw new BadRequestException("A published workflow definition is required");
      }
      const [version] = await tx
        .select()
        .from(workflowDefinitionVersions)
        .where(eq(workflowDefinitionVersions.id, definition.currentPublishedVersionId))
        .limit(1);
      if (!version) throw new BadRequestException("Published workflow version is missing");
      const [plan] = await tx
        .select()
        .from(productPlans)
        .where(eq(productPlans.id, input.productPlanId))
        .limit(1);
      if (!plan) throw new NotFoundException("Product plan not found");
      const [active] = await tx
        .select({ id: workflowRuns.id })
        .from(workflowRuns)
        .where(
          and(
            eq(workflowRuns.definitionId, definition.id),
            eq(workflowRuns.productPlanId, plan.id),
            ne(workflowRuns.status, "cancelled"),
          ),
        )
        .limit(1);
      if (active) throw new ConflictException("This product already has a run for the selected workflow");
      const startNode = version.graph.nodes.find((node) => node.kind === "start");
      if (!startNode) throw new BadRequestException("Published workflow has no start node");
      const firstNodeId = nextNodeId(version.graph, startNode.id, {});
      if (!firstNodeId) throw new BadRequestException("Published workflow cannot advance from start");
      const firstNode = version.graph.nodes.find((node) => node.id === firstNodeId)!;
      const now = new Date();
      const runId = createEntityId();
      const immediateComplete = firstNode.kind === "end";
      await tx.insert(workflowRuns).values({
        id: runId,
        tenantId: context.tenantId,
        definitionId: definition.id,
        definitionVersionId: version.id,
        productPlanId: plan.id,
        title: input.title ?? `${plan.name} — ${definition.name}`,
        status: immediateComplete ? "completed" : "active",
        currentNodeId: immediateComplete ? null : firstNodeId,
        revision: 1,
        startedBy: context.userId,
        startedAt: now,
        ...(immediateComplete ? { completedAt: now } : {}),
      });
      await tx.insert(workflowNodeRuns).values(
        version.graph.nodes.map((node) => ({
          id: createEntityId(),
          tenantId: context.tenantId,
          runId,
          nodeId: node.id,
          status:
            node.id === startNode.id || (immediateComplete && node.id === firstNodeId)
              ? ("completed" as const)
              : node.id === firstNodeId
                ? ("in_progress" as const)
                : ("not_started" as const),
          parameterSnapshot: {},
          updatedBy: context.userId,
          ...(node.id === startNode.id || node.id === firstNodeId ? { startedAt: now } : {}),
          ...(node.id === startNode.id || (immediateComplete && node.id === firstNodeId)
            ? { completedAt: now }
            : {}),
          updatedAt: now,
        })),
      );
      await tx.insert(workflowRunEvents).values({
        id: createEntityId(),
        tenantId: context.tenantId,
        runId,
        nodeId: firstNodeId,
        type: immediateComplete ? "run_completed" : "run_started",
        fromStatus: "not_started",
        toStatus: immediateComplete ? "completed" : "active",
        payload: { definitionVersion: version.version },
        actorUserId: context.userId,
        runRevision: 1,
        occurredAt: now,
      });
      return { runId, currentNode: immediateComplete ? undefined : firstNode };
    });
    if (created.currentNode?.kind === "internal_action") {
      await this.dispatchInternalNode(context, created.runId, created.currentNode);
    }
    return this.get(context, created.runId);
  }

  async command(context: TenantContext, runId: string, nodeId: string, raw: WorkflowNodeCommand) {
    const command = WorkflowNodeCommandSchema.parse(raw);
    const result = await withTenant(this.database.db, context, async (tx) => {
      const [run] = await tx.select().from(workflowRuns).where(eq(workflowRuns.id, runId)).limit(1);
      if (!run) throw new NotFoundException("Workflow run not found");
      if (run.revision !== command.expectedRevision) {
        throw new ConflictException("Workflow run changed; refresh before continuing");
      }
      const [version] = await tx
        .select()
        .from(workflowDefinitionVersions)
        .where(eq(workflowDefinitionVersions.id, run.definitionVersionId))
        .limit(1);
      const node = version?.graph.nodes.find((item) => item.id === nodeId);
      if (!version || !node) throw new NotFoundException("Workflow node not found");
      requireNodePermission(context, node, command);
      const [nodeRun] = await tx
        .select()
        .from(workflowNodeRuns)
        .where(and(eq(workflowNodeRuns.runId, run.id), eq(workflowNodeRuns.nodeId, nodeId)))
        .limit(1);
      if (!nodeRun) throw new NotFoundException("Workflow node run not found");
      const now = new Date();
      const revision = run.revision + 1;
      let eventType: WorkflowRunEventType;
      let nextStatus: WorkflowNodeRunStatus = nodeRun.status;
      let nextRunStatus: WorkflowRunStatus = run.status;
      let currentNodeId = run.currentNodeId;
      let eventNote: string | undefined;
      let activatedNode: WorkflowNode | undefined;

      if (command.type === "update_note") {
        await tx
          .update(workflowNodeRuns)
          .set({ note: command.note || null, updatedBy: context.userId, updatedAt: now })
          .where(eq(workflowNodeRuns.id, nodeRun.id));
        eventType = "node_note_updated";
        eventNote = command.note;
      } else if (command.type === "block") {
        assertStatus(nodeRun.status, ["in_progress"], command.type);
        nextStatus = "blocked";
        nextRunStatus = "blocked";
        eventType = "node_blocked";
        eventNote = command.reason;
        await tx
          .update(workflowNodeRuns)
          .set({ status: nextStatus, blockerReason: command.reason, note: command.reason, updatedBy: context.userId, updatedAt: now })
          .where(eq(workflowNodeRuns.id, nodeRun.id));
      } else if (command.type === "unblock") {
        assertStatus(nodeRun.status, ["blocked"], command.type);
        nextStatus = "in_progress";
        nextRunStatus = "active";
        eventType = "node_unblocked";
        await tx
          .update(workflowNodeRuns)
          .set({ status: nextStatus, blockerReason: null, updatedBy: context.userId, updatedAt: now })
          .where(eq(workflowNodeRuns.id, nodeRun.id));
      } else if (command.type === "retry") {
        assertStatus(nodeRun.status, ["failed"], command.type);
        if (node.kind !== "internal_action") throw new BadRequestException("Only failed internal actions can be retried");
        nextStatus = "in_progress";
        nextRunStatus = "active";
        eventType = "node_retried";
        activatedNode = node;
        await tx
          .update(workflowNodeRuns)
          .set({ status: nextStatus, blockerReason: null, updatedBy: context.userId, updatedAt: now })
          .where(eq(workflowNodeRuns.id, nodeRun.id));
      } else if (command.type === "cancel") {
        if (["completed", "cancelled"].includes(run.status)) throw new ConflictException("Workflow run is already terminal");
        nextStatus = "cancelled";
        nextRunStatus = "cancelled";
        currentNodeId = null;
        eventType = "run_cancelled";
        eventNote = command.reason;
        await tx
          .update(workflowNodeRuns)
          .set({ status: nextStatus, note: command.reason ?? nodeRun.note, updatedBy: context.userId, updatedAt: now })
          .where(eq(workflowNodeRuns.id, nodeRun.id));
      } else if (command.type === "reopen") {
        assertStatus(nodeRun.status, ["completed"], command.type);
        nextStatus = "in_progress";
        nextRunStatus = "active";
        currentNodeId = node.id;
        eventType = "node_reopened";
        eventNote = command.reason;
        await reopenFrom(tx, context, run.id, version.graph, node.id, now, command.reason);
        activatedNode = node.kind === "internal_action" ? node : undefined;
      } else if (command.type === "reject") {
        if (node.kind !== "approval_gate") throw new BadRequestException("Only approval gates can be rejected");
        assertStatus(nodeRun.status, ["in_progress"], command.type);
        const targetId = command.reworkTargetNodeId ?? node.reworkTargetNodeId;
        if (!targetId) throw new BadRequestException("Approval gate has no rework target");
        const target = version.graph.nodes.find((item) => item.id === targetId);
        if (!target) throw new BadRequestException("Rework target does not exist in this version");
        nextStatus = "not_started";
        nextRunStatus = "active";
        currentNodeId = targetId;
        eventType = "node_rejected";
        eventNote = command.reason;
        await reopenFrom(tx, context, run.id, version.graph, targetId, now, command.reason);
        await tx
          .update(workflowNodeRuns)
          .set({ status: "not_started", note: command.reason, blockerReason: null, completedAt: null, updatedBy: context.userId, updatedAt: now })
          .where(eq(workflowNodeRuns.id, nodeRun.id));
        activatedNode = target.kind === "internal_action" ? target : undefined;
      } else {
        const approval = command.type === "approve";
        if (approval && node.kind !== "approval_gate") throw new BadRequestException("Only approval gates can be approved");
        if (command.type === "start") {
          assertStatus(nodeRun.status, ["not_started"], command.type);
          if (run.currentNodeId !== node.id) throw new ConflictException("This node is not the current task");
          nextStatus = "in_progress";
          nextRunStatus = "active";
          eventType = "node_started";
          activatedNode = node.kind === "internal_action" ? node : undefined;
          await tx
            .update(workflowNodeRuns)
            .set({ status: nextStatus, startedAt: nodeRun.startedAt ?? now, updatedBy: context.userId, updatedAt: now })
            .where(eq(workflowNodeRuns.id, nodeRun.id));
        } else {
          assertStatus(nodeRun.status, ["in_progress"], command.type);
          nextStatus = "completed";
          eventType = approval ? "node_approved" : "node_completed";
          eventNote = "note" in command ? command.note : undefined;
          const parameters = command.type === "complete" ? command.parameters : {};
          const nextId = nextNodeId(version.graph, node.id, parameters);
          if (!nextId) throw new ConflictException("Workflow has no valid next node");
          const next = version.graph.nodes.find((item) => item.id === nextId)!;
          await tx
            .update(workflowNodeRuns)
            .set({
              status: "completed",
              note: eventNote ?? nodeRun.note,
              blockerReason: null,
              parameterSnapshot: command.type === "complete" ? command.parameters : nodeRun.parameterSnapshot,
              completedAt: now,
              startedAt: nodeRun.startedAt ?? now,
              updatedBy: context.userId,
              updatedAt: now,
            })
            .where(eq(workflowNodeRuns.id, nodeRun.id));
          if (node.kind === "condition_gate") {
            const selected = version.graph.edges.find((edge) => edge.source === node.id && edge.target === nextId);
            const unselectedTargets = version.graph.edges
              .filter((edge) => edge.source === node.id && edge.kind !== "rework" && edge.id !== selected?.id)
              .map((edge) => edge.target);
            if (unselectedTargets.length) {
              await tx
                .update(workflowNodeRuns)
                .set({ status: "skipped", updatedBy: context.userId, updatedAt: now })
                .where(and(eq(workflowNodeRuns.runId, run.id), inArray(workflowNodeRuns.nodeId, unselectedTargets)));
            }
          }
          if (next.kind === "end") {
            await tx
              .update(workflowNodeRuns)
              .set({ status: "completed", startedAt: now, completedAt: now, updatedBy: context.userId, updatedAt: now })
              .where(and(eq(workflowNodeRuns.runId, run.id), eq(workflowNodeRuns.nodeId, next.id)));
            nextRunStatus = "completed";
            currentNodeId = null;
          } else {
            await tx
              .update(workflowNodeRuns)
              .set({ status: "in_progress", startedAt: now, updatedBy: context.userId, updatedAt: now })
              .where(and(eq(workflowNodeRuns.runId, run.id), eq(workflowNodeRuns.nodeId, next.id)));
            nextRunStatus = "active";
            currentNodeId = next.id;
            activatedNode = next.kind === "internal_action" ? next : undefined;
          }
        }
      }

      await tx
        .update(workflowRuns)
        .set({
          status: nextRunStatus,
          currentNodeId,
          revision,
          ...(nextRunStatus === "completed" ? { completedAt: now } : { completedAt: null }),
          updatedAt: now,
        })
        .where(and(eq(workflowRuns.id, run.id), eq(workflowRuns.revision, command.expectedRevision)));
      await tx.insert(workflowRunEvents).values({
        id: createEntityId(),
        tenantId: context.tenantId,
        runId: run.id,
        nodeId: node.id,
        type: eventType!,
        fromStatus: nodeRun.status,
        toStatus: nextStatus,
        note: eventNote,
        payload: { command: command.type },
        actorUserId: context.userId,
        runRevision: revision,
        occurredAt: now,
      });
      return { activatedNode };
    });
    if (result.activatedNode) await this.dispatchInternalNode(context, runId, result.activatedNode);
    return this.get(context, runId);
  }

  async ensureLegacyMigration(context: TenantContext) {
    await this.definitions.ensureOfficial(context);
    await withTenant(this.database.db, context, async (tx) => {
      const [definition] = await tx
        .select()
        .from(workflowDefinitions)
        .where(eq(workflowDefinitions.stableKey, AMAZON_CUSTOM_WORKFLOW_STABLE_KEY))
        .limit(1);
      if (!definition?.currentPublishedVersionId) return;
      const [version] = await tx
        .select()
        .from(workflowDefinitionVersions)
        .where(eq(workflowDefinitionVersions.id, definition.currentPublishedVersionId))
        .limit(1);
      if (!version) return;
      const legacy = await tx.select().from(amazonCustomWorkflows);
      if (!legacy.length) return;
      const existing = await tx
        .select({ legacyId: workflowRuns.legacyAmazonWorkflowId })
        .from(workflowRuns)
        .where(inArray(workflowRuns.legacyAmazonWorkflowId, legacy.map((row) => row.id)));
      const migrated = new Set(existing.flatMap((row) => (row.legacyId ? [row.legacyId] : [])));
      for (const oldRun of legacy) {
        if (migrated.has(oldRun.id)) continue;
        const oldNodes = await tx
          .select()
          .from(amazonCustomWorkflowSteps)
          .where(eq(amazonCustomWorkflowSteps.workflowId, oldRun.id));
        const oldEvents = await tx
          .select()
          .from(amazonCustomWorkflowEvents)
          .where(eq(amazonCustomWorkflowEvents.workflowId, oldRun.id))
          .orderBy(asc(amazonCustomWorkflowEvents.occurredAt));
        const [plan] = await tx
          .select()
          .from(productPlans)
          .where(eq(productPlans.id, oldRun.productPlanId))
          .limit(1);
        if (!plan) continue;
        const runId = createEntityId();
        const runStatus = oldRun.status as WorkflowRunStatus;
        await tx.insert(workflowRuns).values({
          id: runId,
          tenantId: context.tenantId,
          definitionId: definition.id,
          definitionVersionId: version.id,
          productPlanId: oldRun.productPlanId,
          legacyAmazonWorkflowId: oldRun.id,
          title: `${plan.name} — Amazon Custom Trial`,
          status: runStatus,
          currentNodeId: oldRun.currentStepKey,
          revision: oldRun.revision,
          startedBy: oldRun.createdBy,
          startedAt: oldRun.createdAt,
          ...(oldRun.status === "completed" ? { completedAt: oldRun.updatedAt } : {}),
          createdAt: oldRun.createdAt,
          updatedAt: oldRun.updatedAt,
        });
        const oldNodeByKey = new Map(oldNodes.map((node) => [node.stepKey, node]));
        await tx.insert(workflowNodeRuns).values(
          version.graph.nodes.map((node) => {
            const old = oldNodeByKey.get(node.id as (typeof oldNodes)[number]["stepKey"]);
            const terminal = node.kind === "start" || (node.kind === "end" && oldRun.status === "completed");
            return {
              id: createEntityId(),
              tenantId: context.tenantId,
              runId,
              nodeId: node.id,
              status: terminal ? ("completed" as const) : old?.status ?? ("not_started" as const),
              note: old?.note,
              blockerReason: old?.status === "blocked" ? old.note : undefined,
              parameterSnapshot: {},
              updatedBy: old?.updatedBy,
              startedAt: node.kind === "start" ? oldRun.createdAt : old?.startedAt,
              completedAt: node.kind === "start" ? oldRun.createdAt : node.kind === "end" && terminal ? oldRun.updatedAt : old?.completedAt,
              updatedAt: old?.updatedAt ?? oldRun.updatedAt,
            };
          }),
        );
        if (oldEvents.length) {
          await tx.insert(workflowRunEvents).values(
            oldEvents.map((event) => ({
              id: event.id,
              tenantId: context.tenantId,
              runId,
              nodeId: event.stepKey,
              type: legacyEventType(event.action),
              fromStatus: event.fromStatus,
              toStatus: event.toStatus,
              note: event.note,
              payload: { legacyAmazonWorkflowId: oldRun.id },
              actorUserId: event.actorUserId,
              runRevision: event.workflowRevision,
              occurredAt: event.occurredAt,
            })),
          );
        }
      }
    });
  }

  private async dispatchInternalNode(context: TenantContext, runId: string, node: WorkflowNode) {
    const prepared = await withTenant(this.database.db, context, async (tx) => {
      const [nodeRun] = await tx
        .select()
        .from(workflowNodeRuns)
        .where(and(eq(workflowNodeRuns.runId, runId), eq(workflowNodeRuns.nodeId, node.id)))
        .limit(1);
      if (!nodeRun || nodeRun.status !== "in_progress") return undefined;
      const attemptNumber = nodeRun.attemptCount + 1;
      const attemptId = createEntityId();
      await tx
        .update(workflowNodeRuns)
        .set({ attemptCount: attemptNumber, updatedAt: new Date() })
        .where(eq(workflowNodeRuns.id, nodeRun.id));
      await tx.insert(workflowNodeAttempts).values({
        id: attemptId,
        tenantId: context.tenantId,
        nodeRunId: nodeRun.id,
        attemptNumber,
        status: "queued",
      });
      return { nodeRunId: nodeRun.id, attemptId };
    });
    if (!prepared) return;
    try {
      await this.executors.forNode(node).execute({ context, runId, nodeRunId: prepared.nodeRunId, node });
    } catch (error) {
      await withTenant(this.database.db, context, async (tx) => {
        const [run] = await tx.select().from(workflowRuns).where(eq(workflowRuns.id, runId)).limit(1);
        if (!run) return;
        const now = new Date();
        const revision = run.revision + 1;
        const message = error instanceof Error ? error.message : "Workflow queue is unavailable";
        await tx.update(workflowNodeAttempts).set({ status: "failed", errorCode: "QUEUE_UNAVAILABLE", errorMessage: message, finishedAt: now }).where(eq(workflowNodeAttempts.id, prepared.attemptId));
        await tx.update(workflowNodeRuns).set({ status: "failed", blockerReason: message, updatedAt: now }).where(eq(workflowNodeRuns.id, prepared.nodeRunId));
        await tx.update(workflowRuns).set({ status: "failed", revision, updatedAt: now }).where(eq(workflowRuns.id, runId));
        await tx.insert(workflowRunEvents).values({
          id: createEntityId(), tenantId: context.tenantId, runId, nodeId: node.id, type: "node_failed",
          fromStatus: "in_progress", toStatus: "failed", note: message, payload: {}, actorUserId: context.userId,
          runRevision: revision, occurredAt: now,
        });
      });
    }
  }
}

function requireNodePermission(context: TenantContext, node: WorkflowNode, command: WorkflowNodeCommand) {
  if (command.type === "approve" || command.type === "reject") {
    if (!context.permissions.includes("workflow:approve")) throw new ForbiddenException("workflow:approve is required");
  }
  if (node.requiredPermission && !context.permissions.includes(node.requiredPermission)) {
    throw new ForbiddenException(`${node.requiredPermission} is required for this node`);
  }
}

function assertStatus(status: WorkflowNodeRunStatus, allowed: WorkflowNodeRunStatus[], command: string) {
  if (!allowed.includes(status)) throw new ConflictException(`${command} is invalid while the node is ${status}`);
}

function nextNodeId(graph: WorkflowGraph, nodeId: string, parameters: Record<string, unknown>) {
  const node = graph.nodes.find((item) => item.id === nodeId);
  const outgoing = graph.edges.filter((edge) => edge.source === nodeId && edge.kind !== "rework");
  if (node?.kind === "condition_gate") {
    const conditionValue = typeof parameters.conditionValue === "string" ? parameters.conditionValue : undefined;
    return outgoing.find((edge) => edge.kind === "condition" && edge.conditionValue === conditionValue)?.target
      ?? outgoing.find((edge) => edge.kind === "default")?.target;
  }
  return outgoing.find((edge) => edge.kind === "success")?.target ?? outgoing[0]?.target;
}

async function reopenFrom(
  tx: TenantTransaction,
  context: TenantContext,
  runId: string,
  graph: WorkflowGraph,
  targetId: string,
  now: Date,
  reason?: string,
) {
  const targetIndex = graph.nodes.findIndex((node) => node.id === targetId);
  const downstream = graph.nodes
    .slice(targetIndex + 1)
    .filter((node) => !["start", "end"].includes(node.kind))
    .map((node) => node.id);
  if (downstream.length) {
    await tx
      .update(workflowNodeRuns)
      .set({ status: "not_started", blockerReason: null, completedAt: null, updatedBy: context.userId, updatedAt: now })
      .where(and(eq(workflowNodeRuns.runId, runId), inArray(workflowNodeRuns.nodeId, downstream)));
  }
  await tx
    .update(workflowNodeRuns)
    .set({ status: "in_progress", note: reason, blockerReason: null, completedAt: null, startedAt: now, updatedBy: context.userId, updatedAt: now })
    .where(and(eq(workflowNodeRuns.runId, runId), eq(workflowNodeRuns.nodeId, targetId)));
}

async function loadRunDetail(tx: TenantTransaction, id: string) {
  const [run] = await tx.select().from(workflowRuns).where(eq(workflowRuns.id, id)).limit(1);
  if (!run) throw new NotFoundException("Workflow run not found");
  const supporting = await loadRunSupportingData(tx, [run]);
  const nodeRows = await tx.select().from(workflowNodeRuns).where(eq(workflowNodeRuns.runId, run.id));
  const artifactRows = await tx.select().from(workflowArtifactLinks).where(eq(workflowArtifactLinks.runId, run.id));
  const eventRows = await tx.select().from(workflowRunEvents).where(eq(workflowRunEvents.runId, run.id)).orderBy(desc(workflowRunEvents.occurredAt)).limit(200);
  const actorIds = [...new Set(eventRows.flatMap((event) => event.actorUserId ? [event.actorUserId] : []))];
  const actorRows = actorIds.length ? await tx.select({ id: users.id, displayName: users.displayName }).from(users).where(inArray(users.id, actorIds)) : [];
  const actorNames = new Map(actorRows.map((actor) => [actor.id, actor.displayName] as const));
  const version = supporting.versionById.get(run.definitionVersionId);
  if (!version) throw new NotFoundException("Workflow definition version not found");
  const nodeById = new Map(nodeRows.map((node) => [node.nodeId, node] as const));
  return WorkflowRunDetailSchema.parse({
    ...runSummary(run, supporting),
    graph: version.graph,
    nodes: version.graph.nodes.map((node: WorkflowNode) => {
      const row = nodeById.get(node.id);
      if (!row) throw new NotFoundException(`Workflow node projection not found: ${node.id}`);
      return {
        id: row.id,
        nodeId: node.id,
        kind: node.kind,
        title: node.title,
        ownerRole: node.ownerRole,
        ...(node.requiredPermission ? { requiredPermission: node.requiredPermission } : {}),
        status: row.status,
        ...(row.note ? { note: row.note } : {}),
        ...(row.blockerReason ? { blockerReason: row.blockerReason } : {}),
        parameterSnapshot: row.parameterSnapshot,
        attemptCount: row.attemptCount,
        ...(row.startedAt ? { startedAt: row.startedAt.toISOString() } : {}),
        ...(row.completedAt ? { completedAt: row.completedAt.toISOString() } : {}),
        updatedAt: row.updatedAt.toISOString(),
      };
    }),
    artifacts: artifactRows.map((artifact) => ({
      id: artifact.id,
      nodeId: (nodeRows.find((node) => node.id === artifact.nodeRunId)?.nodeId ?? "unknown"),
      artifactType: artifact.artifactType,
      artifactId: artifact.artifactId,
      ...(artifact.artifactVersion ? { artifactVersion: artifact.artifactVersion } : {}),
      label: artifact.label,
      validationStatus: artifact.validationStatus,
      createdAt: artifact.createdAt.toISOString(),
    })),
    events: eventRows.map((event) => ({
      id: event.id,
      type: event.type,
      ...(event.nodeId ? { nodeId: event.nodeId } : {}),
      ...(event.fromStatus ? { fromStatus: event.fromStatus } : {}),
      ...(event.toStatus ? { toStatus: event.toStatus } : {}),
      ...(event.note ? { note: event.note } : {}),
      actorName: event.actorUserId ? actorNames.get(event.actorUserId) ?? "成员已移除" : "系统迁移",
      revision: event.runRevision,
      occurredAt: event.occurredAt.toISOString(),
    })),
  });
}

async function loadRunSupportingData(tx: TenantTransaction, rows: Array<typeof workflowRuns.$inferSelect>) {
  const definitionRows = await tx.select().from(workflowDefinitions).where(inArray(workflowDefinitions.id, [...new Set(rows.map((row) => row.definitionId))])) as Array<typeof workflowDefinitions.$inferSelect>;
  const versionRows = await tx.select().from(workflowDefinitionVersions).where(inArray(workflowDefinitionVersions.id, [...new Set(rows.map((row) => row.definitionVersionId))])) as Array<typeof workflowDefinitionVersions.$inferSelect>;
  const planRows = await tx.select().from(productPlans).where(inArray(productPlans.id, [...new Set(rows.map((row) => row.productPlanId))])) as Array<typeof productPlans.$inferSelect>;
  const nodeRows = await tx.select().from(workflowNodeRuns).where(inArray(workflowNodeRuns.runId, rows.map((row) => row.id))) as Array<typeof workflowNodeRuns.$inferSelect>;
  return {
    definitionById: new Map(definitionRows.map((row) => [row.id, row] as const)),
    versionById: new Map(versionRows.map((row) => [row.id, row] as const)),
    planById: new Map(planRows.map((row) => [row.id, row] as const)),
    nodesByRun: groupBy(nodeRows, (row) => row.runId),
  };
}

type WorkflowRunSupportingData = Awaited<ReturnType<typeof loadRunSupportingData>>;

function runSummary(run: typeof workflowRuns.$inferSelect, supporting: WorkflowRunSupportingData) {
  const definition = supporting.definitionById.get(run.definitionId);
  const version = supporting.versionById.get(run.definitionVersionId);
  const plan = supporting.planById.get(run.productPlanId);
  if (!definition || !version || !plan) throw new NotFoundException("Workflow run references missing supporting data");
  const nodeRows: Array<typeof workflowNodeRuns.$inferSelect> = supporting.nodesByRun.get(run.id) ?? [];
  const actionable = version.graph.nodes.filter((node: WorkflowNode) => !["start", "end"].includes(node.kind));
  const actionableIds = new Set(actionable.map((node: WorkflowNode) => node.id));
  const completed = nodeRows.filter((node) => actionableIds.has(node.nodeId) && ["completed", "skipped"].includes(node.status)).length;
  const current = version.graph.nodes.find((node: WorkflowNode) => node.id === run.currentNodeId);
  const latestBlocker = nodeRows.find((node) => node.status === "blocked")?.blockerReason;
  return {
    id: run.id,
    definitionId: run.definitionId,
    definitionVersionId: run.definitionVersionId,
    definitionName: definition.name,
    definitionVersion: version.version,
    productPlanId: run.productPlanId,
    productName: plan.name,
    title: run.title,
    status: run.status,
    ...(run.currentNodeId ? { currentNodeId: run.currentNodeId } : {}),
    ...(current ? { currentNodeTitle: current.title } : {}),
    completedNodes: completed,
    totalNodes: actionable.length,
    ...(latestBlocker ? { latestBlocker } : {}),
    revision: run.revision,
    updatedAt: run.updatedAt.toISOString(),
  };
}

function groupBy<T>(rows: T[], key: (row: T) => string) {
  const groups = new Map<string, T[]>();
  for (const row of rows) groups.set(key(row), [...(groups.get(key(row)) ?? []), row]);
  return groups;
}

function legacyEventType(action: string): WorkflowRunEventType {
  return ({
    workflow_started: "run_started",
    step_started: "node_started",
    step_blocked: "node_blocked",
    step_unblocked: "node_unblocked",
    step_completed: "node_completed",
    step_note_updated: "node_note_updated",
    step_reopened: "node_reopened",
  } as Record<string, WorkflowRunEventType>)[action] ?? "node_note_updated";
}
