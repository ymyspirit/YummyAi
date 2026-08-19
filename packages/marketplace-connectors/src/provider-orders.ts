import { NormalizeOrderInputSchema, type NormalizeOrderInput } from "@yummyai/contracts";
import { z } from "zod";

import type { ProviderOrderRecord } from "./order-ingestion.js";

const AmazonMoneySchema = z.object({ amount: z.string().regex(/^-?\d+(?:\.\d+)?$/), currencyCode: z.string().regex(/^[A-Z]{3}$/) }).passthrough();
const AmazonOrderItemSchema = z.object({
  orderItemId: z.string().min(1),
  product: z.object({ asin: z.string().optional(), sellerSku: z.string().optional(), title: z.string().min(1) }).passthrough(),
  quantityOrdered: z.number().int().positive(),
  unitPrice: AmazonMoneySchema.optional(),
  proceeds: z.object({ total: AmazonMoneySchema }).passthrough().optional(),
  customization: z.array(z.object({ name: z.string().min(1), value: z.string() }).passthrough()).optional(),
}).passthrough();
const AmazonOrderSchema = z.object({
  orderId: z.string().min(1),
  createdTime: z.iso.datetime(),
  lastUpdatedTime: z.iso.datetime(),
  fulfillmentStatus: z.string().min(1),
  salesChannel: z.object({ marketplaceId: z.string().min(1) }).passthrough(),
  orderItems: z.array(AmazonOrderItemSchema).min(1),
  orderTotal: AmazonMoneySchema.optional(),
  proceeds: z.object({ total: AmazonMoneySchema }).passthrough().optional(),
  buyer: z.object({ name: z.string().nullable().optional(), email: z.email().nullable().optional(), phone: z.string().nullable().optional() }).passthrough().optional(),
  recipient: z.object({
    name: z.string().nullable().optional(), addressLines: z.array(z.string()).max(5).optional(), city: z.string().nullable().optional(),
    stateOrRegion: z.string().nullable().optional(), postalCode: z.string().nullable().optional(), countryCode: z.string().length(2).nullable().optional(),
  }).passthrough().optional(),
}).passthrough();

const AmazonOrderChangeSchema = z.object({
  NotificationType: z.literal("ORDER_CHANGE"),
  PayloadVersion: z.literal("1.0"),
  EventTime: z.iso.datetime(),
  Payload: z.object({ OrderChangeNotification: z.object({
    AmazonOrderId: z.string().min(1),
    OrderChangeType: z.string().min(1),
    OrderChangeTrigger: z.object({ TimeOfOrderChange: z.iso.datetime().nullable(), ChangeReason: z.string() }).passthrough(),
    Summary: z.object({ OrderStatus: z.string().min(1), MarketplaceId: z.string().min(1) }).passthrough(),
  }).passthrough() }).passthrough(),
  NotificationMetadata: z.object({ NotificationId: z.string().min(1) }).passthrough(),
}).passthrough();

const EtsyMoneySchema = z.object({ amount: z.number().int(), divisor: z.number().int().positive(), currency_code: z.string().regex(/^[A-Z]{3}$/) }).passthrough();
const EtsyTransactionSchema = z.object({
  transaction_id: z.number().int().positive(), listing_id: z.number().int().nonnegative(), title: z.string().min(1), quantity: z.number().int().positive(),
  sku: z.string().nullable().optional(), price: EtsyMoneySchema,
  variations: z.array(z.object({ formatted_name: z.string().min(1), formatted_value: z.string() }).passthrough()).optional(),
}).passthrough();
const EtsyReceiptSchema = z.object({
  receipt_id: z.number().int().positive(), status: z.string().min(1), created_timestamp: z.number().int().nonnegative(), updated_timestamp: z.number().int().nonnegative(),
  grandtotal: EtsyMoneySchema, transactions: z.array(EtsyTransactionSchema).min(1),
  buyer_email: z.email().nullable().optional(), name: z.string().nullable().optional(), first_line: z.string().nullable().optional(), second_line: z.string().nullable().optional(),
  city: z.string().nullable().optional(), state: z.string().nullable().optional(), zip: z.string().nullable().optional(), country_iso: z.string().length(2).nullable().optional(),
  message_from_buyer: z.string().nullable().optional(),
}).passthrough();

