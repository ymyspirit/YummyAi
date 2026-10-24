import { z } from "zod";
import { EntityIdSchema as Id } from "@yummyai/contracts/common/ids";

export const ShiposOrderNumberSchema = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/, "订单号只能包含字母、数字、点、横线和下划线");
export const ShiposCarrierMappingSchema = z.object({
  channel: z.string().trim().min(1).max(160), carrierCode: z.string().trim().regex(/^[A-Z0-9_:-]{1,80}$/),
  carrierName: z.string().trim().min(1).max(160), carrierService: z.string().trim().min(1).max(160),
  shipFromCountryCode: z.string().regex(/^[A-Z]{2}$/),
}).strict();
const ChannelMappingsSchema = z.array(ShiposCarrierMappingSchema).max(50).refine(rows => new Set(rows.map(row => row.channel)).size === rows.length, "同一渠道只能配置一次");
export const ShiposShipmentSelectionSchema = z.object({ supplierId: Id, recordId: Id, expectedConnectionVersion: z.int().positive() }).strict();
export const ShiposShipmentSourceSchema = z.object({
  supplierId: Id, recordId: Id, connectionVersion: z.int().positive(), fetchedAt: z.iso.datetime(),
  labelAvailable: z.boolean(), channel: z.string().nullable(), carrierMapping: ShiposCarrierMappingSchema.nullable(),
}).strict();
export const SaveShiposConnectionSchema = z.object({
  name: z.string().trim().min(1).max(100), status: z.enum(["draft", "active", "paused"]), expectedVersion: z.int().nonnegative(),
  appKey: z.string().trim().min(1).max(256).regex(/^[\x21-\x7e]+$/).optional(),
  appSecret: z.string().trim().min(1).max(256).regex(/^[\x21-\x7e]+$/).optional(),
  clearCredentials: z.boolean().default(false), channelMappings: ChannelMappingsSchema.optional(), idempotencyKey: z.uuid(),
}).strict().superRefine((v, ctx) => {
  if (!!v.appKey !== !!v.appSecret || v.clearCredentials && !!v.appKey) ctx.addIssue({ code: "custom", path: ["appSecret"], message: "更换凭据时请同时填写 AppKey 与 AppSecret" });
});
export const SyncShiposOrdersSchema = z.object({
  orderNumbers: z.array(ShiposOrderNumberSchema).min(1).max(5).refine(v => new Set(v).size === v.length, "订单号不能重复"),
  expectedVersion: z.int().positive(), idempotencyKey: z.uuid(),
}).strict();
export const TestShiposConnectionSchema = z.object({ expectedVersion: z.int().positive() }).strict();
export const ShiposConnectionViewSchema = z.object({
  id: Id, supplierId: Id, name: z.string(), status: z.enum(["draft", "active", "paused"]), version: z.int().positive(),
  credentialsConfigured: z.boolean(), appKeyHint: z.string().nullable(), lastTestAt: z.iso.datetime().nullable(),
  lastTestResult: z.enum(["success", "failed"]).nullable(), updatedAt: z.iso.datetime(), channelMappings: ChannelMappingsSchema.default([]),
}).strict();
export const ShiposDiagnosticSchema = z.enum(["query_failed", "not_returned", "detail_unavailable", "detail_mismatch", "no_local_order", "ambiguous_local_order", "retention_expired", "interrupted", "connection_changed"]);
export const ShiposOrderEvidenceSchema = z.object({
  orderNumber: ShiposOrderNumberSchema, trackingNumber: z.string().nullable(), labelAvailable: z.boolean(),
  statusCode: z.int().nullable(), cancelStatusCode: z.int().nullable(), labelStatusCode: z.int().nullable(), settlementStatusCode: z.int().nullable(),
  channel: z.string().nullable(), fee: z.string().nullable(), currency: z.string().regex(/^[A-Z]{3}$/).nullable(),
  diagnostics: z.array(ShiposDiagnosticSchema),
}).strict();
export const ShiposRecordViewSchema = ShiposOrderEvidenceSchema.extend({
  id: Id, runId: Id, fetchedAt: z.iso.datetime(), localOrderId: Id.nullable(), localLineId: Id.nullable(),
  match: z.enum(["matched", "missing", "ambiguous", "expired", "unavailable"]),
}).strict();
export const ShiposOrderShipmentEvidenceSchema = z.object({
  supplierId: Id, supplierName: z.string(), connectionVersion: z.int().positive(), record: ShiposRecordViewSchema,
  carrierMapping: ShiposCarrierMappingSchema.nullable(), blockers: z.array(z.string()),
}).strict();
export const ShiposRunViewSchema = z.object({
  id: Id, status: z.enum(["running", "completed", "partial", "failed"]), orderNumbers: z.array(ShiposOrderNumberSchema),
  createdAt: z.iso.datetime(), completedAt: z.iso.datetime().nullable(), records: z.array(ShiposRecordViewSchema),
  diagnostic: ShiposDiagnosticSchema.nullable(),
}).strict();
export const ShiposWorkspaceSchema = z.object({
  connection: ShiposConnectionViewSchema.nullable(), runs: z.array(ShiposRunViewSchema),
  recent: z.array(ShiposRecordViewSchema), truncated: z.boolean(),
}).strict();
export type ShiposOrderEvidence = z.infer<typeof ShiposOrderEvidenceSchema>;
export type ShiposRecordView = z.infer<typeof ShiposRecordViewSchema>;
export type ShiposConnectionView = z.infer<typeof ShiposConnectionViewSchema>;
export type ShiposRunView = z.infer<typeof ShiposRunViewSchema>;
export type ShiposWorkspace = z.infer<typeof ShiposWorkspaceSchema>;
export type ShiposCarrierMapping = z.infer<typeof ShiposCarrierMappingSchema>;
export type ShiposShipmentSource = z.infer<typeof ShiposShipmentSourceSchema>;
export type ShiposOrderShipmentEvidence = z.infer<typeof ShiposOrderShipmentEvidenceSchema>;
