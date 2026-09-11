import { z } from "zod";

import { EntityIdSchema } from "@yummyai/contracts/common/ids";

export const AmazonReportBatchStatusSchema = z.enum(["importing", "completed", "partial", "failed"]);
export const AmazonReportLineStateSchema = z.enum(["none", "pending", "processing", "ready", "partial", "failed", "expired"]);

export const AmazonReportImportInputSchema = z.object({
  accountId: EntityIdSchema,
  marketplaceId: z.string().trim().min(1).max(80),
  fileName: z.string().trim().min(1).max(200),
  content: z.string().min(1).max(5 * 1024 * 1024),
}).strict();

export const AmazonReportBatchItemViewSchema = z.object({
  id: EntityIdSchema,
  orderId: EntityIdSchema.nullable(),
  externalOrderId: z.string(),
  status: z.enum(["imported", "duplicate", "failed"]),
  errorCode: z.string().nullable(),
}).strict();

export const AmazonReportBatchViewSchema = z.object({
  id: EntityIdSchema,
  accountId: EntityIdSchema,
  marketplaceId: z.string(),
  fileName: z.string(),
  rowCount: z.number().int().nonnegative(),
  orderCount: z.number().int().nonnegative(),
  newOrderCount: z.number().int().nonnegative(),
  duplicateOrderCount: z.number().int().nonnegative(),
  failedOrderCount: z.number().int().nonnegative(),
  status: AmazonReportBatchStatusSchema,
  createdAt: z.iso.datetime(),
  items: z.array(AmazonReportBatchItemViewSchema).optional(),
}).strict();

export const AmazonReportLineViewSchema = z.object({
  id: EntityIdSchema,
  orderId: EntityIdSchema,
  orderLineId: EntityIdSchema,
  externalOrderId: z.string(),
  externalLineId: z.string(),
  skuCode: z.string().nullable(),
  title: z.string(),
  quantity: z.number().int().positive(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  itemTotalMinor: z.number().int().safe(),
  state: AmazonReportLineStateSchema,
  versionNumber: z.number().int().nonnegative(),
  reviewed: z.boolean(),
  lastErrorCode: z.string().nullable(),
  updatedAt: z.iso.datetime(),
  hasPreview: z.boolean(),
}).strict();

export const AmazonReportWorkspaceViewSchema = z.object({
  batches: z.array(AmazonReportBatchViewSchema),
  lines: z.array(AmazonReportLineViewSchema),
}).strict();

export const AmazonReportFieldViewSchema = z.object({
  key: z.string().min(1).max(1_000),
  label: z.string().max(1_000),
  kind: z.enum(["text", "choice", "image", "unknown"]),
  value: z.string().max(50_000),
  font: z.string().max(1_000).optional(),
  color: z.string().max(1_000).optional(),
}).strict();

export const AmazonReportSurfaceViewSchema = z.object({
  key: z.string().min(1).max(1_000),
  label: z.string().max(1_000),
  fields: z.array(AmazonReportFieldViewSchema).max(500),
  previewFileKey: z.string().nullable(),
  buyerFileKeys: z.array(z.string()).max(200),
}).strict();

export const AmazonReportFileViewSchema = z.object({
  key: z.string().min(1).max(1_000),
  name: z.string().min(1).max(1_000),
  mediaType: z.string().min(1).max(200),
  role: z.enum(["preview", "buyer_image", "source"]),
  byteSize: z.number().int().nonnegative().safe(),
  originalFileKey: z.string().min(1).max(1_000).optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
}).strict();

export const AmazonReportDetailViewSchema = z.object({
  line: AmazonReportLineViewSchema,
  surfaces: z.array(AmazonReportSurfaceViewSchema).max(100),
  files: z.array(AmazonReportFileViewSchema).max(400),
  warnings: z.array(z.string().max(2_000)).max(500),
  versionId: EntityIdSchema.nullable(),
}).strict();

export const AmazonReportRetryInputSchema = z.object({ expectedVersionId: EntityIdSchema.nullable() }).strict();
export const AmazonReportReviewInputSchema = z.object({ expectedVersionId: EntityIdSchema }).strict();

export type AmazonReportBatchStatus = z.infer<typeof AmazonReportBatchStatusSchema>;
export type AmazonReportLineState = z.infer<typeof AmazonReportLineStateSchema>;
export type AmazonReportImportInput = z.infer<typeof AmazonReportImportInputSchema>;
export type AmazonReportBatchItemView = z.infer<typeof AmazonReportBatchItemViewSchema>;
export type AmazonReportBatchView = z.infer<typeof AmazonReportBatchViewSchema>;
export type AmazonReportLineView = z.infer<typeof AmazonReportLineViewSchema>;
export type AmazonReportWorkspaceView = z.infer<typeof AmazonReportWorkspaceViewSchema>;
export type AmazonReportFieldView = z.infer<typeof AmazonReportFieldViewSchema>;
export type AmazonReportSurfaceView = z.infer<typeof AmazonReportSurfaceViewSchema>;
export type AmazonReportFileView = z.infer<typeof AmazonReportFileViewSchema>;
export type AmazonReportDetailView = z.infer<typeof AmazonReportDetailViewSchema>;
export type AmazonReportRetryInput = z.infer<typeof AmazonReportRetryInputSchema>;
export type AmazonReportReviewInput = z.infer<typeof AmazonReportReviewInputSchema>;
