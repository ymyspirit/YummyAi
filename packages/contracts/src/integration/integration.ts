import { z } from "zod";

import { EntityIdSchema } from "@yummyai/contracts/common/ids";

const IdempotencyKeySchema = z.string().trim().min(8).max(200);
const CodeSchema = z.string().trim().min(1).max(100).regex(/^[A-Z0-9][A-Z0-9._-]*$/);
const ChecksumSchema = z.string().regex(/^[a-f0-9]{64}$/);
const SecureUrlSchema = z.url().refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
}, "Webhook URL must use HTTPS unless it targets loopback");

export const IntegrationApiScopeSchema = z.enum([
  "forecast:read", "operations:read", "inventory:read", "finance:read", "customer_intelligence:read",
  "supplier_performance:read", "order:read", "product:read", "listing:read",
]);
export const WebhookEventTypeSchema = z.enum([
  "forecast.completed", "forecast.overridden", "operating.reconciliation.opened",
  "operating.reconciliation.resolved", "webhook.test",
]);
export const WebhookDeliveryStatusSchema = z.enum(["pending", "delivering", "retry_scheduled", "succeeded", "dead_letter"]);

export const CreateIntegrationApiClientInputSchema = z.object({
  label: z.string().trim().min(1).max(120),
  scopes: z.array(IntegrationApiScopeSchema).min(1).max(20),
  expiresAt: z.iso.datetime().nullable().default(null),
  idempotencyKey: IdempotencyKeySchema,
}).strict().superRefine((value, context) => {
  if (new Set(value.scopes).size !== value.scopes.length) context.addIssue({ code: "custom", path: ["scopes"], message: "API client scopes must be unique" });
  if (value.expiresAt && new Date(value.expiresAt) <= new Date()) context.addIssue({ code: "custom", path: ["expiresAt"], message: "API client expiry must be in the future" });
});
export const RevokeIntegrationApiClientInputSchema = z.object({ expectedStatus: z.literal("active"), reasonCode: CodeSchema, idempotencyKey: IdempotencyKeySchema }).strict();

export const CreateWebhookEndpointInputSchema = z.object({
  label: z.string().trim().min(1).max(120),
  url: SecureUrlSchema,
  eventTypes: z.array(WebhookEventTypeSchema).min(1).max(20),
  maxAttempts: z.number().int().min(1).max(10).default(5),
  idempotencyKey: IdempotencyKeySchema,
}).strict().superRefine((value, context) => {
  if (new Set(value.eventTypes).size !== value.eventTypes.length) context.addIssue({ code: "custom", path: ["eventTypes"], message: "Webhook event types must be unique" });
});
export const UpdateWebhookEndpointInputSchema = z.object({
  expectedVersion: z.number().int().positive(), status: z.enum(["active", "disabled"]), url: SecureUrlSchema,
  eventTypes: z.array(WebhookEventTypeSchema).min(1).max(20), maxAttempts: z.number().int().min(1).max(10), reasonCode: CodeSchema, idempotencyKey: IdempotencyKeySchema,
}).strict();
export const RotateWebhookSecretInputSchema = z.object({ expectedVersion: z.number().int().positive(), reasonCode: CodeSchema, idempotencyKey: IdempotencyKeySchema }).strict();
export const PublishWebhookEventInputSchema = z.object({ eventType: WebhookEventTypeSchema, resourceType: z.string().trim().min(1).max(100), resourceId: EntityIdSchema, payload: z.record(z.string(), z.unknown()), occurredAt: z.iso.datetime(), idempotencyKey: IdempotencyKeySchema }).strict();
export const ReplayWebhookDeliveryInputSchema = z.object({ expectedStatus: z.literal("dead_letter"), reasonCode: CodeSchema, idempotencyKey: IdempotencyKeySchema }).strict();
export const RunIntegrationRetentionInputSchema = z.object({ payloadsBefore: z.iso.datetime(), idempotencyKey: IdempotencyKeySchema }).strict();

