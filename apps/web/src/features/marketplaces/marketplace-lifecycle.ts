import { z } from "zod";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import { MarketplaceAuthorityWorkspaceSchema, type MarketplaceAuthorityWorkspace } from "@yummyai/contracts/marketplace/authority";

export const MarketplaceLifecycleOperationSchema = z.enum(["authorize", "oauth", "sync", "enable", "disable", "revoke"]);
export type MarketplaceLifecycleOperation = z.infer<typeof MarketplaceLifecycleOperationSchema>;
export const MarketplaceLifecycleCodeSchema = z.enum([
  "authority_changed", "marketplace_authority_changed", "marketplace_credential_busy",
  "marketplace_credential_refresh_unknown", "marketplace_request_invalid", "marketplace_result_unknown",
  "marketplace_read_unavailable", "marketplace_access_denied",
]);
export type MarketplaceLifecycleCode = z.infer<typeof MarketplaceLifecycleCodeSchema>;
export const MarketplaceLifecycleActionSchema = z.object({
  status: z.enum(["idle", "success", "error", "unknown"]), message: z.string().max(500),
  operation: MarketplaceLifecycleOperationSchema.optional(), accountId: EntityIdSchema.optional(),
  contextAuthority: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  code: MarketplaceLifecycleCodeSchema.optional(), denied: z.boolean().optional(),
  workspace: MarketplaceAuthorityWorkspaceSchema.optional(), redirectUrl: z.string().max(16384).optional(),
}).strict();
export type MarketplaceLifecycleAction = z.infer<typeof MarketplaceLifecycleActionSchema>;
export const MarketplaceOAuthStateSchema = z.string().min(32).max(512).regex(/^[A-Za-z0-9_-]+$/);
const amazonAuthorizationHosts = new Set([
  "sellercentral.amazon.com", "sellercentral.amazon.ca", "sellercentral.amazon.com.mx", "sellercentral.amazon.com.br",
  "sellercentral.amazon.co.uk", "sellercentral.amazon.de", "sellercentral.amazon.fr", "sellercentral.amazon.it",
  "sellercentral.amazon.es", "sellercentral.amazon.nl", "sellercentral.amazon.se", "sellercentral.amazon.pl",
  "sellercentral.amazon.com.be", "sellercentral.amazon.com.tr", "sellercentral.amazon.ae", "sellercentral.amazon.sa",
  "sellercentral.amazon.eg", "sellercentral.amazon.co.za", "sellercentral.amazon.in", "sellercentral.amazon.co.jp",
  "sellercentral.amazon.com.au", "sellercentral.amazon.sg",
]);
export function marketplaceOAuthAuthorizationUrl(value: string, platform: "amazon" | "etsy"): { url: URL; state: string } {
  if (value.length > 16384) throw new Error("marketplace_oauth_invalid");
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.port ||
    (platform === "etsy" ? url.hostname !== "www.etsy.com" || url.pathname !== "/oauth/connect" :
      !amazonAuthorizationHosts.has(url.hostname) || url.pathname !== "/apps/authorize/consent")) throw new Error("marketplace_oauth_invalid");
  for (const key of url.searchParams.keys()) if (url.searchParams.getAll(key).length !== 1) throw new Error("marketplace_oauth_invalid");
  return { url, state: MarketplaceOAuthStateSchema.parse(url.searchParams.get("state")) };
}

export class MarketplaceLifecycleError extends Error {
  constructor(readonly status: number, readonly code: MarketplaceLifecycleCode) { super(code); }
}
export function marketplaceDenied(status: number, code?: string): boolean {
  return [401, 403, 404].includes(status) || status === 409 &&
    (code === "authority_changed" || code === "marketplace_authority_changed");
}
export function marketplaceLifecycleFailure(status: number, code?: string, submitted = false): MarketplaceLifecycleAction {
  const parsed = MarketplaceLifecycleCodeSchema.safeParse(code), safeCode = parsed.success ? parsed.data : undefined;
  if (marketplaceDenied(status, safeCode)) return { status: "error", denied: true, code: safeCode ?? "marketplace_access_denied",
    message: "当前店铺或本人权限已变化 原资料和填写已隐藏 请重新读取授权状态" };
  if (safeCode === "marketplace_credential_refresh_unknown") return { status: "unknown", code: safeCode,
    message: "凭据刷新结果尚未确认 请重新读取授权状态并重新授权 不会自动重试刷新" };
  if (safeCode === "marketplace_credential_busy") return { status: "error", code: safeCode,
    message: "本店凭据正在使用 请只读取当前状态 等待原操作完成" };
  if (submitted && (status === 0 || status >= 500)) return { status: "unknown", code: "marketplace_result_unknown",
    message: "原操作结果尚未确认 请只重新读取授权状态 不要重复提交或交换授权码" };
  return { status: "error", code: safeCode ?? (status === 400 || status === 422 ? "marketplace_request_invalid" : "marketplace_read_unavailable"),
    message: status === 400 || status === 422 ? "店铺填写或授权请求格式需核对" : status === 409 || status === 412
      ? "店铺授权依据已变化 请重新读取当前状态后再操作" : "店铺授权状态暂时无法核对 请稍后重新读取" };
}
export function marketplaceLifecycleState(workspace: MarketplaceAuthorityWorkspace) {
  const { lifecycle } = workspace;
  const busy = lifecycle.useState === "in_flight" || lifecycle.refreshState === "pending";
  const reauthorize = lifecycle.useState === "refresh_unknown" || lifecycle.refreshState === "unknown";
  return { busy, reauthorize, canSync: workspace.access.sync && !busy && !reauthorize,
    label: reauthorize ? "刷新结果未知 需重新授权" : busy ? "原凭据操作处理中" : "授权状态已读取" };
}
export function marketplaceAuthorityMatches(workspace: MarketplaceAuthorityWorkspace,
  expected: { accountId: string; actorId: string; tenantId: string; authority: string }): boolean {
  return workspace.account.id.toLowerCase() === expected.accountId.toLowerCase() &&
    workspace.context.actorId.toLowerCase() === expected.actorId.toLowerCase() &&
    workspace.context.tenantId.toLowerCase() === expected.tenantId.toLowerCase() && workspace.context.authority === expected.authority;
}
export async function marketplaceAuthorityDigest(authority: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(authority));
  return Array.from(new Uint8Array(bytes), value => value.toString(16).padStart(2, "0")).join("");
}
export async function readMarketplaceJson(response: Response, limit: number): Promise<unknown> {
  const length = response.headers.get("content-length"), reader = response.body?.getReader();
  try {
    if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "") || !reader ||
      length !== null && (!/^[0-9]+$/.test(length) || Number(length) > limit)) throw new Error("marketplace_json_invalid");
    const chunks: Uint8Array[] = []; let size = 0;
    for (;;) { const value = await reader.read(); if (value.done) break; size += value.value.byteLength;
      if (size > limit) throw new Error("marketplace_json_limit"); chunks.push(value.value); }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } finally { if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); } else await response.body?.cancel().catch(() => {}); }
}
export async function marketplaceResponseCode(response: Response): Promise<MarketplaceLifecycleCode | undefined> {
  try { const value = z.object({ code: MarketplaceLifecycleCodeSchema }).passthrough().safeParse(await readMarketplaceJson(response, 8192));
    return value.success ? value.data.code : undefined; } catch { return undefined; }
}
