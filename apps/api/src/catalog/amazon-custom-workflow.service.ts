import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import {
  AMAZON_CUSTOM_WORKFLOW_STEPS,
  AmazonCustomWorkflowDetailSchema,
  AmazonCustomWorkflowStepKeySchema,
  AmazonCustomWorkflowWorkspaceSchema,
  TransitionAmazonCustomWorkflowStepInputSchema,
  UpdateAmazonCustomWorkflowStepNoteInputSchema,
  createEntityId,
  type AmazonCustomWorkflowDetail,
  type AmazonCustomWorkflowEventAction,
  type AmazonCustomWorkflowStepKey,
  type AmazonCustomWorkflowStepStatus,
  type AmazonCustomWorkflowSummary,
  type TenantContext,
  type TransitionAmazonCustomWorkflowStepInput,
  type UpdateAmazonCustomWorkflowStepNoteInput,
} from "@yummyai/contracts";
import {
  amazonCustomWorkflowEvents,
  amazonCustomWorkflowSteps,
  amazonCustomWorkflows,
  productPlans,
  skus,
  spus,
  users,
  type DatabaseConnection,
  withTenant,
} from "@yummyai/database";
import { and, asc, desc, eq, inArray } from "drizzle-orm";

import { AuditService } from "../audit/audit.service.js";
import { DATABASE_CONNECTION } from "../platform.tokens.js";

