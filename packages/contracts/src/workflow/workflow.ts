import { z } from "zod";

import { EntityIdSchema } from "@yummyai/contracts/common/ids";

export const WorkflowDefinitionScopeSchema = z.enum(["official", "team", "personal"]);
export const WorkflowDefinitionStatusSchema = z.enum(["draft", "published", "archived"]);
export const WorkflowDefinitionVersionStatusSchema = z.enum(["draft", "published"]);
export const WorkflowNodeKindSchema = z.enum([
  "start",
  "end",
  "human_task",
  "approval_gate",
  "condition_gate",
  "internal_action",
  "external_action",
]);
export const WorkflowEdgeKindSchema = z.enum(["success", "condition", "default", "rework"]);
export const WorkflowPortDataTypeSchema = z.enum([
  "any",
  "research_snapshot",
  "product_facts",
  "sku",
  "design_version",
  "product_package",
  "listing_version",
  "image",
  "template",
  "text",
  "production_package",
]);
export const WorkflowNodeRunStatusSchema = z.enum([
  "not_started",
  "in_progress",
  "blocked",
  "failed",
  "completed",
  "skipped",
  "cancelled",
]);
export const WorkflowRunStatusSchema = z.enum([
  "not_started",
  "active",
  "blocked",
  "failed",
  "completed",
  "cancelled",
]);
export const WorkflowArtifactValidationStatusSchema = z.enum([
  "pending",
  "valid",
  "invalid",
]);
export const WorkflowRunEventTypeSchema = z.enum([
  "run_started",
  "run_cancelled",
  "run_completed",
  "node_started",
  "node_completed",
  "node_blocked",
  "node_unblocked",
  "node_failed",
  "node_retried",
  "node_skipped",
  "node_cancelled",
  "node_approved",
  "node_rejected",
  "node_reopened",
  "node_note_updated",
  "artifact_linked",
]);

export const WorkflowPositionSchema = z.object({ x: z.number(), y: z.number() }).strict();
export const WorkflowViewportSchema = z
  .object({ x: z.number(), y: z.number(), zoom: z.number().positive().max(4) })
  .strict();
export const WorkflowPortSchema = z
  .object({
    id: z.string().trim().min(1).max(80),
    label: z.string().trim().min(1).max(120),
    dataType: WorkflowPortDataTypeSchema,
    required: z.boolean().default(false),
  })
  .strict();
export const WorkflowNodeConfigSchema = z
  .object({
    capabilityKey: z.string().trim().min(1).max(160).optional(),
    conditionKey: z.string().trim().min(1).max(160).optional(),
    approvalMode: z.enum(["any", "all"]).optional(),
    instructions: z.string().trim().max(8_000).optional(),
    requiredActions: z.array(z.string().trim().min(1).max(500)).max(30).optional(),
    blockingConditions: z.array(z.string().trim().min(1).max(500)).max(30).optional(),
    artifactLabel: z.string().trim().min(1).max(160).optional(),
    parameters: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();
export const WorkflowNodeSchema = z
  .object({
    id: z.string().trim().min(1).max(120),
    kind: WorkflowNodeKindSchema,
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().max(2_000).default(""),
    ownerRole: z.string().trim().min(1).max(160).default("流程执行人"),
    requiredPermission: z.string().trim().min(1).max(160).optional(),
    inputPorts: z.array(WorkflowPortSchema).max(20).default([]),
    outputPorts: z.array(WorkflowPortSchema).max(20).default([]),
    config: WorkflowNodeConfigSchema.default({ parameters: {} }),
    position: WorkflowPositionSchema,
    reworkTargetNodeId: z.string().trim().min(1).max(120).optional(),
  })
  .strict();
export const WorkflowEdgeSchema = z
  .object({
    id: z.string().trim().min(1).max(160),
    source: z.string().trim().min(1).max(120),
    target: z.string().trim().min(1).max(120),
    sourcePortId: z.string().trim().min(1).max(80).optional(),
    targetPortId: z.string().trim().min(1).max(80).optional(),
    kind: WorkflowEdgeKindSchema.default("success"),
    label: z.string().trim().max(200).optional(),
    conditionValue: z.string().trim().max(200).optional(),
    artifactType: WorkflowPortDataTypeSchema.optional(),
    artifactVersion: z.string().trim().max(80).optional(),
    validationStatus: WorkflowArtifactValidationStatusSchema.optional(),
  })
  .strict();
export const WorkflowGraphSchema = z
  .object({
    nodes: z.array(WorkflowNodeSchema).max(100),
    edges: z.array(WorkflowEdgeSchema).max(200),
    viewport: WorkflowViewportSchema.default({ x: 0, y: 0, zoom: 1 }),
  })
  .strict();

export const WorkflowValidationIssueSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  nodeId: z.string().optional(),
  edgeId: z.string().optional(),
});
export const WorkflowValidationResultSchema = z.object({
  valid: z.boolean(),
  issues: z.array(WorkflowValidationIssueSchema),
});

export const CreateWorkflowDefinitionInputSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().max(2_000).default(""),
    category: z.string().trim().min(1).max(120),
    scope: z.enum(["team", "personal"]).default("personal"),
    graph: WorkflowGraphSchema,
  })
  .strict();
export const UpdateWorkflowDraftInputSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(2_000).optional(),
    category: z.string().trim().min(1).max(120).optional(),
    graph: WorkflowGraphSchema.optional(),
    expectedRevision: z.int().nonnegative(),
  })
  .strict();
export const CloneWorkflowDefinitionInputSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    scope: z.enum(["team", "personal"]).default("team"),
  })
  .strict();
export const PublishWorkflowDefinitionInputSchema = z
  .object({ expectedRevision: z.int().nonnegative() })
  .strict();

export const WorkflowDefinitionSummarySchema = z.object({
  id: EntityIdSchema,
  stableKey: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  category: z.string().min(1),
  scope: WorkflowDefinitionScopeSchema,
  status: WorkflowDefinitionStatusSchema,
  draftVersion: z.int().positive().optional(),
  publishedVersion: z.int().positive().optional(),
  revision: z.int().nonnegative(),
  nodeCount: z.int().nonnegative(),
  activeRunCount: z.int().nonnegative().default(0),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export const WorkflowDefinitionVersionViewSchema = z.object({
  id: EntityIdSchema,
  definitionId: EntityIdSchema,
  version: z.int().positive(),
  status: WorkflowDefinitionVersionStatusSchema,
  graph: WorkflowGraphSchema,
  validation: WorkflowValidationResultSchema,
  checksum: z.string().regex(/^[0-9a-f]{64}$/),
  createdAt: z.iso.datetime(),
  publishedAt: z.iso.datetime().optional(),
});
export const WorkflowDefinitionDetailSchema = WorkflowDefinitionSummarySchema.extend({
  draft: WorkflowDefinitionVersionViewSchema.optional(),
  published: WorkflowDefinitionVersionViewSchema.optional(),
});
export const WorkflowDefinitionListSchema = z.object({
  items: z.array(WorkflowDefinitionSummarySchema),
});

export const StartWorkflowRunInputSchema = z
  .object({
    definitionId: EntityIdSchema,
    productPlanId: EntityIdSchema,
    title: z.string().trim().min(1).max(240).optional(),
  })
  .strict();

const WorkflowNodeCommandBaseSchema = z.object({ expectedRevision: z.int().nonnegative() });
export const WorkflowNodeCommandSchema = z.discriminatedUnion("type", [
  WorkflowNodeCommandBaseSchema.extend({ type: z.literal("start") }).strict(),
  WorkflowNodeCommandBaseSchema.extend({
    type: z.literal("complete"),
    note: z.string().trim().max(2_000).optional(),
    parameters: z.record(z.string(), z.unknown()).default({}),
  }).strict(),
  WorkflowNodeCommandBaseSchema.extend({
    type: z.literal("block"),
    reason: z.string().trim().min(1).max(2_000),
  }).strict(),
  WorkflowNodeCommandBaseSchema.extend({ type: z.literal("unblock") }).strict(),
  WorkflowNodeCommandBaseSchema.extend({
    type: z.literal("approve"),
    note: z.string().trim().max(2_000).optional(),
  }).strict(),
  WorkflowNodeCommandBaseSchema.extend({
    type: z.literal("reject"),
    reason: z.string().trim().min(1).max(2_000),
    reworkTargetNodeId: z.string().trim().min(1).max(120).optional(),
  }).strict(),
  WorkflowNodeCommandBaseSchema.extend({ type: z.literal("retry") }).strict(),
  WorkflowNodeCommandBaseSchema.extend({
    type: z.literal("reopen"),
    reason: z.string().trim().min(1).max(2_000).optional(),
  }).strict(),
  WorkflowNodeCommandBaseSchema.extend({
    type: z.literal("update_note"),
    note: z.string().trim().max(2_000),
  }).strict(),
  WorkflowNodeCommandBaseSchema.extend({
    type: z.literal("cancel"),
    reason: z.string().trim().min(1).max(2_000).optional(),
  }).strict(),
]);

export const WorkflowNodeRunViewSchema = z.object({
  id: EntityIdSchema,
  nodeId: z.string().min(1),
  kind: WorkflowNodeKindSchema,
  title: z.string().min(1),
  ownerRole: z.string().min(1),
  requiredPermission: z.string().optional(),
  status: WorkflowNodeRunStatusSchema,
  note: z.string().optional(),
  blockerReason: z.string().optional(),
  parameterSnapshot: z.record(z.string(), z.unknown()),
  attemptCount: z.int().nonnegative(),
  startedAt: z.iso.datetime().optional(),
  completedAt: z.iso.datetime().optional(),
  updatedAt: z.iso.datetime(),
  updatedByName: z.string().optional(),
});
export const WorkflowArtifactLinkViewSchema = z.object({
  id: EntityIdSchema,
  nodeId: z.string().min(1),
  artifactType: WorkflowPortDataTypeSchema,
  artifactId: z.string().min(1),
  artifactVersion: z.string().optional(),
  label: z.string().min(1),
  validationStatus: WorkflowArtifactValidationStatusSchema,
  createdAt: z.iso.datetime(),
});
export const WorkflowRunEventViewSchema = z.object({
  id: EntityIdSchema,
  type: WorkflowRunEventTypeSchema,
  nodeId: z.string().optional(),
  fromStatus: z.string().optional(),
  toStatus: z.string().optional(),
  note: z.string().optional(),
  actorName: z.string().min(1),
  revision: z.int().positive(),
  occurredAt: z.iso.datetime(),
});
export const WorkflowRunSummarySchema = z.object({
  id: EntityIdSchema,
  definitionId: EntityIdSchema,
  definitionVersionId: EntityIdSchema,
  definitionName: z.string().min(1),
  definitionVersion: z.int().positive(),
  productPlanId: EntityIdSchema,
  productName: z.string().min(1),
  title: z.string().min(1),
  status: WorkflowRunStatusSchema,
  currentNodeId: z.string().optional(),
  currentNodeTitle: z.string().optional(),
  completedNodes: z.int().nonnegative(),
  totalNodes: z.int().nonnegative(),
  latestBlocker: z.string().optional(),
  revision: z.int().nonnegative(),
  updatedAt: z.iso.datetime(),
});
export const WorkflowRunDetailSchema = WorkflowRunSummarySchema.extend({
  graph: WorkflowGraphSchema,
  nodes: z.array(WorkflowNodeRunViewSchema),
  artifacts: z.array(WorkflowArtifactLinkViewSchema),
  events: z.array(WorkflowRunEventViewSchema).max(200),
});
export const WorkflowRunListSchema = z.object({ items: z.array(WorkflowRunSummarySchema) });

export type WorkflowDefinitionScope = z.infer<typeof WorkflowDefinitionScopeSchema>;
export type WorkflowDefinitionStatus = z.infer<typeof WorkflowDefinitionStatusSchema>;
export type WorkflowNodeKind = z.infer<typeof WorkflowNodeKindSchema>;
export type WorkflowNodeRunStatus = z.infer<typeof WorkflowNodeRunStatusSchema>;
export type WorkflowRunStatus = z.infer<typeof WorkflowRunStatusSchema>;
export type WorkflowArtifactValidationStatus = z.infer<
  typeof WorkflowArtifactValidationStatusSchema
>;
export type WorkflowRunEventType = z.infer<typeof WorkflowRunEventTypeSchema>;
export type WorkflowPort = z.infer<typeof WorkflowPortSchema>;
export type WorkflowPortDataType = z.infer<typeof WorkflowPortDataTypeSchema>;
export type WorkflowGraph = z.infer<typeof WorkflowGraphSchema>;
export type WorkflowNode = z.infer<typeof WorkflowNodeSchema>;
export type WorkflowEdge = z.infer<typeof WorkflowEdgeSchema>;
export type WorkflowValidationIssue = z.infer<typeof WorkflowValidationIssueSchema>;
export type WorkflowValidationResult = z.infer<typeof WorkflowValidationResultSchema>;
export type CreateWorkflowDefinitionInput = z.infer<typeof CreateWorkflowDefinitionInputSchema>;
export type UpdateWorkflowDraftInput = z.infer<typeof UpdateWorkflowDraftInputSchema>;
export type CloneWorkflowDefinitionInput = z.infer<typeof CloneWorkflowDefinitionInputSchema>;
export type PublishWorkflowDefinitionInput = z.infer<typeof PublishWorkflowDefinitionInputSchema>;
export type StartWorkflowRunInput = z.infer<typeof StartWorkflowRunInputSchema>;
export type WorkflowNodeCommand = z.infer<typeof WorkflowNodeCommandSchema>;
export type WorkflowDefinitionSummary = z.infer<typeof WorkflowDefinitionSummarySchema>;
export type WorkflowDefinitionDetail = z.infer<typeof WorkflowDefinitionDetailSchema>;
export type WorkflowRunSummary = z.infer<typeof WorkflowRunSummarySchema>;
export type WorkflowRunDetail = z.infer<typeof WorkflowRunDetailSchema>;
