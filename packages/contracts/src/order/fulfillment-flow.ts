import { z } from "zod";
import { EntityIdSchema as Id } from "@yummyai/contracts/common/ids";

/** The parcel profile supplies the exact specification versions and countries.
 * A route adds standing execution choices, never credentials or buyer data. */
export const FulfillmentRouteSchema = z.object({
  name: z.string().trim().min(1).max(160),
  documentProfileVersionId: Id,
  connectionId: Id,
  mode: z.enum(["disabled", "quote", "purchase"]),
  productionDays: z.int().min(1).max(30),
  autoWriteback: z.boolean().default(false),
}).strict();
export const SaveFulfillmentRouteSchema = z.object({
  id: Id.optional(), expectedVersion: z.int().nonnegative(),
  profile: FulfillmentRouteSchema, idempotencyKey: z.uuid(),
}).strict();
export const FulfillmentFlowStageSchema = z.enum([
  "waiting_artwork", "waiting_render", "production", "logistics", "delivery",
  "waiting_factory", "waiting_dispatch", "writeback", "completed", "exception", "paused",
]);
export const FULFILLMENT_FLOW_LABELS: Record<z.infer<typeof FulfillmentFlowStageSchema>, string> = {
  waiting_artwork: "等待整单审图", waiting_render: "正在生成正式生产文件",
  production: "自动安排制作", logistics: "自动准备物流", delivery: "自动准备工厂文件",
  waiting_factory: "待提交工厂", waiting_dispatch: "核对交运与回传",
  writeback: "回传物流单号", completed: "履约完成", exception: "需要处理", paused: "自动履约已暂停",
};
export const FulfillmentRouteViewSchema = z.object({
  id: Id, version: z.int().positive(), profile: FulfillmentRouteSchema,
  factoryId: Id, factoryName: z.string(), supplierName: z.string(),
  countries: z.array(z.string()), products: z.array(z.string()),
  connectionName: z.string(), blockers: z.array(z.string()), factorySetupIssue: z.string().optional(),
}).strict();
export const FulfillmentFlowViewSchema = z.object({
  orderId: Id, id: Id.nullable(), stage: FulfillmentFlowStageSchema.nullable(),
  automaticDesign: z.boolean().default(false),
  route: FulfillmentRouteViewSchema.nullable(), reasons: z.array(z.string()),
  productionOrderIds: z.array(Id), logisticsTaskId: Id.nullable(), deliveryPackageIds: z.array(Id),
  productionExportId: Id.nullable(),
  updatedAt: z.iso.datetime().nullable(),
}).strict();
export const FulfillmentRouteWorkspaceSchema = z.object({
  canConfigure: z.boolean(), routes: z.array(FulfillmentRouteViewSchema),
  profiles: z.array(z.object({ id: Id, name: z.string(), factoryName: z.string(), factoryId: Id,
    countries: z.array(z.string()), products: z.array(z.string()) }).strict()),
  connections: z.array(z.object({ id: Id, name: z.string(), factoryId: Id, autoPurchase: z.boolean() }).strict()),
}).strict();
export type FulfillmentRoute = z.infer<typeof FulfillmentRouteSchema>;
export type FulfillmentRouteView = z.infer<typeof FulfillmentRouteViewSchema>;
export type FulfillmentFlowView = z.infer<typeof FulfillmentFlowViewSchema>;
export type FulfillmentRouteWorkspace = z.infer<typeof FulfillmentRouteWorkspaceSchema>;
export type FulfillmentFlowStage = z.infer<typeof FulfillmentFlowStageSchema>;

/** An operational queue, not a second order ledger. Private files are still
 * downloaded through the original owners' live authorization checks. */
export const FulfillmentFlowQueueSchema = z.object({
  routes: z.array(FulfillmentRouteViewSchema),
  canConfigure: z.boolean(), canResume: z.boolean(), truncated: z.boolean(),
  items: z.array(z.object({
    id: Id, orderId: Id, orderNumber: z.string(), lineId: Id,
    stage: FulfillmentFlowStageSchema, reasons: z.array(z.string()),
    routeName: z.string().nullable(), documentProfileVersionId: Id.nullable(), productionExportId: Id.nullable(),
    deliveryPackageIds: z.array(Id), logisticsTaskId: Id.nullable(), updatedAt: z.iso.datetime(),
  }).strict()),
}).strict();
export type FulfillmentFlowQueue = z.infer<typeof FulfillmentFlowQueueSchema>;
export const ResumeFulfillmentBatchSchema = z.object({orderIds:z.array(Id).min(1).max(50)}).strict()
  .refine(input => new Set(input.orderIds).size === input.orderIds.length,"订单不能重复");
