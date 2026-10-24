import { z } from "zod";
import { EntityIdSchema as Id } from "@yummyai/contracts/common/ids";

export const BusinessTaskStateSchema = z.enum(["pending", "working", "blocked", "waiting", "done", "unavailable", "cancelled"]);
export const BusinessTaskStageSchema = z.object({
  key: z.string(), label: z.string(), state: BusinessTaskStateSchema, detail: z.string(),
  href: z.string().startsWith("/"), action: z.string(),
  evidence: z.array(z.object({ label: z.string(), value: z.string() }).strict()).default([]),
}).strict();
export const BusinessTaskViewSchema = z.object({
  id: Id, kind: z.enum(["sales_plan", "order"]), title: z.string(), goal: z.string(),
  state: BusinessTaskStateSchema, stages: z.array(BusinessTaskStageSchema).max(12),
  metrics: z.array(z.object({ key: z.string(), label: z.string(), value: z.string().nullable(), note: z.string() }).strict()).max(12),
  notices: z.array(z.string()),
}).strict();
export type BusinessTaskView = z.infer<typeof BusinessTaskViewSchema>;
export type BusinessTaskStage = z.infer<typeof BusinessTaskStageSchema>;
export type BusinessTaskState = z.infer<typeof BusinessTaskStateSchema>;

const Fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
export const OrderTaskViewSchema = z.object({
  task: BusinessTaskViewSchema,
  groups: z.array(z.object({
    id: Fingerprint, fingerprint: Fingerprint, label: z.string(), quantity: z.int().positive(),
    canPrepare: z.boolean(), blockers: z.array(z.string()),
    package: z.object({ id: Id, href: z.string().startsWith("/") }).strict().nullable(),
  }).strict()).max(100),
}).strict();
export const PrepareOrderTaskDeliverySchema = z.object({ groupId: Fingerprint, expectedFingerprint: Fingerprint }).strict();
export type OrderTaskView = z.infer<typeof OrderTaskViewSchema>;
