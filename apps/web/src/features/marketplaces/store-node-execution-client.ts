import { z } from "zod";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import { CancelStoreNodeExecutionInputSchema, CreateStoreNodeExecutionInputSchema, StoreNodeExecutionErrorSchema,
  StoreNodeExecutionHistorySchema, StoreNodeExecutionReceiptInputSchema, StoreNodeExecutionReceiptSchema, StoreNodeExecutionViewSchema,
  StoreNodeExecutionWorkspaceSchema, STORE_NODE_EXECUTION_WIRE_BYTES, storeNodeExecutionRequestText,
  type CreateStoreNodeExecutionInput, type StoreNodeExecutionHistory, type StoreNodeExecutionReceipt, type StoreNodeExecutionView,
  type StoreNodeExecutionWorkspace } from "@yummyai/contracts/marketplace/store-node-execution";
import { readMarketplaceJson } from "./marketplace-lifecycle";
import { StoreNodeErrorCodeSchema } from "./store-node-lifecycle";

const Code = z.union([StoreNodeExecutionErrorSchema, StoreNodeErrorCodeSchema, z.enum(["store_node_execution_request_conflict",
  "store_node_execution_not_found", "store_node_execution_not_cancellable", "marketplace_credential_busy", "marketplace_credential_refresh_unknown"])]);
export type StoreNodeExecutionCode = z.infer<typeof Code>;
export class StoreNodeExecutionError extends Error {
  constructor(readonly status: number, readonly code?: StoreNodeExecutionCode, readonly submitted = false) { super("store_node_execution_request_failed"); }
}
export const storeNodeExecutionDenied = (error: StoreNodeExecutionError) => [401, 403, 404].includes(error.status) || error.status === 409 &&
  ["authority_changed", "marketplace_authority_changed", "store_node_authority_changed", "store_node_member_changed", "store_node_membership_changed"].includes(error.code ?? "");
