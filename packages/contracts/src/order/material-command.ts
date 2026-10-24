import { z } from "zod";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import { RecordProductionMaterialSchema, ProductionMaterialEntrySchema, ProductionMaterialRequestKeySchema } from "@yummyai/contracts/order/material-execution";

export const MaterialCommandStatusSchema = z.enum(["prepared", "succeeded", "rejected", "cancelled", "expired"]);
export const MaterialCommandViewSchema = z.object({
  id: EntityIdSchema, productionOrderId: EntityIdSchema, bindingId: EntityIdSchema,
  requestKey: ProductionMaterialRequestKeySchema,
  status: MaterialCommandStatusSchema, contextAuthority: z.string().min(1),
  createdAt: z.iso.datetime(), expiresAt: z.iso.datetime(), acknowledged: z.boolean(),
  canExecute: z.boolean(), canCancel: z.boolean(),
  input: RecordProductionMaterialSchema.nullable(), receipt: ProductionMaterialEntrySchema.nullable(),
  errorCode: z.enum(["basis_changed", "input_unavailable"]).nullable(),
}).strict().superRefine((value, context) => {
  if ((value.status === "succeeded") !== (value.receipt !== null)) context.addIssue({ code: "custom", message: "成功须有原物料事实回执" });
  if (value.input && value.input.bindingId !== value.bindingId || value.receipt && (value.receipt.productionOrderId !== value.productionOrderId || value.receipt.bindingId !== value.bindingId))
    context.addIssue({ code: "custom", message: "物料提交的原生产与制造依据不一致" });
  if (value.input && value.input.idempotencyKey !== value.requestKey || value.receipt && value.receipt.idempotencyKey !== value.requestKey)
    context.addIssue({ code: "custom", message: "物料填写与原回执请求编号不一致" });
  if (value.canExecute && (value.status !== "prepared" || !value.input) || value.canCancel && value.status !== "prepared" || value.acknowledged && (value.status === "prepared" || value.input !== null))
    context.addIssue({ code: "custom", message: "物料状态 操作与输入保留不一致" });
});
export const MaterialCommandListSchema = z.object({ items: z.array(MaterialCommandViewSchema).max(1), contextAuthority: z.string().min(1) }).strict();
export type MaterialCommandView = z.infer<typeof MaterialCommandViewSchema>;
