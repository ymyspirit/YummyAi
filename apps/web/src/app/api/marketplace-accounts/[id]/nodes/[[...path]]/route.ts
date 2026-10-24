import { authorize } from "@yummyai/authz/authorize";
import { Permission } from "@yummyai/authz/permissions";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import { BindStoreNodeInputSchema, CreateStoreNodeEnrollmentInputSchema, StoreNodeEnrollmentCreatedSchema, StoreNodeGenerationFenceSchema,
  StoreNodeWorkspaceSchema } from "@yummyai/contracts/marketplace/store-node";
import { apiFetch } from "../../../../../../server-api";
import { assertErpIdentityCurrent, erpAuthFailure, erpRequestIdentity } from "../../../../../../erp-auth/server";
import { PersonalSessionError } from "../../../../../../identity/core";
import { readMarketplaceJson } from "../../../../../../features/marketplaces/marketplace-lifecycle";
import { readStoreNodeError, storeNodeEnrollmentMatches, storeNodeMutationMatches, storeNodePublicKeyDigest, storeNodeWorkspaceMatches, type StoreNodeErrorCode } from "../../../../../../features/marketplaces/store-node-lifecycle";

export const dynamic = "force-dynamic";
type RouteContext = { params: Promise<{ id: string; path?: string[] }> };
const headers = { "cache-control": "private, no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" };
const fail = (status: number, code?: StoreNodeErrorCode) => Response.json({ message: status === 403 ? "当前无本店节点操作权限" : status === 409 ?
  "节点授权或版本已变化 请只读取原状态核对" : status === 400 || status === 413 ? "节点请求格式需核对" : "节点请求未完成 请读取原节点状态核对", ...(code ? { code } : {}) }, { status, headers });
async function handle(request: Request, context: RouteContext, write: boolean) {
  try {
    const params = await context.params, id = EntityIdSchema.safeParse(params.id?.toLowerCase()), parts = params.path ?? [];
    if (!id.success || new URL(request.url).search || parts.some(value => !value || value.includes("/"))) return fail(400);
    const mode = !write && parts.length === 0 ? "read" : write && parts.length === 1 && parts[0] === "enrollments" ? "create" :
      write && parts.length === 1 && parts[0] === "binding" ? "bind" : write && parts.length === 2 && EntityIdSchema.safeParse(parts[0]?.toLowerCase()).success &&
        parts[1] === "enrollment" ? "reissue" : write && parts.length === 2 && EntityIdSchema.safeParse(parts[0]?.toLowerCase()).success && parts[1] === "revoke" ? "revoke" : null;
    if (!mode) return fail(400);
    if (write && request.headers.get("origin") !== new URL(request.url).origin) return fail(403);
    const identity = await erpRequestIdentity(request);
    try { authorize(identity.view, Permission.StoreRead); if (write) { authorize(identity.view, Permission.StoreManage); authorize(identity.view, Permission.StoreAuthorize); } }
    catch { return fail(403); }
    if (request.headers.get("x-yummyai-context-authority") !== identity.authority) throw new PersonalSessionError(409, "authority_changed");
    let input;
    if (write) {
      let raw: unknown;
      try { raw = await readMarketplaceJson(request as unknown as Response, 32768); } catch { return fail(400); }
      const parsed = (mode === "create" ? CreateStoreNodeEnrollmentInputSchema : mode === "bind" ? BindStoreNodeInputSchema : StoreNodeGenerationFenceSchema).safeParse(raw);
      if (!parsed.success) return fail(400);
      input = parsed.data;
      await assertErpIdentityCurrent(identity);
    }
    const base = process.env.API_BASE_URL?.replace(/\/$/, ""); if (!base) return fail(503);
    const suffix = mode === "read" ? "" : mode === "create" ? "/enrollments" : mode === "bind" ? "/binding" : `/${parts[0]!.toLowerCase()}/${parts[1]}`;
    const upstream = await apiFetch(`${base}/v1/marketplace-accounts/${id.data}/nodes${suffix}`, { method: write ? "POST" : "GET", cache: "no-store",
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(write ? 120000 : 20000)]),
      headers: { "x-yummyai-context-authority": identity.authority, ...(write ? { "content-type": "application/json" } : {}) },
      ...(write ? { body: JSON.stringify(input) } : {}) });
    if (!upstream.ok) { const code = await readStoreNodeError(upstream); await assertErpIdentityCurrent(identity);
      return fail([400, 401, 403, 404, 409, 412, 413, 422, 503].includes(upstream.status) ? upstream.status : 502, code); }
    const raw = await readMarketplaceJson(upstream, 1024 * 1024);
    await assertErpIdentityCurrent(identity);
    const created = mode === "create" || mode === "reissue";
    const parsed = created ? StoreNodeEnrollmentCreatedSchema.safeParse(raw) : StoreNodeWorkspaceSchema.safeParse(raw);
    if (upstream.status !== (created ? 201 : 200) || !parsed.success) return fail(502);
    const workspace = "workspace" in parsed.data ? parsed.data.workspace : parsed.data;
    if (!storeNodeWorkspaceMatches(workspace, { accountId: id.data, actorId: identity.view.userId, tenantId: identity.view.tenantId, authority: identity.authority }) ||
      upstream.headers.has("x-yummyai-context-authority") && upstream.headers.get("x-yummyai-context-authority") !== identity.authority) return fail(409, "authority_changed");
    if (input && (workspace.authorizationGeneration !== input.expectedAuthorizationGeneration || workspace.binding.revision < input.expectedBindingRevision)) return fail(502);
    if (mode === "bind") { const bound = BindStoreNodeInputSchema.safeParse(input);
      if (!bound.success || !storeNodeMutationMatches(workspace, "bind", bound.data, bound.data.nodeId)) return fail(502); }
    if (mode === "revoke" && (!input || !("expectedCertificateGeneration" in input) || !storeNodeMutationMatches(workspace, "revoke", input, parts[0]!))) return fail(502);
    const issued = "enrollment" in parsed.data ? parsed.data : null;
    if (issued && (!await storeNodeEnrollmentMatches(issued, mode === "reissue" ? parts[0] : undefined) ||
      mode === "create" && (!input || !("idempotencyKey" in input) || workspace.nodes.find(node => node.id.toLowerCase() === issued.enrollment.nodeId.toLowerCase())?.creationRequestKey !== input.idempotencyKey ||
        workspace.nodes.find(node => node.id.toLowerCase() === issued.enrollment.nodeId.toLowerCase())?.label !== input.label || issued.enrollment.publicKeySpkiSha256 !== await storeNodePublicKeyDigest(input.publicKeyPem)) ||
      mode === "reissue" && (!input || !("expectedCertificateGeneration" in input) || issued.enrollment.certificateGeneration !== input.expectedCertificateGeneration + 1))) return fail(502);
    await assertErpIdentityCurrent(identity);
    return Response.json(parsed.data, { status: created ? 201 : 200, headers: { ...headers, "x-yummyai-context-authority": identity.authority } });
  } catch (error) { return error instanceof PersonalSessionError ? erpAuthFailure(error, request) : fail(502); }
}
export const GET = (request: Request, context: RouteContext) => handle(request, context, false);
export const POST = (request: Request, context: RouteContext) => handle(request, context, true);
