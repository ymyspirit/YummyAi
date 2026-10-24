import { z } from "zod";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";

export const STORE_NODE_PROTOCOL = "erp-store-node-v1" as const;
const Protocol = z.literal(STORE_NODE_PROTOCOL), Digest = z.string().regex(/^[a-f0-9]{64}$/), Instant = z.iso.datetime();
export const StoreNodePublicKeySchema = z.string().min(400).max(8192).startsWith("-----BEGIN PUBLIC KEY-----\n").endsWith("-----END PUBLIC KEY-----\n");
const Certificate = z.string().min(400).max(16384).startsWith("-----BEGIN CERTIFICATE-----\n").endsWith("-----END CERTIFICATE-----\n");
export const StoreNodeMutationFenceSchema = z.object({ expectedAuthorizationGeneration:z.uuid(), expectedBindingRevision:z.int().nonnegative() }).strict();
export const CreateStoreNodeEnrollmentInputSchema = StoreNodeMutationFenceSchema.extend({ label:z.string().trim().min(1).max(80),
  publicKeyPem:StoreNodePublicKeySchema, idempotencyKey:Digest }).strict();
export const StoreNodeGenerationFenceSchema = StoreNodeMutationFenceSchema.extend({ expectedCertificateGeneration:z.int().positive() }).strict();
export const BindStoreNodeInputSchema = StoreNodeGenerationFenceSchema.extend({ nodeId:EntityIdSchema }).strict();
export const StoreNodeEnrollmentBundleSchema = z.object({ protocol:Protocol,nodeId:EntityIdSchema,accountId:EntityIdSchema,
  certificateGeneration:z.int().positive(),ticketToken:z.string().regex(/^stn_[a-f0-9-]{36}\.[A-Za-z0-9_-]{43}$/),
  publicKeySpkiSha256:Digest,enrollmentOrigin:z.url().startsWith("https://"),runtimeOrigin:z.url().startsWith("https://"),
  caCertificatePem:Certificate,expiresAt:Instant }).strict();
export const StoreNodeEnrollInputSchema = z.object({ protocol:Protocol,nodeId:EntityIdSchema,ticketToken:StoreNodeEnrollmentBundleSchema.shape.ticketToken,
  publicKeyPem:StoreNodePublicKeySchema,signature:z.string().regex(/^[A-Za-z0-9_-]{512,1024}$/) }).strict();
export const StoreNodeEnrollmentResultSchema = z.object({ protocol:Protocol,nodeId:EntityIdSchema,accountId:EntityIdSchema,
  certificateGeneration:z.int().positive(),certificatePem:Certificate,caCertificatePem:Certificate,runtimeOrigin:z.url().startsWith("https://"),expiresAt:Instant }).strict();
export const StoreNodeHeartbeatInputSchema = z.object({ protocol:Protocol,nodeId:EntityIdSchema,certificateGeneration:z.int().positive(),
  sessionId:EntityIdSchema,sequence:z.int().positive().max(2147483647) }).strict();
export const StoreNodeBindingStateSchema = z.enum(["unbound","active","draining"]);
export const StoreNodeHeartbeatViewSchema = z.object({ protocol:Protocol,nodeId:EntityIdSchema,accountId:EntityIdSchema,
  certificateGeneration:z.int().positive(),sessionId:EntityIdSchema,sequence:z.int().positive(),observedAt:Instant,sessionExpiresAt:Instant,
  bindingRevision:z.int().nonnegative(),bindingState:StoreNodeBindingStateSchema,authorizationGeneration:z.uuid(),execution:z.literal("not_integrated") }).strict();
export const StoreNodeViewSchema = z.object({ id:EntityIdSchema,label:z.string().min(1).max(80),status:z.enum(["pending_enrollment","enrolled","revoked"]),
  certificateGeneration:z.int().positive(),certificateExpiresAt:Instant.nullable(),certificateFingerprintSha256:Digest.nullable(),publicKeySpkiSha256:Digest,
  lastSeenAt:Instant.nullable(),sessionExpiresAt:Instant.nullable(),reachability:z.enum(["never_seen","online","offline"]),
  ticketState:z.enum(["none","issued","claimed","consumed","expired"]),ticketExpiresAt:Instant.nullable(),creationRequestKey:Digest,createdAt:Instant }).strict();
export const StoreNodeWorkspaceSchema = z.object({ protocol:Protocol,accountId:EntityIdSchema,authorizationGeneration:z.uuid(),
  context:z.object({actorId:EntityIdSchema,tenantId:EntityIdSchema,authority:Digest}).strict(),
  binding:z.object({revision:z.int().nonnegative(),state:StoreNodeBindingStateSchema,nodeId:EntityIdSchema.nullable(),
    authorizationGeneration:z.uuid().nullable(),leaseExpiresAt:Instant.nullable(),effective:z.boolean()}).strict(),
  nodes:z.array(StoreNodeViewSchema).max(100),access:z.object({manage:z.boolean(),authorize:z.boolean()}).strict(),
  configuration:z.object({enabled:z.boolean(),enrollmentOrigin:z.url().nullable(),runtimeOrigin:z.url().nullable(),caCertificateSha256:Digest.nullable()}).strict(),
  execution:z.object({status:z.literal("not_integrated"),supportsPlatformOperations:z.literal(false)}).strict(),observedAt:Instant }).strict();
export const StoreNodeEnrollmentCreatedSchema = z.object({workspace:StoreNodeWorkspaceSchema,enrollment:StoreNodeEnrollmentBundleSchema}).strict();
export type StoreNodeMutationFence=z.infer<typeof StoreNodeMutationFenceSchema>;
export type CreateStoreNodeEnrollmentInput=z.infer<typeof CreateStoreNodeEnrollmentInputSchema>;
export type StoreNodeGenerationFence=z.infer<typeof StoreNodeGenerationFenceSchema>;
export type BindStoreNodeInput=z.infer<typeof BindStoreNodeInputSchema>;
export type StoreNodeEnrollmentBundle=z.infer<typeof StoreNodeEnrollmentBundleSchema>;
export type StoreNodeEnrollInput=z.infer<typeof StoreNodeEnrollInputSchema>;
export type StoreNodeEnrollmentResult=z.infer<typeof StoreNodeEnrollmentResultSchema>;
export type StoreNodeHeartbeatInput=z.infer<typeof StoreNodeHeartbeatInputSchema>;
export type StoreNodeHeartbeatView=z.infer<typeof StoreNodeHeartbeatViewSchema>;
export type StoreNodeWorkspace=z.infer<typeof StoreNodeWorkspaceSchema>;
export type StoreNodeEnrollmentCreated=z.infer<typeof StoreNodeEnrollmentCreatedSchema>;
export function storeNodeEnrollmentProofText(nodeId:string,ticketSha256:string,publicKeySpkiSha256:string):string {
  return JSON.stringify(["erp-store-node-enroll-v1",EntityIdSchema.parse(nodeId),Digest.parse(ticketSha256),Digest.parse(publicKeySpkiSha256)]);
}
