import type {
  MarketplacePlatform,
  NormalizeOrderInput,
} from "@yummyai/contracts";
import { z } from "zod";

import type {
  MarketplaceConnectorContext,
  MarketplaceCredentialAccessor,
} from "./connector.js";

const MAX_BACKFILL_DAYS = 30;
const DEFAULT_LATE_UPDATE_OVERLAP_MINUTES = 5;

export const OrderSyncCheckpointSchema = z.object({
  cursor: z.string().trim().min(1).max(4_000).nullable(),
  highWaterAt: z.iso.datetime().nullable(),
  version: z.number().int().positive(),
}).strict();

export const OrderSyncRequestSchema = z.object({
  checkpoint: OrderSyncCheckpointSchema,
  updatedAfter: z.iso.datetime(),
  updatedBefore: z.iso.datetime(),
  pageSize: z.number().int().min(1).max(100),
  maxPages: z.number().int().min(1).max(50),
}).strict().superRefine((value, context) => {
  if (Date.parse(value.updatedAfter) >= Date.parse(value.updatedBefore)) {
    context.addIssue({ code: "custom", path: ["updatedAfter"], message: "updatedAfter must be earlier than updatedBefore" });
  }
});

export const OrderSyncPageMetadataSchema = z.object({
  fetchedAt: z.iso.datetime(),
  highWaterAt: z.iso.datetime(),
  nextCursor: z.string().trim().min(1).max(4_000).nullable(),
  reportedCount: z.number().int().nonnegative().nullable(),
  sourceVersion: z.string().trim().min(1).max(200),
}).strict();

export type OrderSyncCheckpoint = z.infer<typeof OrderSyncCheckpointSchema>;
export type OrderSyncRequest = z.infer<typeof OrderSyncRequestSchema>;
export type OrderSyncPageMetadata = z.infer<typeof OrderSyncPageMetadataSchema>;

export interface ProviderOrderRecord {
  order: NormalizeOrderInput;
  providerUpdatedAt: string;
  requiresCustomizationLineIds?: readonly string[];
  buyerRequestedCancellation?: boolean;
}

export interface ProviderOrderPage extends OrderSyncPageMetadata {
  records: readonly ProviderOrderRecord[];
}

export interface MarketplaceOrderIngestionAdapter {
  readonly platform: MarketplacePlatform;
  fetchPage(
    context: MarketplaceConnectorContext,
    credentials: MarketplaceCredentialAccessor,
    request: OrderSyncRequest,
    signal: AbortSignal,
  ): Promise<ProviderOrderPage>;
}

export interface ExecuteOrderSyncInput {
  adapter: MarketplaceOrderIngestionAdapter;
  context: MarketplaceConnectorContext;
  credentials: MarketplaceCredentialAccessor;
  request: OrderSyncRequest;
  signal: AbortSignal;
  materialize(order: NormalizeOrderInput): Promise<{ replayed: boolean; unlinkedLineIds?: readonly string[] }>;
}

export interface OrderSyncExecutionResult {
  collectedCount: number;
  reportedCount: number | null;
  duplicateCount: number;
  risks: OrderIngestionRisk[];
  sourceVersion: string;
  nextCursor: string | null;
  highWaterAt: string;
  status: "completed" | "partial";
  pageCount: number;
}

