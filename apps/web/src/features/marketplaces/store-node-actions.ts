import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import { BindStoreNodeInputSchema, CreateStoreNodeEnrollmentInputSchema, StoreNodeEnrollmentCreatedSchema, StoreNodeGenerationFenceSchema,
  StoreNodeWorkspaceSchema, type BindStoreNodeInput, type CreateStoreNodeEnrollmentInput, type StoreNodeGenerationFence,
  type StoreNodeEnrollmentCreated, type StoreNodeWorkspace } from "@yummyai/contracts/marketplace/store-node";
import { readMarketplaceJson } from "./marketplace-lifecycle";
import { StoreNodeRequestError, readStoreNodeError, storeNodeEnrollmentMatches, storeNodeMutationMatches, storeNodePublicKeyDigest, storeNodeWorkspaceMatches } from "./store-node-lifecycle";

export type StoreNodeRequestContext = { accountId: string; actorId: string; tenantId: string; authority: string; signal?: AbortSignal };
async function request(context: StoreNodeRequestContext, suffix: string, body?: unknown, status = 200): Promise<unknown> {
  const account = EntityIdSchema.parse(context.accountId.toLowerCase());
  if (!/^[a-f0-9]{64}$/.test(context.authority)) throw new StoreNodeRequestError(409, "authority_changed");
  const submitted = body !== undefined;
  try {
    context.signal?.throwIfAborted();
    const response = await fetch(`/api/marketplace-accounts/${account}/nodes${suffix}`, { method: submitted ? "POST" : "GET", cache: "no-store",
      signal: AbortSignal.any([...(context.signal ? [context.signal] : []), AbortSignal.timeout(submitted ? 120000 : 20000)]),
      headers: { "x-yummyai-context-authority": context.authority, ...(submitted ? { "content-type": "application/json" } : {}) },
      ...(submitted ? { body: JSON.stringify(body) } : {}) });
    if (!response.ok) throw new StoreNodeRequestError(response.status, await readStoreNodeError(response), submitted);
    const result = await readMarketplaceJson(response, 1024 * 1024);
    if (response.headers.get("x-yummyai-context-authority") !== context.authority) throw new StoreNodeRequestError(409, "authority_changed", submitted);
    if (response.status !== status) throw new StoreNodeRequestError(502, undefined, submitted);
    return result;
  } catch (error) { throw error instanceof StoreNodeRequestError ? error : new StoreNodeRequestError(0, undefined, submitted); }
}
export async function readStoreNodes(context: StoreNodeRequestContext): Promise<StoreNodeWorkspace> {
  const parsed = StoreNodeWorkspaceSchema.safeParse(await request(context, ""));
  if (!parsed.success) throw new StoreNodeRequestError(502);
  if (!storeNodeWorkspaceMatches(parsed.data, context)) throw new StoreNodeRequestError(409, "authority_changed");
  return parsed.data;
}
async function enrollment(context: StoreNodeRequestContext, path: string, input: CreateStoreNodeEnrollmentInput | StoreNodeGenerationFence,
  nodeId?: string, publicKeyDigest?: string): Promise<StoreNodeEnrollmentCreated> {
  const parsed = StoreNodeEnrollmentCreatedSchema.safeParse(await request(context, path, input, 201));
  if (!parsed.success) throw new StoreNodeRequestError(502, undefined, true);
  if (!storeNodeWorkspaceMatches(parsed.data.workspace, context)) throw new StoreNodeRequestError(409, "authority_changed", true);
  if (!await storeNodeEnrollmentMatches(parsed.data, nodeId) ||
    parsed.data.workspace.authorizationGeneration !== input.expectedAuthorizationGeneration ||
    publicKeyDigest && parsed.data.enrollment.publicKeySpkiSha256 !== publicKeyDigest) throw new StoreNodeRequestError(502, undefined, true);
  const node = parsed.data.workspace.nodes.find(value => value.id.toLowerCase() === parsed.data.enrollment.nodeId.toLowerCase())!;
  if ("idempotencyKey" in input ? node.creationRequestKey !== input.idempotencyKey || node.label !== input.label :
    parsed.data.enrollment.certificateGeneration !== input.expectedCertificateGeneration + 1) throw new StoreNodeRequestError(502, undefined, true);
  return parsed.data;
}
export async function createStoreNodeEnrollment(context: StoreNodeRequestContext, raw: CreateStoreNodeEnrollmentInput) {
  const input = CreateStoreNodeEnrollmentInputSchema.parse(raw), digest = await storeNodePublicKeyDigest(input.publicKeyPem);
  context.signal?.throwIfAborted();
  return enrollment(context, "/enrollments", input, undefined, digest);
}
export async function reissueStoreNodeEnrollment(context: StoreNodeRequestContext, nodeId: string, raw: StoreNodeGenerationFence) {
  const id = EntityIdSchema.parse(nodeId.toLowerCase());
  return enrollment(context, `/${id}/enrollment`, StoreNodeGenerationFenceSchema.parse(raw), id);
}
async function mutate(context: StoreNodeRequestContext, path: string, input: BindStoreNodeInput | StoreNodeGenerationFence, operation: "bind" | "revoke", nodeId: string) {
  const parsed = StoreNodeWorkspaceSchema.safeParse(await request(context, path, input));
  if (!parsed.success) throw new StoreNodeRequestError(502, undefined, true);
  if (!storeNodeWorkspaceMatches(parsed.data, context)) throw new StoreNodeRequestError(409, "authority_changed", true);
  if (parsed.data.authorizationGeneration !== input.expectedAuthorizationGeneration ||
    parsed.data.binding.revision < input.expectedBindingRevision || !storeNodeMutationMatches(parsed.data, operation, input, nodeId)) throw new StoreNodeRequestError(502, undefined, true);
  return parsed.data;
}
export const bindStoreNode = (context: StoreNodeRequestContext, raw: BindStoreNodeInput) => mutate(context, "/binding", BindStoreNodeInputSchema.parse(raw), "bind", raw.nodeId);
export const revokeStoreNode = (context: StoreNodeRequestContext, nodeId: string, raw: StoreNodeGenerationFence) =>
  mutate(context, `/${EntityIdSchema.parse(nodeId.toLowerCase())}/revoke`, StoreNodeGenerationFenceSchema.parse(raw), "revoke", nodeId);
