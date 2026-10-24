import { z } from "zod";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import type { AssistView } from "@yummyai/contracts/ai/assist";
import type { SalesPackageView } from "@yummyai/contracts/catalog/development";

export const LaunchAssistKindSchema = z.enum(["creative", "sku_package"]);
export const LaunchAdoptFieldSchema = z.enum([
  "audience",
  "scenario",
  "positioning",
  "title",
  "bullets",
  "description",
  "customInstructions",
]);
export const LaunchBasisRequestSchema = z
  .object({
    kind: LaunchAssistKindSchema,
    expectedRevision: z.int().positive(),
    taskGoal: z.string().trim().max(2000).default(""),
  })
  .strict();
export const LaunchAdoptRequestSchema = z
  .object({
    kind: LaunchAssistKindSchema,
    runId: EntityIdSchema,
    directionIndex: z.int().min(0).max(2).default(0),
    fields: z
      .array(LaunchAdoptFieldSchema)
      .min(1)
      .max(7)
      .refine((values) => new Set(values).size === values.length, "采纳字段不可重复"),
    expectedRevision: z.int().positive(),
    idempotencyKey: z.uuid(),
  })
  .strict();
export type LaunchAdoptRequest = z.infer<typeof LaunchAdoptRequestSchema>;
export type LaunchAdoptField = z.infer<typeof LaunchAdoptFieldSchema>;
export type LaunchStage = {
  key: "product" | "research" | "direction" | "design" | "listing" | "package";
  label: string;
  status: "ready" | "pending" | "blocked" | "unavailable";
  detail: string;
  issues: string[];
  href: string;
  action: string;
};
export type LaunchAdoption = {
  runId: string;
  kind: "creative" | "sku_package";
  fields: LaunchAdoptField[];
  revision: number;
  createdAt: string;
};
export type SalesPlanLaunch = {
  planId: string;
  revision: number;
  stages: LaunchStage[];
  nextStage: LaunchStage | null;
  tasks: Array<
    Pick<
      AssistView,
      | "id"
      | "kind"
      | "status"
      | "scope"
      | "modelLabel"
      | "createdAt"
      | "stale"
      | "costUsd"
      | "error"
    >
  >;
  hasMoreTasks: boolean;
  adoptions: LaunchAdoption[];
  packages: SalesPackageView[];
  fees: { knownUsd: number; unknown: number; active: number; activeUpperUsd: number | null };
  diagnostics: string[];
  canAnalyze: { creative: boolean; sku_package: boolean };
};
