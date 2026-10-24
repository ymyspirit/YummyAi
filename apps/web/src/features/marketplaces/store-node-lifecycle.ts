import { z } from "zod";
import { StoreNodePublicKeySchema, type StoreNodeWorkspace, type StoreNodeEnrollmentCreated,
  type StoreNodeGenerationFence, type BindStoreNodeInput } from "@yummyai/contracts/marketplace/store-node";
import { readMarketplaceJson } from "./marketplace-lifecycle";

export const StoreNodeErrorCodeSchema = z.enum(["authority_changed", "marketplace_authority_changed", "store_node_authority_changed",
  "store_node_member_changed", "store_node_membership_changed", "store_node_not_configured", "store_node_limit", "store_node_key_exists", "store_node_not_ready", "store_node_store_inactive",
  "store_node_configuration_disabled", "store_node_ticket_not_replayable", "store_node_idempotency_conflict", "store_node_binding_changed",
  "store_node_binding_conflict", "store_node_certificate_changed", "store_node_lease_active", "store_node_binding_draining", "store_node_limit_reached"]);
export type StoreNodeErrorCode = z.infer<typeof StoreNodeErrorCodeSchema>;
export function storeNodeOperationAllowed(value: StoreNodeWorkspace, operation: "create" | "reissue" | "bind" | "revoke") {
  return value.access.manage && value.access.authorize && (operation === "revoke" || value.configuration.enabled);
}
export class StoreNodeRequestError extends Error {
  constructor(readonly status: number, readonly code?: StoreNodeErrorCode, readonly submitted = false) { super("store_node_request_failed"); }
}
export const storeNodeDenied = (error: StoreNodeRequestError) => [401, 403, 404].includes(error.status) || error.status === 409 &&
  ["authority_changed", "marketplace_authority_changed", "store_node_authority_changed", "store_node_member_changed", "store_node_membership_changed"].includes(error.code ?? "");