@Injectable()
export class AmazonCustomWorkflowService {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Optional() @Inject(AuditService) private readonly audit?: AuditService,
  ) {}

  async list(context: TenantContext) {
    const items = await withTenant(this.database.db, context, async (tx) => {
      const planRows = await tx.select().from(productPlans).orderBy(desc(productPlans.updatedAt));
      if (!planRows.length) return [];
      const planIds = planRows.map((plan) => plan.id);
      const workflowRows = await tx
        .select()
        .from(amazonCustomWorkflows)
        .where(inArray(amazonCustomWorkflows.productPlanId, planIds));
      const workflowIds = workflowRows.map((workflow) => workflow.id);
      const stepRows = workflowIds.length
        ? await tx
            .select()
            .from(amazonCustomWorkflowSteps)
            .where(inArray(amazonCustomWorkflowSteps.workflowId, workflowIds))
        : [];
      const spuRows = await tx.select().from(spus).where(inArray(spus.productPlanId, planIds));
      const spuIds = spuRows.map((spu) => spu.id);
      const skuRows = spuIds.length
        ? await tx.select().from(skus).where(inArray(skus.spuId, spuIds))
        : [];
      const userIds = [
        ...new Set(planRows.flatMap((plan) => (plan.createdBy ? [plan.createdBy] : []))),
      ];
      const userRows = userIds.length
        ? await tx
            .select({ id: users.id, displayName: users.displayName })
            .from(users)
            .where(inArray(users.id, userIds))
        : [];
      const userNames = new Map(userRows.map((user) => [user.id, user.displayName]));
      const workflowByPlan = new Map(
        workflowRows.map((workflow) => [workflow.productPlanId, workflow]),
      );
      const stepsByWorkflow = groupBy(stepRows, (step) => step.workflowId);
      const spuByPlan = new Map(spuRows.map((spu) => [spu.productPlanId, spu]));
      const skusBySpu = groupBy(skuRows, (sku) => sku.spuId);

      return planRows.map((plan) => {
        const workflow = workflowByPlan.get(plan.id);
        const planSpu = spuByPlan.get(plan.id);
        return summaryFromRows({
          plan,
          workflow,
          steps: workflow ? (stepsByWorkflow.get(workflow.id) ?? []) : [],
          ownerName: plan.createdBy ? userNames.get(plan.createdBy) : undefined,
          spuCode: planSpu?.code,
          skuCodes: planSpu
            ? (skusBySpu.get(planSpu.id) ?? []).map((sku) => sku.code).sort()
            : [],
        });
      });
    });
    return AmazonCustomWorkflowWorkspaceSchema.parse({ items });
  }

  async get(context: TenantContext, planId: string): Promise<AmazonCustomWorkflowDetail> {
    const detail = await withTenant(this.database.db, context, async (tx) => {
      const [plan] = await tx
        .select()
        .from(productPlans)
        .where(eq(productPlans.id, planId))
        .limit(1);
      if (!plan) throw new NotFoundException("Product plan not found");
      const [workflow] = await tx
        .select()
        .from(amazonCustomWorkflows)
        .where(eq(amazonCustomWorkflows.productPlanId, plan.id))
        .limit(1);
      const [planSpu] = await tx
        .select()
        .from(spus)
        .where(eq(spus.productPlanId, plan.id))
        .limit(1);
      const skuRows = planSpu
        ? await tx.select().from(skus).where(eq(skus.spuId, planSpu.id))
        : [];
      const stepRows = workflow
        ? await tx
            .select()
            .from(amazonCustomWorkflowSteps)
            .where(eq(amazonCustomWorkflowSteps.workflowId, workflow.id))
        : [];
      const eventRows = workflow
        ? await tx
            .select()
            .from(amazonCustomWorkflowEvents)
            .where(eq(amazonCustomWorkflowEvents.workflowId, workflow.id))
            .orderBy(desc(amazonCustomWorkflowEvents.occurredAt))
            .limit(50)
        : [];
      const userIds = [
        ...new Set(
          [
            plan.createdBy,
            ...stepRows.map((step) => step.updatedBy),
            ...eventRows.map((event) => event.actorUserId),
          ].filter((id): id is string => Boolean(id)),
        ),
      ];
      const userRows = userIds.length
        ? await tx
            .select({ id: users.id, displayName: users.displayName })
            .from(users)
            .where(inArray(users.id, userIds))
        : [];
      const userNames = new Map(userRows.map((user) => [user.id, user.displayName]));
      const summary = summaryFromRows({
        plan,
        workflow,
        steps: stepRows,
        ownerName: plan.createdBy ? userNames.get(plan.createdBy) : undefined,
        spuCode: planSpu?.code,
        skuCodes: skuRows.map((sku) => sku.code).sort(),
      });
      const stepByKey = new Map(stepRows.map((step) => [step.stepKey, step]));

      return {
        ...summary,
        steps: AMAZON_CUSTOM_WORKFLOW_STEPS.map((definition) => {
          const row = stepByKey.get(definition.key);
          return {
            ...definition,
            status: row?.status ?? "not_started",
            ...(row?.note ? { note: row.note } : {}),
            ...(row?.startedAt ? { startedAt: row.startedAt.toISOString() } : {}),
            ...(row?.completedAt ? { completedAt: row.completedAt.toISOString() } : {}),
            ...(row ? { updatedAt: row.updatedAt.toISOString() } : {}),
            ...(row?.updatedBy
              ? { updatedByName: userNames.get(row.updatedBy) ?? "成员已移除" }
              : {}),
          };
        }),
        events: eventRows.map((event) => ({
          id: event.id,
          stepKey: event.stepKey,
          action: event.action,
          fromStatus: event.fromStatus,
          toStatus: event.toStatus,
          ...(event.note ? { note: event.note } : {}),
          actorName: event.actorUserId
            ? (userNames.get(event.actorUserId) ?? "成员已移除")
            : "系统",
          revision: event.workflowRevision,
          occurredAt: event.occurredAt.toISOString(),
        })),
      };
    });
    return AmazonCustomWorkflowDetailSchema.parse(detail);
  }

  async start(context: TenantContext, planId: string) {
    try {
      await withTenant(this.database.db, context, async (tx) => {
        const [plan] = await tx
          .select({ id: productPlans.id })
          .from(productPlans)
          .where(eq(productPlans.id, planId))
          .limit(1);
        if (!plan) throw new NotFoundException("Product plan not found");
        const [existing] = await tx
          .select({ id: amazonCustomWorkflows.id })
          .from(amazonCustomWorkflows)
          .where(eq(amazonCustomWorkflows.productPlanId, plan.id))
          .limit(1);
        if (existing) throw new ConflictException("Amazon Custom workflow already exists");

        const now = new Date();
        const workflowId = createEntityId();
        const firstStep = AMAZON_CUSTOM_WORKFLOW_STEPS[0];
        await tx.insert(amazonCustomWorkflows).values({
          id: workflowId,
          tenantId: context.tenantId,
          productPlanId: plan.id,
          status: "active",
          currentStepKey: firstStep.key,
          revision: 1,
          createdBy: context.userId,
          createdAt: now,
          updatedAt: now,
        });
        await tx.insert(amazonCustomWorkflowSteps).values(
          AMAZON_CUSTOM_WORKFLOW_STEPS.map((step, index) => ({
            id: createEntityId(),
            tenantId: context.tenantId,
            workflowId,
            stepKey: step.key,
            status: index === 0 ? ("in_progress" as const) : ("not_started" as const),
            ...(index === 0 ? { startedAt: now, updatedBy: context.userId } : {}),
            updatedAt: now,
          })),
        );
        await tx.insert(amazonCustomWorkflowEvents).values({
          id: createEntityId(),
          tenantId: context.tenantId,
          workflowId,
          stepKey: firstStep.key,
          action: "workflow_started",
          fromStatus: "not_started",
          toStatus: "in_progress",
          actorUserId: context.userId,
          workflowRevision: 1,
          occurredAt: now,
        });
        await this.audit?.recordInTransaction(tx, context, {
          action: "amazon_custom_workflow.started",
          resourceType: "amazon_custom_workflow",
          resourceId: workflowId,
          result: "success",
          metadata: { productPlanId: plan.id, currentStepKey: firstStep.key, revision: 1 },
        });
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException("Amazon Custom workflow already exists");
      }
      throw error;
    }
    return this.get(context, planId);
  }

  async transition(
    context: TenantContext,
    planId: string,
    rawStepKey: AmazonCustomWorkflowStepKey,
    rawInput: TransitionAmazonCustomWorkflowStepInput,
  ) {
    const stepKey = AmazonCustomWorkflowStepKeySchema.parse(rawStepKey);
    const input = TransitionAmazonCustomWorkflowStepInputSchema.parse(rawInput);
    await withTenant(this.database.db, context, async (tx) => {
      const [workflow] = await tx
        .select()
        .from(amazonCustomWorkflows)
        .where(eq(amazonCustomWorkflows.productPlanId, planId))
        .limit(1);
      if (!workflow) throw new NotFoundException("Amazon Custom workflow not found");
      if (workflow.revision !== input.expectedRevision) {
        throw new ConflictException("Workflow changed. Refresh the page and try again");
      }
      const stepRows = await tx
        .select()
        .from(amazonCustomWorkflowSteps)
        .where(eq(amazonCustomWorkflowSteps.workflowId, workflow.id))
        .orderBy(asc(amazonCustomWorkflowSteps.updatedAt));
      const stepByKey = new Map(stepRows.map((step) => [step.stepKey, step]));
      const step = stepByKey.get(stepKey);
      if (!step) throw new ConflictException("Workflow step is missing");
      const stepIndex = AMAZON_CUSTOM_WORKFLOW_STEPS.findIndex(
        (definition) => definition.key === stepKey,
      );
      const previousSteps = AMAZON_CUSTOM_WORKFLOW_STEPS.slice(0, stepIndex).map(
        (definition) => stepByKey.get(definition.key),
      );
      const laterSteps = AMAZON_CUSTOM_WORKFLOW_STEPS.slice(stepIndex + 1).map(
        (definition) => stepByKey.get(definition.key),
      );
      const action = transitionAction(step.status, input.status);

      if (!action) {
        throw new ConflictException(
          `Workflow step cannot transition from ${step.status} to ${input.status}`,
        );
      }
      if (
        input.status === "in_progress" &&
        step.status === "not_started" &&
        previousSteps.some((item) => item?.status !== "completed")
      ) {
        throw new ConflictException("Complete all previous workflow steps first");
      }
      if (
        step.status === "completed" &&
        laterSteps.some((item) => item?.status !== "not_started")
      ) {
        throw new ConflictException("A completed step cannot reopen after later work has started");
      }
      if (step.status === "completed" && !input.note) {
        throw new ConflictException("A reopen reason is required");
      }

      const now = new Date();
      const revision = workflow.revision + 1;
      const nextDefinition = AMAZON_CUSTOM_WORKFLOW_STEPS[stepIndex + 1];
      const nextWorkflowStatus =
        input.status === "blocked"
          ? "blocked"
          : input.status === "completed" && !nextDefinition
            ? "completed"
            : "active";
      const nextCurrentStepKey =
        input.status === "completed" ? nextDefinition?.key : stepKey;
      const [updatedWorkflow] = await tx
        .update(amazonCustomWorkflows)
        .set({
          status: nextWorkflowStatus,
          currentStepKey: nextCurrentStepKey ?? null,
          revision,
          updatedAt: now,
        })
        .where(
          and(
            eq(amazonCustomWorkflows.id, workflow.id),
            eq(amazonCustomWorkflows.revision, input.expectedRevision),
          ),
        )
        .returning({ id: amazonCustomWorkflows.id });
      if (!updatedWorkflow) {
        throw new ConflictException("Workflow changed. Refresh the page and try again");
      }
      await tx
        .update(amazonCustomWorkflowSteps)
        .set({
          status: input.status,
          note: input.note ?? null,
          startedAt:
            input.status === "in_progress" ? (step.startedAt ?? now) : step.startedAt,
          completedAt: input.status === "completed" ? now : null,
          updatedBy: context.userId,
          updatedAt: now,
        })
        .where(eq(amazonCustomWorkflowSteps.id, step.id));
      await tx.insert(amazonCustomWorkflowEvents).values({
        id: createEntityId(),
        tenantId: context.tenantId,
        workflowId: workflow.id,
        stepKey,
        action,
        fromStatus: step.status,
        toStatus: input.status,
        note: input.note,
        actorUserId: context.userId,
        workflowRevision: revision,
        occurredAt: now,
      });
      await this.audit?.recordInTransaction(tx, context, {
        action: `amazon_custom_workflow.${action}`,
        resourceType: "amazon_custom_workflow",
        resourceId: workflow.id,
        result: "success",
        metadata: {
          productPlanId: planId,
          stepKey,
          fromStatus: step.status,
          toStatus: input.status,
          revision,
        },
      });
    });
    return this.get(context, planId);
  }

  async updateCompletedStepNote(
    context: TenantContext,
    planId: string,
    rawStepKey: AmazonCustomWorkflowStepKey,
    rawInput: UpdateAmazonCustomWorkflowStepNoteInput,
  ) {
    const stepKey = AmazonCustomWorkflowStepKeySchema.parse(rawStepKey);
    const input = UpdateAmazonCustomWorkflowStepNoteInputSchema.parse(rawInput);
    await withTenant(this.database.db, context, async (tx) => {
      const [workflow] = await tx
        .select()
        .from(amazonCustomWorkflows)
        .where(eq(amazonCustomWorkflows.productPlanId, planId))
        .limit(1);
      if (!workflow) throw new NotFoundException("Amazon Custom workflow not found");
      if (workflow.revision !== input.expectedRevision) {
        throw new ConflictException("Workflow changed. Refresh the page and try again");
      }
      const [step] = await tx
        .select()
        .from(amazonCustomWorkflowSteps)
        .where(
          and(
            eq(amazonCustomWorkflowSteps.workflowId, workflow.id),
            eq(amazonCustomWorkflowSteps.stepKey, stepKey),
          ),
        )
        .limit(1);
      if (!step) throw new ConflictException("Workflow step is missing");
      if (step.status !== "completed") {
        throw new ConflictException("Only a completed step note can be edited");
      }

      const now = new Date();
      const revision = workflow.revision + 1;
      const [updatedWorkflow] = await tx
        .update(amazonCustomWorkflows)
        .set({ revision, updatedAt: now })
        .where(
          and(
            eq(amazonCustomWorkflows.id, workflow.id),
            eq(amazonCustomWorkflows.revision, input.expectedRevision),
          ),
        )
        .returning({ id: amazonCustomWorkflows.id });
      if (!updatedWorkflow) {
        throw new ConflictException("Workflow changed. Refresh the page and try again");
      }
      await tx
        .update(amazonCustomWorkflowSteps)
        .set({
          note: input.note || null,
          updatedBy: context.userId,
          updatedAt: now,
        })
        .where(eq(amazonCustomWorkflowSteps.id, step.id));
      await tx.insert(amazonCustomWorkflowEvents).values({
        id: createEntityId(),
        tenantId: context.tenantId,
        workflowId: workflow.id,
        stepKey,
        action: "step_note_updated",
        fromStatus: "completed",
        toStatus: "completed",
        note: input.note || null,
        actorUserId: context.userId,
        workflowRevision: revision,
        occurredAt: now,
      });
      await this.audit?.recordInTransaction(tx, context, {
        action: "amazon_custom_workflow.step_note_updated",
        resourceType: "amazon_custom_workflow",
        resourceId: workflow.id,
        result: "success",
        metadata: { productPlanId: planId, stepKey, revision },
      });
    });
    return this.get(context, planId);
  }
}

