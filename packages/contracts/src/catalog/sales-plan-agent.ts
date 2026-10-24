import { z } from "zod";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import { LaunchAssistKindSchema } from "@yummyai/contracts/catalog/sales-plan-launch";

export const PreparationStartSchema = z.object({
  expectedRevision: z.int().positive(),
  idempotencyKey: z.uuid(),
}).strict();
export const PreparationCommandSchema = PreparationStartSchema.extend({
  expectedRunRevision: z.int().positive(),
}).strict();
export const PreparationAnalyzeSchema = PreparationCommandSchema.extend({
  kind: LaunchAssistKindSchema,
  modelId: EntityIdSchema,
  expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export const PreparationBasisSchema = z.object({
  kind: LaunchAssistKindSchema,
  expectedRevision: z.int().positive(),
  expectedRunRevision: z.int().positive(),
}).strict();
export const PreparationStepSchema = z.object({
  key: z.enum(["product", "design", "draft", "review"]),
  label: z.string(),
  state: z.enum(["pending", "passed", "blocked", "waiting"]),
  detail: z.string(),
  href: z.string().startsWith("/"),
});
export const PreparationRunSchema = z.object({
  id: EntityIdSchema,
  planId: EntityIdSchema,
  revision: z.int().positive(),
  planRevision: z.int().positive(),
  status: z.enum(["running", "blocked", "waiting", "ready", "cancelled"]),
  goal: z.literal("准备当前销售方案至可提交刊登审核"),
  message: z.string(),
  steps: z.array(PreparationStepSchema).max(4),
  evidence: z.array(z.object({ kind: z.enum(["sales_plan", "specification", "artwork", "listing"]),
    id: EntityIdSchema, version: z.string().min(1).max(80) })).max(200).default([]),
  listingId: EntityIdSchema.nullable(),
  listingVersionId: EntityIdSchema.nullable(),
  analyses: z.array(z.object({ id: EntityIdSchema, kind: LaunchAssistKindSchema })).max(2),
  toolCalls: z.int().nonnegative(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type PreparationRun = z.infer<typeof PreparationRunSchema>;
export type PreparationStep = z.infer<typeof PreparationStepSchema>;
export const PreparationViewSchema = z.object({
  run: PreparationRunSchema,
  currentPlanRevision: z.int().positive(),
  sourceChanged: z.boolean(),
  busy: z.boolean(),
  canContinue: z.boolean(),
  history: z.array(z.object({ at: z.iso.datetime(), message: z.string() })).max(30),
  analysis: z.object({
    id: EntityIdSchema,
    kind: LaunchAssistKindSchema,
    status: z.enum(["queued", "running", "completed", "failed", "cancelled"]),
    stale: z.boolean(),
    costUsd: z.number().nonnegative().nullable(),
    href: z.string().startsWith("/"),
  }).nullable(),
});
export const PreparationListSchema = z.object({ runs: z.array(PreparationRunSchema).max(10) });
export type PreparationView = z.infer<typeof PreparationViewSchema>;