export function storeNodeErrorMessage(error: StoreNodeRequestError) {
  if (storeNodeDenied(error)) return "本店或本人权限已变化 节点资料与登记包已隐藏 请重新读取";
  if (error.code === "store_node_ticket_not_replayable") return "原登记已存在 票据不会重新显示 请读取原节点并明确重新签发";
  if (error.code === "store_node_idempotency_conflict") return "原登记标识已有不同正文 不会换键重建 请读取原节点核对";
  if (error.code === "store_node_not_configured" || error.code === "store_node_configuration_disabled") return "节点登记服务尚未启用 请联系管理员核对配置";
  if (error.code === "store_node_limit" || error.code === "store_node_limit_reached") return "本店节点数量已达上限 请读取原节点核对 不会重复创建";
  if (error.code === "store_node_key_exists") return "本店已有相同公钥的节点 请读取原节点 不会另建重复登记";
  if (error.code === "store_node_not_ready") return "节点尚未完成登记或当前不可绑定 请读取原节点状态";
  if (error.code === "store_node_store_inactive") return "店铺已停用或原授权当前不可用 请重新核对店铺和节点状态";
  if (error.submitted && (error.status === 0 || error.status >= 500)) return "原节点操作结果未知 请先只读取节点状态 不会自动重发";
  if (error.status === 409 || error.status === 412) return "节点版本或绑定租约已变化 请重新读取并核对原节点";
  if (error.status === 400 || error.status === 413 || error.status === 422) return "节点填写需核对 仅提交公开 SPKI 公钥 不要提交私钥";
  return "节点状态暂时无法读取 请稍后重新读取";
}
export async function readStoreNodeError(response: Response) {
  try {
    const parsed = z.object({ code: StoreNodeErrorCodeSchema }).passthrough().safeParse(await readMarketplaceJson(response, 8192));
    return parsed.success ? parsed.data.code : undefined;
  } catch { return undefined; }
}
export function storeNodeWorkspaceMatches(value: StoreNodeWorkspace, context: { accountId: string; actorId: string; tenantId: string; authority: string }) {
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  return same(value.accountId, context.accountId) && same(value.context.actorId, context.actorId) && same(value.context.tenantId, context.tenantId) &&
    value.context.authority === context.authority && new Set(value.nodes.map(node => node.id.toLowerCase())).size === value.nodes.length &&
    new Set(value.nodes.map(node => node.creationRequestKey)).size === value.nodes.length &&
    (value.binding.nodeId === null || value.nodes.some(node => same(node.id, value.binding.nodeId!)));
}
export async function storeNodeEnrollmentMatches(value: StoreNodeEnrollmentCreated, nodeId?: string) {
  const { workspace, enrollment } = value, node = workspace.nodes.find(row => row.id.toLowerCase() === enrollment.nodeId.toLowerCase());
  return !!node && (!nodeId || node.id.toLowerCase() === nodeId.toLowerCase()) && node.status === "pending_enrollment" &&
    node.ticketState === "issued" && enrollment.expiresAt === node.ticketExpiresAt && enrollment.ticketToken.startsWith(`stn_${node.id.toLowerCase()}.`) &&
    enrollment.accountId.toLowerCase() === workspace.accountId.toLowerCase() && enrollment.certificateGeneration === node.certificateGeneration &&
    enrollment.publicKeySpkiSha256 === node.publicKeySpkiSha256 && workspace.configuration.enabled &&
    enrollment.enrollmentOrigin === workspace.configuration.enrollmentOrigin && enrollment.runtimeOrigin === workspace.configuration.runtimeOrigin &&
    Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(enrollment.caCertificatePem))), byte => byte.toString(16).padStart(2, "0")).join("") === workspace.configuration.caCertificateSha256;
}
export function storeNodeMutationMatches(value: StoreNodeWorkspace, operation: "bind" | "revoke", input: StoreNodeGenerationFence | BindStoreNodeInput, nodeId: string) {
  const node = value.nodes.find(row => row.id.toLowerCase() === nodeId.toLowerCase());
  if (!node || value.authorizationGeneration.toLowerCase() !== input.expectedAuthorizationGeneration.toLowerCase() || value.binding.revision < input.expectedBindingRevision) return false;
  if (operation === "revoke") return node.status === "revoked" && node.certificateGeneration >= input.expectedCertificateGeneration;
  return node.status === "enrolled" && node.certificateGeneration === input.expectedCertificateGeneration && (value.binding.state === "active" ?
    value.binding.nodeId?.toLowerCase() === nodeId.toLowerCase() && value.binding.authorizationGeneration?.toLowerCase() === value.authorizationGeneration.toLowerCase() :
    value.binding.state === "draining" && value.binding.nodeId !== null && value.binding.leaseExpiresAt !== null && !value.binding.effective);
}
export function normalizeStoreNodePublicKey(raw: string) {
  if (raw.length > 8192 || raw.includes("PRIVATE KEY")) throw new StoreNodeRequestError(400);
  const value = raw.replace(/\r\n?/g, "\n").trim() + "\n", parsed = StoreNodePublicKeySchema.safeParse(value);
  if (!parsed.success || !/^[A-Za-z0-9+/=\n]+$/.test(value.slice("-----BEGIN PUBLIC KEY-----\n".length, -"-----END PUBLIC KEY-----\n".length)))
    throw new StoreNodeRequestError(400);
  return parsed.data;
}
export async function storeNodePublicKeyDigest(raw: string) {
  const pem = normalizeStoreNodePublicKey(raw), content = pem.replace("-----BEGIN PUBLIC KEY-----", "").replace("-----END PUBLIC KEY-----", "").replace(/\s/g, "");
  let bytes = new Uint8Array(0);
  try { bytes = Uint8Array.from(atob(content), value => value.charCodeAt(0)); } catch { throw new StoreNodeRequestError(400); }
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), value => value.toString(16).padStart(2, "0")).join("");
}
export const newStoreNodeRequestKey = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), value => value.toString(16).padStart(2, "0")).join("");
export function storeNodeReachability(node: StoreNodeWorkspace["nodes"][number], serverNow: number) {
  if (node.status === "revoked") return "已撤销";
  if (node.status !== "enrolled") return "未见当前证书心跳";
  if (node.certificateExpiresAt && Date.parse(node.certificateExpiresAt) <= serverNow) return "证书已到期";
  if (node.reachability === "never_seen") return "未见心跳";
  return node.reachability === "online" && node.sessionExpiresAt !== null && Date.parse(node.sessionExpiresAt) > serverNow ? "在线" : "离线";
}
