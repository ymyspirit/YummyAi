import { createHash, generateKeyPairSync } from "node:crypto";
import { Permission } from "@yummyai/authz/permissions";
import { erpSessionAuthority, type ErpSessionView } from "@yummyai/contracts/auth/session";
import { StoreNodeEnrollmentCreatedSchema, StoreNodeWorkspaceSchema, type CreateStoreNodeEnrollmentInput } from "@yummyai/contracts/marketplace/store-node";

export const nodeIds = { account: "019f0000-0000-7000-8000-000000000001", actor: "019f0000-0000-7000-8000-000000000002",
  tenant: "019f0000-0000-7000-8000-000000000003", node: "019f0000-0000-7000-8000-000000000004", other: "019f0000-0000-7000-8000-000000000005",
  generation: "019f0000-0000-7000-8000-000000000006", ticket: "019f0000-0000-7000-8000-000000000007" };
export const nodeActor: ErpSessionView = { authenticated: true, canUseErp: true, userId: nodeIds.actor, tenantId: nodeIds.tenant,
  displayName: "Synthetic node operator", organizationName: "Synthetic organization", teamIds: [], dataScope: "tenant",
  permissions: [Permission.StoreRead, Permission.StoreManage, Permission.StoreAuthorize] };
export const nodeAuthority = createHash("sha256").update(erpSessionAuthority(nodeActor)).digest("hex");
export const nodeContext = { accountId: nodeIds.account, actorId: nodeIds.actor, tenantId: nodeIds.tenant, authority: nodeAuthority };
const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 4096 });
export const nodePublicKey = publicKey.export({ format: "pem", type: "spki" }).toString();
export const nodePublicDigest = createHash("sha256").update(publicKey.export({ format: "der", type: "spki" })).digest("hex");
export const nodeInput: CreateStoreNodeEnrollmentInput = { label: "Synthetic isolated node", publicKeyPem: nodePublicKey, idempotencyKey: "d".repeat(64),
  expectedAuthorizationGeneration: nodeIds.generation, expectedBindingRevision: 0 };
const caCertificatePem = "-----BEGIN CERTIFICATE-----\n" + "A".repeat(512) + "\n-----END CERTIFICATE-----\n";
export function nodeWorkspace() {
  return StoreNodeWorkspaceSchema.parse({ protocol: "erp-store-node-v1", accountId: nodeIds.account, authorizationGeneration: nodeIds.generation,
    context: { actorId: nodeIds.actor, tenantId: nodeIds.tenant, authority: nodeAuthority },
    binding: { revision: 0, state: "unbound", nodeId: null, authorizationGeneration: null, leaseExpiresAt: null, effective: false },
    nodes: [{ id: nodeIds.node, label: nodeInput.label, status: "pending_enrollment", certificateGeneration: 1, certificateExpiresAt: null,
      certificateFingerprintSha256: null, publicKeySpkiSha256: nodePublicDigest, lastSeenAt: null, sessionExpiresAt: null, reachability: "never_seen",
      ticketState: "issued", ticketExpiresAt: "2026-10-22T10:10:00.000Z", creationRequestKey: nodeInput.idempotencyKey, createdAt: "2026-10-22T10:00:00.000Z" }],
    access: { manage: true, authorize: true }, configuration: { enabled: true, enrollmentOrigin: "https://enroll.synthetic.test", runtimeOrigin: "https://runtime.synthetic.test", caCertificateSha256: createHash("sha256").update(caCertificatePem).digest("hex") },
    execution: { status: "not_integrated", supportsPlatformOperations: false }, observedAt: "2026-10-22T10:00:00.000Z" });
}
// Transport-only fixture. No certificate is signed and this does not claim PKI acceptance.
export function nodeCreated() {
  return StoreNodeEnrollmentCreatedSchema.parse({ workspace: nodeWorkspace(), enrollment: { protocol: "erp-store-node-v1", nodeId: nodeIds.node,
    accountId: nodeIds.account, certificateGeneration: 1, ticketToken: `stn_${nodeIds.node}.${"a".repeat(43)}`, publicKeySpkiSha256: nodePublicDigest,
    enrollmentOrigin: "https://enroll.synthetic.test", runtimeOrigin: "https://runtime.synthetic.test",
    caCertificatePem, expiresAt: "2026-10-22T10:10:00.000Z" } });
}
export const nodeResponse = (body: unknown, status = 200) => Response.json(body, { status, headers: { "x-yummyai-context-authority": nodeAuthority } });
