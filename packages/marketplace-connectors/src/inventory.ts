import {
  NetworkStockConditionSchema,
  NetworkStockSourceSchema,
  type NetworkStockCondition,
  type NetworkStockSource,
} from "@yummyai/contracts/channel-inventory";
import { z } from "zod";

export const ProviderInventoryCheckpointSchema = z.object({
  sequence: z.number().int().positive(),
  cursor: z.string().min(1).max(2_000).nullable(),
}).strict();

export const ProviderInventoryRequestSchema = z.object({
  marketplaceId: z.string().min(1).max(80),
  checkpoint: ProviderInventoryCheckpointSchema.nullable(),
}).strict();

const AmazonInventoryRecordSchema = z.object({
  sellerSku: z.string().min(1).max(200),
  fulfillmentChannel: z.enum(["FBA", "AFN", "FBM", "MFN", "DEFAULT"]),
  condition: z.enum(["SELLABLE", "QUARANTINE", "DAMAGED", "DEFECTIVE", "UNSELLABLE"]),
  quantity: z.number().int().nonnegative(),
  warehouseCode: z.string().min(1).max(200).nullable().default(null),
}).strict();

const EtsyInventoryRecordSchema = z.object({
  sku: z.string().min(1).max(200),
  quantity: z.number().int().nonnegative(),
}).strict();

const ThirdPartyInventoryRecordSchema = z.object({
  sku: z.string().min(1).max(200),
  networkRole: z.enum(["owned", "overseas_3pl", "supplier", "in_transit", "virtual"]),
  condition: NetworkStockConditionSchema,
  quantity: z.number().int().nonnegative(),
  warehouseCode: z.string().min(1).max(200).nullable().default(null),
}).strict();

export const ProviderInventoryReportSchema = z.discriminatedUnion("provider", [
  z.object({
    provider: z.literal("amazon"),
    providerSnapshotId: z.string().min(1).max(300).nullable(),
    observedAt: z.iso.datetime(),
    checkpoint: ProviderInventoryCheckpointSchema,
    records: z.array(AmazonInventoryRecordSchema).max(100_000),
  }).strict(),
  z.object({
    provider: z.literal("etsy"),
    providerSnapshotId: z.string().min(1).max(300).nullable(),
    observedAt: z.iso.datetime(),
    checkpoint: ProviderInventoryCheckpointSchema,
    records: z.array(EtsyInventoryRecordSchema).max(100_000),
  }).strict(),
  z.object({
    provider: z.literal("third_party"),
    providerSnapshotId: z.string().min(1).max(300).nullable(),
    observedAt: z.iso.datetime(),
    checkpoint: ProviderInventoryCheckpointSchema,
    records: z.array(ThirdPartyInventoryRecordSchema).max(100_000),
  }).strict(),
]);

export const NormalizedProviderInventoryLineSchema = z.object({
  externalSku: z.string().min(1).max(200),
  source: NetworkStockSourceSchema,
  condition: NetworkStockConditionSchema,
  quantity: z.number().int().nonnegative(),
  warehouseCode: z.string().nullable(),
}).strict();

export const NormalizedProviderInventoryReportSchema = z.object({
  provider: z.enum(["amazon", "etsy", "third_party"]),
  providerSnapshotId: z.string().nullable(),
  observedAt: z.iso.datetime(),
  checkpoint: ProviderInventoryCheckpointSchema,
  lines: z.array(NormalizedProviderInventoryLineSchema),
}).strict();

export interface MarketplaceInventoryConnector {
  pull(input: z.infer<typeof ProviderInventoryRequestSchema>): Promise<z.infer<typeof ProviderInventoryReportSchema>>;
}

export function normalizeProviderInventoryReport(
  rawReport: z.input<typeof ProviderInventoryReportSchema>,
): z.infer<typeof NormalizedProviderInventoryReportSchema> {
  const report = ProviderInventoryReportSchema.parse(rawReport);
  const lines = report.provider === "amazon"
    ? report.records.map((record) => ({
        externalSku: record.sellerSku,
        source: amazonSource(record.fulfillmentChannel),
        condition: amazonCondition(record.condition),
        quantity: record.quantity,
        warehouseCode: record.warehouseCode,
      }))
    : report.provider === "etsy"
      ? report.records.map((record) => ({
          externalSku: record.sku,
          source: "fbm" as const,
          condition: "sellable" as const,
          quantity: record.quantity,
          warehouseCode: null,
        }))
      : report.records.map((record) => ({
          externalSku: record.sku,
          source: record.networkRole,
          condition: record.condition,
          quantity: record.quantity,
          warehouseCode: record.warehouseCode,
        }));
  return NormalizedProviderInventoryReportSchema.parse({
    provider: report.provider,
    providerSnapshotId: report.providerSnapshotId,
    observedAt: report.observedAt,
    checkpoint: report.checkpoint,
    lines,
  });
}

function amazonSource(channel: "FBA" | "AFN" | "FBM" | "MFN" | "DEFAULT"): NetworkStockSource {
  return channel === "FBA" || channel === "AFN" ? "fba" : "fbm";
}

function amazonCondition(
  condition: "SELLABLE" | "QUARANTINE" | "DAMAGED" | "DEFECTIVE" | "UNSELLABLE",
): NetworkStockCondition {
  if (condition === "SELLABLE") return "sellable";
  if (condition === "QUARANTINE") return "quarantine";
  return "damaged";
}

export type ProviderInventoryCheckpoint = z.infer<typeof ProviderInventoryCheckpointSchema>;
export type ProviderInventoryRequest = z.infer<typeof ProviderInventoryRequestSchema>;
export type ProviderInventoryReport = z.infer<typeof ProviderInventoryReportSchema>;
export type NormalizedProviderInventoryLine = z.infer<typeof NormalizedProviderInventoryLineSchema>;
export type NormalizedProviderInventoryReport = z.infer<typeof NormalizedProviderInventoryReportSchema>;