export interface AmazonOrderChangeReference {
  externalEventId: string;
  externalOrderId: string;
  marketplaceId: string;
  providerStatus: string;
  providerUpdatedAt: string;
  buyerRequestedCancellation: boolean;
}

export function normalizeAmazonOrder(accountId: string, externalEventId: string, raw: unknown): ProviderOrderRecord {
  const order = AmazonOrderSchema.parse(raw);
  const total = order.orderTotal ?? order.proceeds?.total;
  if (!total) throw new Error("Amazon order total was not included");
  const lines = order.orderItems.map((line) => {
    const price = line.unitPrice ?? line.proceeds?.total;
    if (!price) throw new Error(`Amazon order item ${line.orderItemId} has no price`);
    return {
      externalLineId: line.orderItemId,
      externalListingId: line.product.asin ?? null,
      skuCode: line.product.sellerSku ?? null,
      title: line.product.title,
      quantity: line.quantityOrdered,
      unitPrice: amazonMoney(price),
      customizationCount: line.customization?.length ?? 0,
    };
  });
  const protectedDetails = amazonProtectedDetails(order);
  const normalized = NormalizeOrderInputSchema.parse({
    accountId,
    platform: "amazon",
    externalEventId,
    externalOrderId: order.orderId,
    providerStatus: order.fulfillmentStatus,
    placedAt: order.createdTime,
    orderTotal: amazonMoney(total),
    lines,
    redactedSource: {
      apiVersion: "2026-01-01", orderId: order.orderId, marketplaceId: order.salesChannel.marketplaceId,
      fulfillmentStatus: order.fulfillmentStatus, lastUpdatedTime: order.lastUpdatedTime,
      orderItemIds: order.orderItems.map((line) => line.orderItemId),
    },
    protectedDetails,
  });
  return { order: normalized, providerUpdatedAt: order.lastUpdatedTime };
}

export function normalizeAmazonOrderChange(raw: unknown): AmazonOrderChangeReference {
  const event = AmazonOrderChangeSchema.parse(raw);
  const change = event.Payload.OrderChangeNotification;
  const reason = change.OrderChangeTrigger.ChangeReason;
  return {
    externalEventId: event.NotificationMetadata.NotificationId,
    externalOrderId: change.AmazonOrderId,
    marketplaceId: change.Summary.MarketplaceId,
    providerStatus: change.Summary.OrderStatus,
    providerUpdatedAt: change.OrderChangeTrigger.TimeOfOrderChange ?? event.EventTime,
    buyerRequestedCancellation: change.OrderChangeType === "BuyerRequestedChange" || /cancel/i.test(reason),
  };
}

export function normalizeEtsyReceipt(accountId: string, raw: unknown): ProviderOrderRecord {
  const receipt = EtsyReceiptSchema.parse(raw);
  const orderId = String(receipt.receipt_id);
  const order = NormalizeOrderInputSchema.parse({
    accountId,
    platform: "etsy",
    externalEventId: `receipt:${orderId}:${receipt.updated_timestamp}`,
    externalOrderId: orderId,
    providerStatus: receipt.status,
    placedAt: epoch(receipt.created_timestamp),
    orderTotal: etsyMoney(receipt.grandtotal),
    lines: receipt.transactions.map((transaction) => ({
      externalLineId: String(transaction.transaction_id),
      externalListingId: transaction.listing_id > 0 ? String(transaction.listing_id) : null,
      skuCode: transaction.sku?.trim() || null,
      title: transaction.title,
      quantity: transaction.quantity,
      unitPrice: etsyMoney(transaction.price),
      customizationCount: (transaction.variations?.length ?? 0) + (receipt.message_from_buyer ? 1 : 0),
    })),
    redactedSource: {
      apiVersion: "etsy-open-api-v3", receiptId: orderId, status: receipt.status, updatedTimestamp: receipt.updated_timestamp,
      transactionIds: receipt.transactions.map((transaction) => String(transaction.transaction_id)),
    },
    protectedDetails: etsyProtectedDetails(receipt),
  });
  return { order, providerUpdatedAt: epoch(receipt.updated_timestamp) };
}

