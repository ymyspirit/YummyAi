import { NormalizeOrderInputSchema, type NormalizeOrderInput } from "@yummyai/contracts";
import { z } from "zod";

import type { ProviderOrderRecord } from "./order-ingestion.js";

const AmazonMoneySchema = z.object({ amount: z.string().regex(/^-?\d+(?:\.\d+)?$/), currencyCode: z.string().regex(/^[A-Z]{3}$/) }).passthrough();
const AmazonAddressSchema = z.object({
  name: z.string().nullish(), addressLines: z.array(z.string()).max(5).optional(),
  addressLine1: z.string().nullish(), addressLine2: z.string().nullish(), addressLine3: z.string().nullish(),
  city: z.string().nullish(), stateOrRegion: z.string().nullish(), postalCode: z.string().nullish(),
  countryCode: z.string().length(2).nullish(), phone: z.string().nullish(),
}).passthrough();
const AmazonOrderItemSchema = z.object({
  orderItemId: z.string().min(1),
  product: z.object({
    asin: z.string().optional(), sellerSku: z.string().optional(), title: z.string().min(1),
    price: z.object({ unitPrice: AmazonMoneySchema.optional() }).passthrough().optional(),
    customization: z.object({ customizedUrl: z.url({ protocol: /^https$/ }).max(1_000).nullish() }).passthrough().nullish(),
  }).passthrough(),
  quantityOrdered: z.number().int().positive(),
  unitPrice: AmazonMoneySchema.optional(),
  proceeds: z.object({ proceedsTotal: AmazonMoneySchema.optional(),
    breakdowns: z.array(z.object({ type: z.string(), subtotal: AmazonMoneySchema }).passthrough()).optional(),
  }).passthrough().optional(),
  cancellation: z.object({ cancellationRequest: z.object({ requester: z.string().optional() }).passthrough().optional(),
    cancellationExecution: z.object({ cancelledBy: z.string().optional() }).passthrough().optional(),
  }).passthrough().optional(),
  customization: z.array(z.object({ name: z.string().min(1), value: z.string() }).passthrough()).optional(),
}).passthrough();
const AmazonOrderSchema = z.object({
  orderId: z.string().min(1),
  createdTime: z.iso.datetime(),
  lastUpdatedTime: z.iso.datetime(),
  fulfillmentStatus: z.string().min(1).optional(),
  fulfillment: z.object({
    fulfillmentStatus: z.string().min(1).optional(),
    fulfilledBy: z.string().min(1).optional(),
    shipByWindow: z.object({ latestDateTime: z.iso.datetime({ offset: true }).nullish() }).passthrough().nullish(),
  }).passthrough().optional(),
  salesChannel: z.object({ marketplaceId: z.string().min(1) }).passthrough(),
  orderItems: z.array(AmazonOrderItemSchema).min(1),
  orderTotal: AmazonMoneySchema.optional(),
  proceeds: z.object({ total: AmazonMoneySchema.optional(), grandTotal: AmazonMoneySchema.optional() }).passthrough().optional(),
  buyer: z.object({ buyerName: z.string().nullish(), buyerEmail: z.email().nullish(),
    name: z.string().nullish(), email: z.email().nullish(), phone: z.string().nullish() }).passthrough().optional(),
  recipient: AmazonAddressSchema.extend({ deliveryAddress: AmazonAddressSchema.nullish() }).optional(),
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
  const providerStatus = order.fulfillment?.fulfillmentStatus ?? order.fulfillmentStatus;
  if (!providerStatus) throw new Error("Amazon fulfillment status was not included");
  if (order.fulfillment?.fulfillmentStatus && order.fulfillmentStatus && order.fulfillment.fulfillmentStatus !== order.fulfillmentStatus)
    throw new Error("Amazon fulfillment statuses conflict");
  const total = order.proceeds?.grandTotal ?? order.orderTotal ?? order.proceeds?.total;
  const lines = order.orderItems.map((line) => {
    const price = line.product.price?.unitPrice ?? line.unitPrice;
    const itemTotal = amazonItemTotal(line);
    return {
      externalLineId: line.orderItemId,
      externalListingId: line.product.asin ?? null,
      skuCode: line.product.sellerSku ?? null,
      title: line.product.title,
      quantity: line.quantityOrdered,
      unitPrice: price ? amazonMoney(price) : itemTotal && itemTotal.amountMinor % line.quantityOrdered === 0
        ? { ...itemTotal, amountMinor: itemTotal.amountMinor / line.quantityOrdered } : null,
      customizationCount: (line.customization?.length ?? 0) + (line.product.customization ? 1 : 0),
    };
  });
  const protectedDetails = amazonProtectedDetails(order);
  const platformShipByAt = order.fulfillment?.shipByWindow?.latestDateTime;
  const normalized = NormalizeOrderInputSchema.parse({
    accountId,
    platform: "amazon",
    externalEventId,
    externalOrderId: order.orderId,
    providerStatus,
    placedAt: order.createdTime,
    orderTotal: total ? amazonMoney(total) : null,
    lines,
    redactedSource: {
      apiVersion: "2026-01-01", orderId: order.orderId, marketplaceId: order.salesChannel.marketplaceId,
      fulfillmentStatus: providerStatus, lastUpdatedTime: order.lastUpdatedTime,
      fulfilledBy: order.fulfillment?.fulfilledBy ?? null,
      cancellationRequestedLineIds: order.orderItems.filter(line => line.cancellation?.cancellationRequest).map(line => line.orderItemId),
      cancelledLineIds: order.orderItems.filter(line => line.cancellation?.cancellationExecution).map(line => line.orderItemId),
      itemTotals: order.orderItems.flatMap(line => { const amount = amazonItemTotal(line); return amount ? [{ externalLineId: line.orderItemId, ...amount }] : []; }),
      orderItemIds: order.orderItems.map((line) => line.orderItemId),
      platformShipByAt: platformShipByAt ? new Date(platformShipByAt).toISOString() : null,
      platformShipBySource: "amazon_orders_2026_fulfillment_ship_by_window",
      platformShipByField: "fulfillment.shipByWindow.latestDateTime",
    },
    protectedDetails,
  });
  return { order: normalized, providerUpdatedAt: order.lastUpdatedTime,
    buyerRequestedCancellation: order.orderItems.some(line => line.cancellation?.cancellationRequest?.requester === "BUYER"),
    requiresCustomizationLineIds: order.orderItems.filter(line => line.product.customization || line.customization?.length).map(line => line.orderItemId) };
}

function amazonItemTotal(line: z.infer<typeof AmazonOrderItemSchema>) {
  const items = line.proceeds?.breakdowns?.filter(item => item.type === "ITEM") ?? [];
  if (items.length > 1) throw new Error("Amazon item proceeds are ambiguous");
  return items[0] ? amazonMoney(items[0].subtotal) : null;
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
  const customizations = order.orderItems.map(line => ({
    externalLineId: line.orderItemId,
    values: [
      ...(line.customization ?? []).map((entry, index) => ({ key: `amazon:${index}`, label: entry.name, type: "text" as const, value: entry.value })),
      ...(line.product.customization?.customizedUrl ? [{ key: "amazon:customized-url", label: "Amazon Custom file", type: "file_reference" as const,
        externalReference: line.product.customization.customizedUrl }] : []),
    ],
  })).filter(line => line.values.length);
  if (!order.buyer && !order.recipient && !customizations.length) return null;
  // A supplied official address, even redacted or partial, must not fall back to legacy address fields.
  const nestedAddress = order.recipient?.deliveryAddress !== undefined;
  const address = nestedAddress ? order.recipient?.deliveryAddress : order.recipient;
  const name = order.buyer?.buyerName !== undefined ? order.buyer.buyerName : order.buyer?.name;
  const email = order.buyer?.buyerEmail !== undefined ? order.buyer.buyerEmail : order.buyer?.email;
  return {
    buyer: { name: name?.trim() || null, email: email ?? null, phone: order.buyer?.phone?.trim() || null },
    shippingAddress: {
      recipient: address?.name?.trim() || null,
      lines: (nestedAddress ? [address?.addressLine1, address?.addressLine2, address?.addressLine3] : address?.addressLines ?? [])
        .map(line => line?.trim() ?? "").filter(Boolean),
      city: address?.city?.trim() || null, region: address?.stateOrRegion?.trim() || null, postalCode: address?.postalCode?.trim() || null,
      countryCode: address?.countryCode?.toUpperCase() ?? null,
      ...(nestedAddress || address?.phone !== undefined ? { phone: address?.phone?.trim() || null } : {}),
    },
    customizations,
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