export async function executeOrderSync(input: ExecuteOrderSyncInput): Promise<OrderSyncExecutionResult> {
  const request = OrderSyncRequestSchema.parse(input.request);
  if (input.adapter.platform !== input.context.platform) throw new Error("Order adapter platform does not match the marketplace account");
  const records: ProviderOrderRecord[] = [];
  let cursor = request.checkpoint.cursor;
  let reportedCount: number | null = null;
  let sourceVersion: string | null = null;
  let highWaterAt = request.checkpoint.highWaterAt ?? request.updatedAfter;
  let fetchedAt = request.updatedBefore;
  let pageCount = 0;
  const seenCursors = new Set<string>();

  while (pageCount < request.maxPages) {
    if (input.signal.aborted) throw input.signal.reason ?? new Error("Order synchronization was aborted");
    const page = await input.adapter.fetchPage(input.context, input.credentials, {
      ...request,
      checkpoint: { ...request.checkpoint, cursor },
    }, input.signal);
    const metadata = OrderSyncPageMetadataSchema.parse({
      fetchedAt: page.fetchedAt,
      highWaterAt: page.highWaterAt,
      nextCursor: page.nextCursor,
      reportedCount: page.reportedCount,
      sourceVersion: page.sourceVersion,
    });
    if (sourceVersion && sourceVersion !== metadata.sourceVersion) throw new Error("Order source version changed during pagination");
    sourceVersion = metadata.sourceVersion;
    highWaterAt = metadata.highWaterAt;
    fetchedAt = metadata.fetchedAt;
    reportedCount = metadata.reportedCount ?? reportedCount;
    records.push(...page.records);
    pageCount += 1;
    if (!metadata.nextCursor) { cursor = null; break; }
    if (metadata.nextCursor === cursor || seenCursors.has(metadata.nextCursor)) throw new Error("Order adapter returned a repeated page cursor");
    seenCursors.add(metadata.nextCursor);
    cursor = metadata.nextCursor;
  }

  const risks = assessOrderIngestion({ records, fetchedAt });
  const riskIdentities = new Set(risks.map((entry) => `${entry.code}:${entry.externalOrderId}:${entry.externalLineId ?? ""}`));
  let duplicateCount = 0;
  for (const record of records) {
    const result = await input.materialize(record.order);
    if (result.replayed) duplicateCount += 1;
    for (const externalLineId of result.unlinkedLineIds ?? []) {
      const identity = `unsupported_mapping:${record.order.externalOrderId}:${externalLineId}`;
      if (riskIdentities.has(identity)) continue;
      risks.push(risk("unsupported_mapping", "warning", record.order.externalOrderId, externalLineId, "Order line could not be linked to an approved local listing or active SKU"));
      riskIdentities.add(identity);
    }
  }
  return {
    collectedCount: records.length,
    reportedCount,
    duplicateCount,
    risks,
    sourceVersion: sourceVersion ?? "unknown",
    nextCursor: cursor,
    highWaterAt,
    status: cursor ? "partial" : "completed",
    pageCount,
  };
}

export interface PlanOrderSyncInput {
  checkpoint: OrderSyncCheckpoint;
  now: Date;
  requestedBackfillDays?: number;
  pageSize?: number;
  maxPages?: number;
  lateUpdateOverlapMinutes?: number;
}

export function planOrderSync(input: PlanOrderSyncInput): OrderSyncRequest {
  const checkpoint = OrderSyncCheckpointSchema.parse(input.checkpoint);
  const backfillDays = input.requestedBackfillDays ?? 7;
  if (!Number.isInteger(backfillDays) || backfillDays < 1 || backfillDays > MAX_BACKFILL_DAYS) {
    throw new Error(`Order backfill must be between 1 and ${MAX_BACKFILL_DAYS} days`);
  }
  const overlapMinutes = input.lateUpdateOverlapMinutes ?? DEFAULT_LATE_UPDATE_OVERLAP_MINUTES;
  if (!Number.isInteger(overlapMinutes) || overlapMinutes < 0 || overlapMinutes > 60) {
    throw new Error("Late-update overlap must be between 0 and 60 minutes");
  }
  const backfillFloor = input.now.getTime() - backfillDays * 24 * 60 * 60 * 1_000;
  const checkpointFloor = checkpoint.highWaterAt
    ? Date.parse(checkpoint.highWaterAt) - overlapMinutes * 60 * 1_000
    : backfillFloor;
  const updatedAfter = new Date(Math.max(backfillFloor, checkpointFloor)).toISOString();
  return OrderSyncRequestSchema.parse({
    checkpoint,
    updatedAfter,
    updatedBefore: input.now.toISOString(),
    pageSize: input.pageSize ?? 50,
    maxPages: input.maxPages ?? 20,
  });
}