function amazonProtectedDetails(order: z.infer<typeof AmazonOrderSchema>): NormalizeOrderInput["protectedDetails"] {
  if (!order.buyer && !order.recipient && !order.orderItems.some((line) => line.customization?.length)) return null;
  return {
    buyer: { name: order.buyer?.name ?? null, email: order.buyer?.email ?? null, phone: order.buyer?.phone?.trim() || null },
    shippingAddress: {
      recipient: order.recipient?.name ?? null, lines: order.recipient?.addressLines ?? [], city: order.recipient?.city ?? null,
      region: order.recipient?.stateOrRegion ?? null, postalCode: order.recipient?.postalCode ?? null,
      countryCode: order.recipient?.countryCode?.toUpperCase() ?? null,
    },
    customizations: order.orderItems.filter((line) => line.customization?.length).map((line) => ({
      externalLineId: line.orderItemId,
      values: line.customization!.map((entry, index) => ({ key: `amazon:${index}`, label: entry.name, type: "text" as const, value: entry.value })),
    })),
  };
}

function etsyProtectedDetails(receipt: z.infer<typeof EtsyReceiptSchema>): NormalizeOrderInput["protectedDetails"] {
  const addressLines = [receipt.first_line, receipt.second_line].filter((value): value is string => Boolean(value?.trim()));
  const customizations = receipt.transactions.map((transaction) => ({
    externalLineId: String(transaction.transaction_id),
    values: [
      ...(transaction.variations ?? []).map((variation, index) => ({ key: `etsy:variation:${index}`, label: variation.formatted_name, type: "text" as const, value: variation.formatted_value })),
      ...(receipt.message_from_buyer ? [{ key: "etsy:buyer-message", label: "Buyer message", type: "text" as const, value: receipt.message_from_buyer }] : []),
    ],
  })).filter((entry) => entry.values.length > 0);
  if (!receipt.buyer_email && !receipt.name && addressLines.length === 0 && customizations.length === 0) return null;
  return {
    buyer: { name: receipt.name ?? null, email: receipt.buyer_email ?? null, phone: null },
    shippingAddress: {
      recipient: receipt.name ?? null, lines: addressLines, city: receipt.city ?? null, region: receipt.state ?? null,
      postalCode: receipt.zip ?? null, countryCode: receipt.country_iso?.toUpperCase() ?? null,
    },
    customizations,
  };
}

function amazonMoney(value: z.infer<typeof AmazonMoneySchema>) {
  const digits = currencyDigits(value.currencyCode);
  const [whole, fraction = ""] = value.amount.split(".");
  if (fraction.length > digits) throw new Error(`Amazon ${value.currencyCode} amount has too many decimal places`);
  const sign = whole.startsWith("-") ? -1 : 1;
  const magnitude = BigInt(whole.replace("-", "")) * BigInt(10 ** digits) + BigInt(fraction.padEnd(digits, "0") || "0");
  const amountMinor = Number(BigInt(sign) * magnitude);
  if (!Number.isSafeInteger(amountMinor)) throw new Error("Amazon money exceeds safe integer range");
  return { amountMinor, currency: value.currencyCode };
}

function etsyMoney(value: z.infer<typeof EtsyMoneySchema>) {
  const numerator = BigInt(value.amount) * BigInt(10 ** currencyDigits(value.currency_code));
  const divisor = BigInt(value.divisor);
  if (numerator % divisor !== 0n) throw new Error("Etsy money cannot be represented in currency minor units");
  const amountMinor = Number(numerator / divisor);
  if (!Number.isSafeInteger(amountMinor)) throw new Error("Etsy money exceeds safe integer range");
  return { amountMinor, currency: value.currency_code };
}

function currencyDigits(currency: string): number {
  return new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
}

function epoch(seconds: number): string {
  return new Date(seconds * 1_000).toISOString();
}