function summaryFromRows({
  plan,
  workflow,
  steps,
  ownerName,
  spuCode,
  skuCodes,
}: {
  plan: typeof productPlans.$inferSelect;
  workflow: typeof amazonCustomWorkflows.$inferSelect | undefined;
  steps: Array<typeof amazonCustomWorkflowSteps.$inferSelect>;
  ownerName?: string;
  spuCode?: string;
  skuCodes: string[];
}): AmazonCustomWorkflowSummary {
  const currentDefinition = AMAZON_CUSTOM_WORKFLOW_STEPS.find(
    (definition) => definition.key === (workflow?.currentStepKey ?? "research_capture"),
  );
  const currentStep = currentDefinition
    ? steps.find((step) => step.stepKey === currentDefinition.key)
    : undefined;
  const completedSteps = steps.filter((step) => step.status === "completed").length;
  return {
    ...(workflow ? { workflowId: workflow.id } : {}),
    productPlanId: plan.id,
    productName: plan.name,
    productStatus: plan.status as AmazonCustomWorkflowSummary["productStatus"],
    ...(ownerName ? { ownerName } : {}),
    ...(spuCode ? { spuCode } : {}),
    skuCodes,
    status: workflow?.status ?? "not_started",
    completedSteps,
    totalSteps: AMAZON_CUSTOM_WORKFLOW_STEPS.length,
    ...(workflow?.status !== "completed" && currentDefinition
      ? {
          currentStepKey: currentDefinition.key,
          currentStepTitle: currentDefinition.title,
          currentStepStatus: currentStep?.status ?? "not_started",
        }
      : {}),
    ...(currentStep?.status === "blocked" && currentStep.note
      ? { latestBlocker: currentStep.note }
      : {}),
    revision: workflow?.revision ?? 0,
    updatedAt: (workflow?.updatedAt ?? plan.updatedAt).toISOString(),
  };
}

function transitionAction(
  from: AmazonCustomWorkflowStepStatus,
  to: TransitionAmazonCustomWorkflowStepInput["status"],
): AmazonCustomWorkflowEventAction | undefined {
  if (from === "not_started" && to === "in_progress") return "step_started";
  if (from === "in_progress" && to === "blocked") return "step_blocked";
  if (from === "blocked" && to === "in_progress") return "step_unblocked";
  if (from === "in_progress" && to === "completed") return "step_completed";
  if (from === "completed" && to === "in_progress") return "step_reopened";
  return undefined;
}

function groupBy<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) grouped.set(key(row), [...(grouped.get(key(row)) ?? []), row]);
  return grouped;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}