export function advanceOrderCheckpoint(
  current: OrderSyncCheckpoint,
  page: OrderSyncPageMetadata,
): OrderSyncCheckpoint {
  const checkpoint = OrderSyncCheckpointSchema.parse(current);
  const metadata = OrderSyncPageMetadataSchema.parse(page);
  const currentHighWater = checkpoint.highWaterAt ? Date.parse(checkpoint.highWaterAt) : Number.NEGATIVE_INFINITY;
  const pageHighWater = Date.parse(metadata.highWaterAt);
  if (pageHighWater < currentHighWater) throw new Error("Order checkpoint cannot move backwards");
  return OrderSyncCheckpointSchema.parse({
    cursor: metadata.nextCursor,
    highWaterAt: metadata.nextCursor ? checkpoint.highWaterAt : metadata.highWaterAt,
    version: checkpoint.version + 1,
  });
}

export type OrderIngestionRiskCode =
  | "duplicate_delivery"
  | "address_gap"
  | "customization_missing"
  | "unsupported_mapping"
  | "cancellation_requested"
  | "stale_provider_data";

export interface OrderIngestionRisk {
  code: OrderIngestionRiskCode;
  severity: "blocker" | "warning" | "info";
  externalOrderId: string;
  externalLineId: string | null;
  message: string;
}

export interface AssessOrderIngestionInput {
  records: readonly ProviderOrderRecord[];
  fetchedAt: string;
  staleAfterMinutes?: number;
}

export function assessOrderIngestion(input: AssessOrderIngestionInput): OrderIngestionRisk[] {
  const fetchedAt = Date.parse(z.iso.datetime().parse(input.fetchedAt));
  const staleAfterMinutes = input.staleAfterMinutes ?? 30;
  if (!Number.isInteger(staleAfterMinutes) || staleAfterMinutes < 1 || staleAfterMinutes > 24 * 60) {
    throw new Error("Stale threshold must be between 1 and 1440 minutes");
  }
  const risks: OrderIngestionRisk[] = [];
  const deliveries = new Set<string>();
  for (const record of input.records) {
    const order = record.order;
    const deliveryIdentity = `${order.accountId}:${order.platform}:${order.externalEventId}`;
    if (deliveries.has(deliveryIdentity)) {
      risks.push(risk("duplicate_delivery", "info", order.externalOrderId, null, "Duplicate provider delivery was ignored"));
    } else {
      deliveries.add(deliveryIdentity);
    }
    const address = order.protectedDetails?.shippingAddress;
    if (!address || address.lines.length === 0 || !address.countryCode || !address.postalCode) {
      risks.push(risk("address_gap", "blocker", order.externalOrderId, null, "Protected shipping address is incomplete or unavailable"));
    }
    const customizationLines = new Set(order.protectedDetails?.customizations.map((entry) => entry.externalLineId) ?? []);
    for (const externalLineId of record.requiresCustomizationLineIds ?? []) {
      if (!customizationLines.has(externalLineId)) {
        risks.push(risk("customization_missing", "blocker", order.externalOrderId, externalLineId, "Required customization data is unavailable"));
      }
    }
    for (const line of order.lines) {
      if (!line.externalListingId && !line.skuCode) {
        risks.push(risk("unsupported_mapping", "warning", order.externalOrderId, line.externalLineId, "Order line has no listing or SKU mapping reference"));
      }
    }
    if (record.buyerRequestedCancellation || /cancel(?:led|ed|ation|_requested)/i.test(order.providerStatus)) {
      risks.push(risk("cancellation_requested", "blocker", order.externalOrderId, null, "Provider reports a cancellation request or cancelled state"));
    }
    const providerUpdatedAt = Date.parse(z.iso.datetime().parse(record.providerUpdatedAt));
    if (fetchedAt - providerUpdatedAt > staleAfterMinutes * 60 * 1_000) {
      risks.push(risk("stale_provider_data", "warning", order.externalOrderId, null, "Provider order data is older than the configured freshness threshold"));
    }
  }
  return risks;
}

function risk(
  code: OrderIngestionRiskCode,
  severity: OrderIngestionRisk["severity"],
  externalOrderId: string,
  externalLineId: string | null,
  message: string,
): OrderIngestionRisk {
  return { code, severity, externalOrderId, externalLineId, message };
}
