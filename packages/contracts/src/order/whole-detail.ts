import { z } from "zod";
import { EntityIdSchema as Id } from "@yummyai/contracts/common/ids";
import { OrderWorkListItemSchema, OrderWorkSummarySchema, OrderOperationsViewSchema } from "@yummyai/contracts/order/workspace";
import { WholeOrderFulfillmentViewSchema } from "@yummyai/contracts/order/whole-fulfillment";
import { ShiposOrderShipmentEvidenceSchema } from "@yummyai/contracts/suppliers/shipos";

const File = z.object({ name: z.string(), path: z.string() }).strict();
const section = <T extends z.ZodType>(schema: T) => z.object({ data: schema.nullable(), error: z.string().nullable() }).strict();
export const WholeOrderDetailViewSchema = z.object({
  orderId: Id,
  // Absent on historical transports; never infer this from a line revision.
  orderSequence: z.int().nonnegative().optional(),
  items: z.array(z.object({
    line: OrderWorkListItemSchema,
    summary: section(OrderWorkSummarySchema),
    artwork: section(z.object({
      versionId: Id, versionNumber: z.int().positive(), approved: z.boolean(),
      approvedVersionNumber: z.int().positive().nullable(),
      preview: File.nullable(), productionFile: File.nullable(),
      productionPending: z.boolean(),
    }).strict()),
  }).strict()).min(1).max(100),
  fulfillment: section(WholeOrderFulfillmentViewSchema),
  production: section(OrderOperationsViewSchema.shape.production),
  shipments: section(OrderOperationsViewSchema.shape.shipments),
  cases: section(OrderOperationsViewSchema.shape.cases),
  shipos: section(z.array(ShiposOrderShipmentEvidenceSchema)),
}).strict();
export type WholeOrderDetailView = z.infer<typeof WholeOrderDetailViewSchema>;