export const IntegrationApiClientViewSchema = z.object({ id: EntityIdSchema, label: z.string(), keyPrefix: z.string(), scopes: z.array(IntegrationApiScopeSchema), status: z.enum(["active", "revoked"]), expiresAt: z.iso.datetime().nullable(), createdAt: z.iso.datetime(), revokedAt: z.iso.datetime().nullable() }).strict();
export const CreatedIntegrationApiClientViewSchema = z.object({ client: IntegrationApiClientViewSchema, bearerToken: z.string().min(40).nullable() }).strict();
export const WebhookEndpointViewSchema = z.object({ id: EntityIdSchema, label: z.string(), url: z.string(), eventTypes: z.array(WebhookEventTypeSchema), maxAttempts: z.number().int(), status: z.enum(["active", "disabled"]), version: z.number().int().positive(), signingKeyPrefix: z.string(), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime() }).strict();
export const CreatedWebhookEndpointViewSchema = z.object({ endpoint: WebhookEndpointViewSchema, signingSecret: z.string().min(32).nullable() }).strict();
export const WebhookDeliveryAttemptViewSchema = z.object({ id: EntityIdSchema, attemptNumber: z.number().int().positive(), requestTimestamp: z.iso.datetime(), signatureVersion: z.literal("v1"), responseStatus: z.number().int().min(100).max(599).nullable(), outcome: z.enum(["succeeded", "retryable_failure", "terminal_failure"]), failureCode: CodeSchema.nullable(), completedAt: z.iso.datetime() }).strict();
export const WebhookDeliveryViewSchema = z.object({ id: EntityIdSchema, eventId: EntityIdSchema, endpointId: EntityIdSchema, status: WebhookDeliveryStatusSchema, attemptCount: z.number().int().nonnegative(), maxAttempts: z.number().int().positive(), nextAttemptAt: z.iso.datetime().nullable(), replayOfDeliveryId: EntityIdSchema.nullable(), createdAt: z.iso.datetime(), completedAt: z.iso.datetime().nullable(), attempts: z.array(WebhookDeliveryAttemptViewSchema) }).strict();
export const WebhookEventViewSchema = z.object({ id: EntityIdSchema, eventType: WebhookEventTypeSchema, resourceType: z.string(), resourceId: EntityIdSchema, payloadChecksum: ChecksumSchema, payloadAvailable: z.boolean(), occurredAt: z.iso.datetime(), recordedAt: z.iso.datetime() }).strict();
export const IntegrationRetentionRunViewSchema = z.object({ id: EntityIdSchema, payloadsBefore: z.iso.datetime(), redactedEventCount: z.number().int().nonnegative(), checksum: ChecksumSchema, completedAt: z.iso.datetime() }).strict();
export const IntegrationWorkspaceViewSchema = z.object({ apiClients: z.array(IntegrationApiClientViewSchema), webhookEndpoints: z.array(WebhookEndpointViewSchema), webhookEvents: z.array(WebhookEventViewSchema), webhookDeliveries: z.array(WebhookDeliveryViewSchema), retentionRuns: z.array(IntegrationRetentionRunViewSchema) }).strict();

export type IntegrationApiScope = z.infer<typeof IntegrationApiScopeSchema>;
export type WebhookEventType = z.infer<typeof WebhookEventTypeSchema>;
export type WebhookDeliveryStatus = z.infer<typeof WebhookDeliveryStatusSchema>;
export type CreateIntegrationApiClientInput = z.infer<typeof CreateIntegrationApiClientInputSchema>;
export type RevokeIntegrationApiClientInput = z.infer<typeof RevokeIntegrationApiClientInputSchema>;
export type CreateWebhookEndpointInput = z.infer<typeof CreateWebhookEndpointInputSchema>;
export type UpdateWebhookEndpointInput = z.infer<typeof UpdateWebhookEndpointInputSchema>;
export type RotateWebhookSecretInput = z.infer<typeof RotateWebhookSecretInputSchema>;
export type PublishWebhookEventInput = z.infer<typeof PublishWebhookEventInputSchema>;
export type ReplayWebhookDeliveryInput = z.infer<typeof ReplayWebhookDeliveryInputSchema>;
export type RunIntegrationRetentionInput = z.infer<typeof RunIntegrationRetentionInputSchema>;
export type IntegrationApiClientView = z.infer<typeof IntegrationApiClientViewSchema>;
export type WebhookEndpointView = z.infer<typeof WebhookEndpointViewSchema>;
export type WebhookDeliveryView = z.infer<typeof WebhookDeliveryViewSchema>;
export type WebhookEventView = z.infer<typeof WebhookEventViewSchema>;
export type IntegrationWorkspaceView = z.infer<typeof IntegrationWorkspaceViewSchema>;
