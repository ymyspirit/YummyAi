import { authorize } from "@yummyai/authz/authorize";
import { Permission } from "@yummyai/authz/permissions";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import { CancelStoreNodeExecutionInputSchema, CreateStoreNodeExecutionInputSchema, StoreNodeExecutionHistorySchema, StoreNodeExecutionReceiptInputSchema,
  StoreNodeExecutionReceiptSchema, StoreNodeExecutionViewSchema, StoreNodeExecutionWorkspaceSchema, STORE_NODE_EXECUTION_WIRE_BYTES,
  storeNodeExecutionRequestText } from "@yummyai/contracts/marketplace/store-node-execution";
import { apiFetch } from "../../../../../../server-api";
import { assertErpIdentityCurrent, erpAuthFailure, erpRequestIdentity } from "../../../../../../erp-auth/server";
import { PersonalSessionError } from "../../../../../../identity/core";
import { readMarketplaceJson } from "../../../../../../features/marketplaces/marketplace-lifecycle";
import { readStoreNodeExecutionCode, StoreNodeExecutionError, storeNodeExecutionHash, storeNodeExecutionSameId,
  verifyStoreNodeExecutionHistory, verifyStoreNodeExecutionView, verifyStoreNodeExecutionWorkspace, type StoreNodeExecutionCode } from "../../../../../../features/marketplaces/store-node-execution-client";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string; path?: string[] }> };
const headers = { "cache-control": "private, no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" };
const failure = (status: number, code?: StoreNodeExecutionCode) => Response.json({ message: status === 403 ? "当前无本店节点任务权限" :
  status === 400 || status === 413 ? "节点任务请求格式需核对" : status === 409 ? "原节点或本人依据已变化 请只读取原任务核对" :
    "节点任务暂时无法核对 请保留原请求标识", ...(code ? { code } : {}) }, { status, headers });