export function storeNodeExecutionErrorText(error: StoreNodeExecutionError) {
  if (storeNodeExecutionDenied(error)) return "本店或本人权限已变化 原执行资料已隐藏 请重新读取";
  if (error.code === "store_node_not_configured" || error.code === "store_node_configuration_invalid") return "节点执行配置尚未就绪 不会改走中央连接";
  if (error.code === "marketplace_credential_refresh_unknown") return "原凭据刷新结果未知 请核对原任务并重新授权 不会重试平台请求";
  if (error.code === "marketplace_credential_busy") return "原凭据正在使用 请只读取原任务状态";
  if (error.submitted && (error.status === 0 || error.status >= 500)) return "原任务保存或取消结果未知 请只读取原回执 不会换键再建任务";
  if ([409, 412].includes(error.status)) return "原节点 授权或任务依据已变化 请重新读取 原请求保持不变";
  if ([400, 413, 422].includes(error.status)) return "同步填写需核对 请保留原请求标识 不提交秘密值";
  return "节点执行资料暂时无法核对 请重新读取";
}
export const storeNodeExecutionSameId = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();
export async function storeNodeExecutionHash(text: string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))), value => value.toString(16).padStart(2, "0")).join("");
}
export async function readStoreNodeExecutionCode(response: Response) {
  try { const value = z.object({ code: Code }).passthrough().safeParse(await readMarketplaceJson(response, 8192)); return value.success ? value.data.code : undefined; }
  catch { return undefined; }
}
export async function verifyStoreNodeExecutionView(value: StoreNodeExecutionView, accountId: string, expected?: { id?: string; requestId?: string; requestChecksum?: string }) {
  const input = CreateStoreNodeExecutionInputSchema.parse({ nodeId: value.nodeId, certificateGeneration: value.certificateGeneration,
    authorizationGeneration: value.authorizationGeneration, bindingRevision: value.bindingRevision, requestId: value.requestId,
    requestChecksum: value.requestChecksum, operation: value.operation, input: value.input });
  if (await storeNodeExecutionHash(storeNodeExecutionRequestText(accountId, input)) !== value.requestChecksum ||
    expected?.id && !storeNodeExecutionSameId(expected.id, value.id) || expected?.requestId && !storeNodeExecutionSameId(expected.requestId, value.requestId) ||
    expected?.requestChecksum && expected.requestChecksum !== value.requestChecksum || value.snapshot &&
    (!storeNodeExecutionSameId(value.snapshot.accountId, accountId) || value.snapshotId !== value.snapshot.id || value.snapshotVersion !== value.snapshot.version || value.state !== "succeeded"))
    throw new StoreNodeExecutionError(502);
}
export function verifyStoreNodeExecutionHistory(value: StoreNodeExecutionHistory, accountId: string, before?: string) {
  if (!storeNodeExecutionSameId(value.accountId, accountId) || new Set(value.items.map(row => row.id.toLowerCase())).size !== value.items.length ||
    value.hasMore !== (value.nextCursor !== null) || value.nextCursor && (!value.items.length || value.nextCursor !== value.items.at(-1)!.id) ||
    before && value.items.some(row => row.id.toLowerCase() >= before.toLowerCase())) throw new StoreNodeExecutionError(502);
}
export type StoreNodeExecutionContext = { accountId: string; actorId: string; tenantId: string; authority: string; signal?: AbortSignal };
export function verifyStoreNodeExecutionWorkspace(value: StoreNodeExecutionWorkspace, context: StoreNodeExecutionContext) {
  if (!storeNodeExecutionSameId(value.accountId, context.accountId) || !storeNodeExecutionSameId(value.context.actorId, context.actorId) ||
    !storeNodeExecutionSameId(value.context.tenantId, context.tenantId) || value.context.authority !== context.authority)
    throw new StoreNodeExecutionError(409, "authority_changed");
  if (new Set(value.recent.map(row => row.id.toLowerCase())).size !== value.recent.length) throw new StoreNodeExecutionError(502);
}
async function request(context: StoreNodeExecutionContext, suffix = "", body?: unknown, status = 200): Promise<unknown> {
  const id = EntityIdSchema.parse(context.accountId.toLowerCase()), submitted = body !== undefined && suffix !== "/receipt";
  try {
    if (!/^[a-f0-9]{64}$/.test(context.authority)) throw new StoreNodeExecutionError(409, "authority_changed");
    context.signal?.throwIfAborted();
    const response = await fetch(`/api/marketplace-accounts/${id}/node-executions${suffix}`, { method: body === undefined ? "GET" : "POST", cache: "no-store",
      signal: AbortSignal.any([...(context.signal ? [context.signal] : []), AbortSignal.timeout(submitted ? 120000 : 30000)]),
      headers: { "x-yummyai-context-authority": context.authority, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!response.ok) throw new StoreNodeExecutionError(response.status, await readStoreNodeExecutionCode(response), submitted);
    const value = await readMarketplaceJson(response, STORE_NODE_EXECUTION_WIRE_BYTES);
    if (response.headers.get("x-yummyai-context-authority") !== context.authority) throw new StoreNodeExecutionError(409, "authority_changed", submitted);
    if (response.status !== status) throw new StoreNodeExecutionError(502, undefined, submitted);
    context.signal?.throwIfAborted(); return value;
  } catch (error) { throw error instanceof StoreNodeExecutionError ? error : new StoreNodeExecutionError(0, undefined, submitted); }
}
export async function readStoreNodeExecutionWorkspace(context: StoreNodeExecutionContext) {
  const parsed = StoreNodeExecutionWorkspaceSchema.safeParse(await request(context)); if (!parsed.success) throw new StoreNodeExecutionError(502);
  verifyStoreNodeExecutionWorkspace(parsed.data, context); return parsed.data;
}
export async function readStoreNodeExecution(context: StoreNodeExecutionContext, executionId: string): Promise<StoreNodeExecutionView> {
  const id = EntityIdSchema.parse(executionId.toLowerCase()), parsed = StoreNodeExecutionViewSchema.safeParse(await request(context, `/${id}`));
  if (!parsed.success) throw new StoreNodeExecutionError(502); await verifyStoreNodeExecutionView(parsed.data, context.accountId, { id }); return parsed.data;
}
export async function readStoreNodeExecutionReceipt(context: StoreNodeExecutionContext, raw: { requestId: string; requestChecksum: string }): Promise<StoreNodeExecutionReceipt> {
  const input = StoreNodeExecutionReceiptInputSchema.parse(raw), parsed = StoreNodeExecutionReceiptSchema.safeParse(await request(context, "/receipt", input));
  if (!parsed.success || !storeNodeExecutionSameId(parsed.data.accountId, context.accountId) || !storeNodeExecutionSameId(parsed.data.requestId, input.requestId) || parsed.data.requestChecksum !== input.requestChecksum)
    throw new StoreNodeExecutionError(502);
  if (parsed.data.execution) await verifyStoreNodeExecutionView(parsed.data.execution, context.accountId, input); return parsed.data;
}
export async function readStoreNodeExecutionHistory(context: StoreNodeExecutionContext, before?: string) {
  const cursor = before === undefined ? undefined : EntityIdSchema.parse(before.toLowerCase()), parsed = StoreNodeExecutionHistorySchema.safeParse(await request(context, `/history${cursor ? `?before=${cursor}` : ""}`));
  if (!parsed.success) throw new StoreNodeExecutionError(502); verifyStoreNodeExecutionHistory(parsed.data, context.accountId, cursor); return parsed.data;
}
export async function createStoreNodeExecution(context: StoreNodeExecutionContext, raw: CreateStoreNodeExecutionInput) {
  const input = CreateStoreNodeExecutionInputSchema.parse(raw);
  if (await storeNodeExecutionHash(storeNodeExecutionRequestText(context.accountId, input)) !== input.requestChecksum) throw new StoreNodeExecutionError(400);
  context.signal?.throwIfAborted();
  const parsed = StoreNodeExecutionViewSchema.safeParse(await request(context, "", input, 201));
  if (!parsed.success) throw new StoreNodeExecutionError(502, undefined, true);
  try { await verifyStoreNodeExecutionView(parsed.data, context.accountId, input); } catch { throw new StoreNodeExecutionError(502, undefined, true); } return parsed.data;
}
export async function cancelStoreNodeExecution(context: StoreNodeExecutionContext, execution: StoreNodeExecutionView) {
  const input = CancelStoreNodeExecutionInputSchema.parse({ requestChecksum: execution.requestChecksum });
  const parsed = StoreNodeExecutionViewSchema.safeParse(await request(context, `/${EntityIdSchema.parse(execution.id.toLowerCase())}/cancel`, input));
  if (!parsed.success) throw new StoreNodeExecutionError(502, undefined, true);
  try { await verifyStoreNodeExecutionView(parsed.data, context.accountId, execution); } catch { throw new StoreNodeExecutionError(502, undefined, true); } return parsed.data;
}
