import { z } from "zod";

import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import { DataScopeSchema } from "@yummyai/contracts/tenant/tenant-context";
import { ErpContextAuthoritySchema } from "@yummyai/contracts/auth/session";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";

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
  scopeLimits: z.partialRecord(IntegrationApiScopeSchema, DataScopeSchema).optional(),
  teamIds: z.array(EntityIdSchema).max(200).optional(),
}).strict().superRefine((value, context) => {
  if (new Set(value.scopes).size !== value.scopes.length) context.addIssue({ code: "custom", path: ["scopes"], message: "API client scopes must be unique" });
  if (value.scopeLimits && (Object.keys(value.scopeLimits).length !== value.scopes.length || value.scopes.some(scope => value.scopeLimits![scope] === undefined))) context.addIssue({ code: "custom", path: ["scopeLimits"], message: "Scope limits must exactly cover the selected permissions" });
  if (value.teamIds && new Set(value.teamIds).size !== value.teamIds.length) context.addIssue({ code: "custom", path: ["teamIds"], message: "Team IDs must be unique" });
});
// Structural validation is time independent: an uncertain original POST remains
// replayable after its expiry. Only a genuinely new birth checks the DB clock.
export function integrationApiClientRequestCanonical(value: unknown) {
  return canonicalJson(CreateIntegrationApiClientInputSchema.parse(value));
}
const ScopeLimitsSchema = z.partialRecord(IntegrationApiScopeSchema, DataScopeSchema);
export const IntegrationApiDelegationSchema = z.object({
  version: z.literal("integration-api-delegation-v1"), membershipId: EntityIdSchema,
  permissionScopes: ScopeLimitsSchema, teamIds: z.array(EntityIdSchema).max(200),
  capturedAt: z.iso.datetime(), requestChecksum: ChecksumSchema,
}).strict().superRefine((value, context) => {
  if (!Object.keys(value.permissionScopes).length || new Set(value.teamIds).size !== value.teamIds.length)
    context.addIssue({ code: "custom", message: "Delegation requires explicit permissions and unique teams" });
});
export const IntegrationClientAdmissionSchema = z.object({
  scopes: z.array(z.object({ scope: IntegrationApiScopeSchema, maximumScope: DataScopeSchema }).strict()).max(9),
  teamIds: z.array(EntityIdSchema).max(200), canManage: z.boolean(),
}).strict();
export const IntegrationAgentCapabilitySchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_.-]{1,99}$/), version: z.literal("erp-agent-catalog-v1"),
  domain: z.enum(["research", "catalog", "creative", "orders", "manufacturing", "procurement", "inventory", "logistics", "finance", "advertising", "knowledge"]),
  title: z.string().min(1).max(120), effect: z.enum(["read", "analyze", "prepare", "execute", "result"]),
  requiredPermissions: z.array(z.string().min(1).max(128)).min(1).max(16), minimumScope: DataScopeSchema,
  ownerState: z.enum(["existing", "planned"]), agentState: z.enum(["adapter_pending", "unauthorized"]),
  callableViaAgent: z.literal(false),
}).strict();
export const IntegrationAgentCatalogSchema = z.object({
  contextAuthority: ErpContextAuthoritySchema, version: z.literal("erp-agent-catalog-v1"),
  mcpState: z.literal("not_connected"), capabilities: z.array(IntegrationAgentCapabilitySchema).max(128),
}).strict();
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

export const IntegrationApiClientViewSchema = z.object({ id: EntityIdSchema, label: z.string(), keyPrefix: z.string(), scopes: z.array(IntegrationApiScopeSchema), status: z.enum(["active", "revoked"]), expiresAt: z.iso.datetime().nullable(), createdAt: z.iso.datetime(), revokedAt: z.iso.datetime().nullable(), delegation: IntegrationApiDelegationSchema.nullable(), credentialState: z.enum(["pinned", "revoked", "expired", "requires_reissue"]) }).strict();
export const CreatedIntegrationApiClientViewSchema = z.object({ contextAuthority: ErpContextAuthoritySchema, client: IntegrationApiClientViewSchema, bearerToken: z.string().min(40).nullable() }).strict();
export const RevokedIntegrationApiClientViewSchema = z.object({ contextAuthority: ErpContextAuthoritySchema, client: IntegrationApiClientViewSchema }).strict();
export const WebhookEndpointViewSchema = z.object({ id: EntityIdSchema, label: z.string(), url: z.string(), eventTypes: z.array(WebhookEventTypeSchema), maxAttempts: z.number().int(), status: z.enum(["active", "disabled"]), version: z.number().int().positive(), signingKeyPrefix: z.string(), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime() }).strict();
export const CreatedWebhookEndpointViewSchema = z.object({ endpoint: WebhookEndpointViewSchema, signingSecret: z.string().min(32).nullable() }).strict();
export const WebhookDeliveryAttemptViewSchema = z.object({ id: EntityIdSchema, attemptNumber: z.number().int().positive(), requestTimestamp: z.iso.datetime(), signatureVersion: z.literal("v1"), responseStatus: z.number().int().min(100).max(599).nullable(), outcome: z.enum(["succeeded", "retryable_failure", "terminal_failure"]), failureCode: CodeSchema.nullable(), completedAt: z.iso.datetime() }).strict();
export const WebhookDeliveryViewSchema = z.object({ id: EntityIdSchema, eventId: EntityIdSchema, endpointId: EntityIdSchema, status: WebhookDeliveryStatusSchema, attemptCount: z.number().int().nonnegative(), maxAttempts: z.number().int().positive(), nextAttemptAt: z.iso.datetime().nullable(), replayOfDeliveryId: EntityIdSchema.nullable(), createdAt: z.iso.datetime(), completedAt: z.iso.datetime().nullable(), attempts: z.array(WebhookDeliveryAttemptViewSchema) }).strict();
export const WebhookEventViewSchema = z.object({ id: EntityIdSchema, eventType: WebhookEventTypeSchema, resourceType: z.string(), resourceId: EntityIdSchema, payloadChecksum: ChecksumSchema, payloadAvailable: z.boolean(), occurredAt: z.iso.datetime(), recordedAt: z.iso.datetime() }).strict();
export const IntegrationRetentionRunViewSchema = z.object({ id: EntityIdSchema, payloadsBefore: z.iso.datetime(), redactedEventCount: z.number().int().nonnegative(), checksum: ChecksumSchema, completedAt: z.iso.datetime() }).strict();
export const IntegrationWorkspaceViewSchema = z.object({ contextAuthority: ErpContextAuthoritySchema, clientAdmission: IntegrationClientAdmissionSchema, agentCatalog: IntegrationAgentCatalogSchema, apiClients: z.array(IntegrationApiClientViewSchema), webhookEndpoints: z.array(WebhookEndpointViewSchema), webhookEvents: z.array(WebhookEventViewSchema), webhookDeliveries: z.array(WebhookDeliveryViewSchema), retentionRuns: z.array(IntegrationRetentionRunViewSchema) }).strict();

export type IntegrationApiScope = z.infer<typeof IntegrationApiScopeSchema>;
export type IntegrationApiDelegation = z.infer<typeof IntegrationApiDelegationSchema>;
export type IntegrationClientAdmission = z.infer<typeof IntegrationClientAdmissionSchema>;
export type IntegrationAgentCapability = z.infer<typeof IntegrationAgentCapabilitySchema>;
export type IntegrationAgentCatalog = z.infer<typeof IntegrationAgentCatalogSchema>;
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