async function handle(request: Request, context: Context, post: boolean) {
  try {
    const params = await context.params, account = EntityIdSchema.safeParse(params.id.toLowerCase()), path = params.path ?? [], url = new URL(request.url);
    if (!account.success || path.some(part => !part || part.includes("/"))) return failure(400);
    const id = path[0] ? EntityIdSchema.safeParse(path[0].toLowerCase()) : null;
    const mode = post ? path.length === 0 ? "create" : path.length === 1 && path[0] === "receipt" ? "receipt" :
      path.length === 2 && id?.success && path[1] === "cancel" ? "cancel" : null : path.length === 0 ? "workspace" :
      path.length === 1 && path[0] === "history" ? "history" : path.length === 1 && id?.success ? "view" : null;
    if (!mode) return failure(400);
    let before: string | undefined;
    if (mode === "history") {
      for (const key of url.searchParams.keys()) if (key !== "before" || url.searchParams.getAll(key).length !== 1) return failure(400);
      if (url.searchParams.has("before")) { const parsed = EntityIdSchema.safeParse(url.searchParams.get("before")?.toLowerCase()); if (!parsed.success) return failure(400); before = parsed.data; }
    } else if (url.search) return failure(400);
    if (post && request.headers.get("origin") !== url.origin) return failure(403);
    const identity = await erpRequestIdentity(request);
    try { authorize(identity.view, Permission.StoreRead); if (mode === "create" || mode === "cancel") authorize(identity.view, Permission.StoreManage); }
    catch { return failure(403); }
    if (request.headers.get("x-yummyai-context-authority") !== identity.authority) throw new PersonalSessionError(409, "authority_changed");
    let input: unknown;
    if (post) {
      try { input = await readMarketplaceJson(request as unknown as Response, 32768); } catch { return failure(400); }
      const parsed = (mode === "create" ? CreateStoreNodeExecutionInputSchema : mode === "receipt" ? StoreNodeExecutionReceiptInputSchema : CancelStoreNodeExecutionInputSchema).safeParse(input);
      if (!parsed.success) return failure(400); input = parsed.data;
      if (mode === "create") { const original = CreateStoreNodeExecutionInputSchema.parse(input);
        if (await storeNodeExecutionHash(storeNodeExecutionRequestText(account.data, original)) !== original.requestChecksum) return failure(400); }
    }
    await assertErpIdentityCurrent(identity);
    const base = process.env.API_BASE_URL?.replace(/\/$/, ""); if (!base) return failure(503);
    const suffix = mode === "history" ? `/history${before ? `?before=${before}` : ""}` : mode === "receipt" ? "/receipt" :
      mode === "view" || mode === "cancel" ? `/${id!.success ? id!.data : ""}${mode === "cancel" ? "/cancel" : ""}` : "";
    const upstream = await apiFetch(`${base}/v1/marketplace-accounts/${account.data}/node-executions${suffix}`, { method: post ? "POST" : "GET", cache: "no-store",
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(mode === "create" || mode === "cancel" ? 120000 : 30000)]),
      headers: { "x-yummyai-context-authority": identity.authority, ...(post ? { "content-type": "application/json" } : {}) },
      ...(post ? { body: JSON.stringify(input) } : {}) });
    if (!upstream.ok) { const code = await readStoreNodeExecutionCode(upstream); await assertErpIdentityCurrent(identity);
      return failure([400, 401, 403, 404, 409, 412, 413, 422, 503].includes(upstream.status) ? upstream.status : 502, code); }
    const raw = await readMarketplaceJson(upstream, mode === "workspace" || mode === "history" ? 1024 * 1024 : STORE_NODE_EXECUTION_WIRE_BYTES);
    await assertErpIdentityCurrent(identity);
    if (upstream.status !== (mode === "create" ? 201 : 200)) return failure(502);
    if (upstream.headers.has("x-yummyai-context-authority") && upstream.headers.get("x-yummyai-context-authority") !== identity.authority) return failure(409, "authority_changed");
    let result: unknown;
    if (mode === "workspace") {
      const value = StoreNodeExecutionWorkspaceSchema.parse(raw);
      verifyStoreNodeExecutionWorkspace(value, { accountId: account.data, actorId: identity.view.userId, tenantId: identity.view.tenantId, authority: identity.authority }); result = value;
    } else if (mode === "history") {
      const value = StoreNodeExecutionHistorySchema.parse(raw); verifyStoreNodeExecutionHistory(value, account.data, before); result = value;
    } else if (mode === "receipt") {
      const query = StoreNodeExecutionReceiptInputSchema.parse(input), value = StoreNodeExecutionReceiptSchema.parse(raw);
      if (!storeNodeExecutionSameId(value.accountId, account.data) || !storeNodeExecutionSameId(value.requestId, query.requestId) || value.requestChecksum !== query.requestChecksum) return failure(502);
      if (value.execution) await verifyStoreNodeExecutionView(value.execution, account.data, query); result = value;
    } else {
      const value = StoreNodeExecutionViewSchema.parse(raw);
      if (mode === "create") await verifyStoreNodeExecutionView(value, account.data, CreateStoreNodeExecutionInputSchema.parse(input));
      else await verifyStoreNodeExecutionView(value, account.data, { id: id!.success ? id!.data : "", ...(mode === "cancel" ? CancelStoreNodeExecutionInputSchema.parse(input) : {}) });
      result = value;
    }
    await assertErpIdentityCurrent(identity);
    return Response.json(result, { status: mode === "create" ? 201 : 200, headers: { ...headers, "x-yummyai-context-authority": identity.authority } });
  } catch (error) {
    if (error instanceof PersonalSessionError) return erpAuthFailure(error, request);
    if (error instanceof StoreNodeExecutionError && error.status === 409) return failure(409, error.code);
    return failure(502);
  }
}
export const GET = (request: Request, context: Context) => handle(request, context, false);
export const POST = (request: Request, context: Context) => handle(request, context, true);
