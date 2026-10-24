"use server";

import type {
  CreateMarketplacePublicationBatchInput,
  MarketplaceAutomationRuleView,
  MarketplaceListingSyncAction,
  MarketplaceListingSyncRequestView,
  MarketplacePublicationBatchView,
  MarketplacePublicationRequestView,
} from "@yummyai/contracts";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { z } from "zod";
import { authorize } from "@yummyai/authz/authorize";
import { Permission } from "@yummyai/authz/permissions";
import { AmazonPrivateAuthorizationInputSchema, CreateMarketplaceAccountInputSchema, MarketplaceAccountViewSchema,
  MarketplaceCapabilitySnapshotViewSchema, MarketplaceOAuthStartViewSchema, SyncMarketplaceCapabilitiesInputSchema } from "@yummyai/contracts/marketplace/store";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import { MarketplaceAuthorityWorkspaceSchema, type MarketplaceAuthorityWorkspace } from "@yummyai/contracts/marketplace/authority";

import { apiFetch } from "../../server-api";
import { erpAmbientIdentity } from "../../erp-auth/request";
import { assertErpIdentityCurrent, type ErpRequestIdentity } from "../../erp-auth/server";
import { PersonalSessionError } from "../../identity/core";
import { MarketplaceLifecycleError, marketplaceAuthorityMatches, marketplaceLifecycleFailure, marketplaceResponseCode,
  readMarketplaceJson, type MarketplaceLifecycleAction, type MarketplaceLifecycleOperation } from "./marketplace-lifecycle";
import { MARKETPLACE_OAUTH_ACCOUNT_COOKIE, MARKETPLACE_OAUTH_COOKIE_PREFIX, MarketplaceOAuthBindingSchema,
  marketplaceOAuthAuthorizationUrl, marketplaceOAuthCookieName, marketplaceOAuthPendingStateDigest, marketplaceOAuthStateDigest, readMarketplaceOAuthBinding } from "./marketplace-oauth";

export interface MarketplaceActionState {
  message: string;
  redirectUrl?: string;
  status: "idle" | "success" | "error";
}
export type MarketplaceLifecycleActionState = MarketplaceLifecycleAction;

export async function createMarketplaceAccount(
  _previous: MarketplaceLifecycleActionState,
  formData: FormData,
): Promise<MarketplaceLifecycleActionState> {
  let submitted = false;
  try {
    const identity = await lifecycleIdentity(formData, Permission.StoreManage);
    const input = CreateMarketplaceAccountInputSchema.parse({ authorizationMode: value(formData, "authorizationMode"),
      displayName: value(formData, "displayName"), marketplaceIds: list(value(formData, "marketplaceIds")),
      platform: value(formData, "platform"), region: value(formData, "region"), requestedScopes: list(value(formData, "requestedScopes")) });
    submitted = true;
    const response = await apiFetch(lifecycleBase() + "/v1/marketplace-accounts", { method: "POST", cache: "no-store",
      headers: { "content-type": "application/json", "x-yummyai-context-authority": identity.authority }, body: JSON.stringify(input), signal: AbortSignal.timeout(120000) });
    if (!response.ok) { const code = await marketplaceResponseCode(response); await assertErpIdentityCurrent(identity); return marketplaceLifecycleFailure(response.status, code, true); }
    const account = MarketplaceAccountViewSchema.strict().parse(await readMarketplaceJson(response, 1024 * 1024));
    await assertErpIdentityCurrent(identity);
    if (response.status !== 201 || account.platform !== input.platform || account.displayName !== input.displayName || account.authorizationMode !== input.authorizationMode)
      return marketplaceLifecycleFailure(502, undefined, true);
    revalidatePath("/stores"); return { ...success("店铺档案已创建 下一步完成授权"), accountId: account.id, contextAuthority: identity.authority };
  } catch (error) { return lifecycleFailure(error, submitted); }
}

export async function authorizeAmazonPrivate(
  accountId: string,
  _previous: MarketplaceLifecycleActionState,
  formData: FormData,
): Promise<MarketplaceLifecycleActionState> {
  return lifecycleMutation(accountId, "authorize", formData, async () => ({ method: "POST", suffix: "/authorization/private", status: 201,
    body: AmazonPrivateAuthorizationInputSchema.parse({ clientId: value(formData, "clientId"), clientSecret: secretValue(formData, "clientSecret"),
      refreshToken: secretValue(formData, "refreshToken"), sellingPartnerId: value(formData, "sellingPartnerId") }),
    schema: MarketplaceAccountViewSchema.strict(), message: "Amazon 授权已验证并加密保存 请核对当前状态并同步能力" }));
}

export async function startMarketplaceOAuth(
  accountId: string,
  _previous: MarketplaceLifecycleActionState,
  formData: FormData,
): Promise<MarketplaceLifecycleActionState> {
  void _previous;
  let submitted = false;
  try {
    const id = EntityIdSchema.parse(accountId.toLowerCase()), identity = await lifecycleIdentity(formData, Permission.StoreAuthorize);
    const before = await boundLifecycle(identity, id, formData, "oauth");
    submitted = true;
    const response = await apiFetch(`${lifecycleBase()}/v1/marketplace-accounts/${id}/authorization/oauth/start`, {
      method: "POST", cache: "no-store", headers: { "x-yummyai-context-authority": identity.authority }, signal: AbortSignal.timeout(120000) });
    if (!response.ok) { const code = await marketplaceResponseCode(response); await assertErpIdentityCurrent(identity);
      return { ...marketplaceLifecycleFailure(response.status, code, true), operation: "oauth", accountId: id, contextAuthority: identity.authority }; }
    const started = MarketplaceOAuthStartViewSchema.strict().parse(await readMarketplaceJson(response, 65536));
    await assertErpIdentityCurrent(identity);
    const current = await readLifecycle(identity, id);
    if (response.status !== 201 || current.lifecycle.authorizationGeneration === before.lifecycle.authorizationGeneration ||
      current.account.status !== "pending_authorization" || current.account.hasCredential || !current.access.authorize ||
      Date.parse(started.expiresAt) <= Date.now() || Date.parse(started.expiresAt) > Date.now() + 15 * 60 * 1000)
      throw new MarketplaceLifecycleError(409, "marketplace_authority_changed");
    const redirect = marketplaceOAuthAuthorizationUrl(started.authorizationUrl, current.account.platform);
    if (current.lifecycle.pendingOAuthStateDigest !== marketplaceOAuthPendingStateDigest(redirect.state))
      throw new MarketplaceLifecycleError(409, "marketplace_authority_changed");
    const binding = MarketplaceOAuthBindingSchema.parse({ version: 1, accountId: id, actorId: identity.view.userId,
      tenantId: identity.view.tenantId, platform: current.account.platform, stateDigest: marketplaceOAuthStateDigest(redirect.state),
      authority: identity.authority, authorizationGeneration: current.lifecycle.authorizationGeneration, expiresAt: started.expiresAt });
    const cookieStore = await cookies();
    await assertErpIdentityCurrent(identity);
    cookieStore.set(MARKETPLACE_OAUTH_ACCOUNT_COOKIE, "", { maxAge: 0, path: "/stores/oauth/callback", httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production" });
    cookieStore.set(marketplaceOAuthCookieName(redirect.state), JSON.stringify(binding), { httpOnly: true,
      maxAge: Math.min(600, Math.max(1, Math.floor((Date.parse(binding.expiresAt) - Date.now()) / 1000))), path: "/stores/oauth/callback",
      sameSite: "lax", secure: process.env.NODE_ENV === "production" });
    return { status: "success", message: "正在前往平台授权页", operation: "oauth", accountId: id,
      contextAuthority: identity.authority, redirectUrl: redirect.url.toString(), workspace: current };
  } catch (error) { return { ...lifecycleFailure(error, submitted), operation: "oauth", ...(EntityIdSchema.safeParse(accountId).success ? { accountId } : {}),
    ...(z.string().regex(/^[a-f0-9]{64}$/).safeParse(formData.get("__marketplaceAuthority")).success ? { contextAuthority: String(formData.get("__marketplaceAuthority")) } : {}) }; }
}

export async function syncMarketplaceCapabilities(
  accountId: string,
  platform: "amazon" | "etsy",
  _previous: MarketplaceLifecycleActionState,
  formData: FormData,
): Promise<MarketplaceLifecycleActionState> {
  return lifecycleMutation(accountId, "sync", formData, async before => {
    if (before.account.platform !== platform) throw new MarketplaceLifecycleError(400, "marketplace_request_invalid");
    const targets = list(value(formData, "targets"));
    return { method: "POST", suffix: "/capabilities/sync", status: 201,
      body: SyncMarketplaceCapabilitiesInputSchema.parse({ amazonProductTypes: platform === "amazon" ? targets : [],
        etsyTaxonomyNodeIds: platform === "etsy" ? targets.map(entry => /^[0-9]+$/.test(entry) ? Number(entry) : NaN) : [], ttlHours: 24 }),
      schema: MarketplaceCapabilitySnapshotViewSchema.strict(), message: "店铺身份与能力快照已同步 请核对有效期" };
  });
}

export async function setMarketplaceAccountEnabled(
  accountId: string,
  enabled: boolean,
  _previous: MarketplaceLifecycleActionState,
  formData: FormData,
): Promise<MarketplaceLifecycleActionState> {
  void _previous;
  return lifecycleMutation(accountId, enabled ? "enable" : "disable", formData, async () => ({ method: "PATCH", suffix: "", status: 200,
    body: { enabled: z.boolean().parse(enabled) }, schema: MarketplaceAccountViewSchema.strict(),
    message: enabled ? "店铺已启用 请重新核对授权" : "店铺已停用 历史记录继续保留" }));
}

export async function revokeMarketplaceAuthorization(
  accountId: string,
  _previous: MarketplaceLifecycleActionState,
  formData: FormData,
): Promise<MarketplaceLifecycleActionState> {
  void _previous;
  return lifecycleMutation(accountId, "revoke", formData, async () => ({ method: "DELETE", suffix: "/authorization", status: 200,
    schema: MarketplaceAccountViewSchema.strict(), message: "本地授权已撤销，发布入口已锁定。" }));
}

function lifecycleBase() {
  const base = process.env.API_BASE_URL?.replace(/\/$/, "");
  if (!base) throw new MarketplaceLifecycleError(503, "marketplace_read_unavailable");
  return base;
}
function secretValue(form: FormData, name: string) { const value = form.get(name); return typeof value === "string" ? value : ""; }
function lifecycleFailure(error: unknown, submitted: boolean): MarketplaceLifecycleActionState {
  if (error instanceof PersonalSessionError) return marketplaceLifecycleFailure(error.status, error.code, submitted);
  if (error instanceof MarketplaceLifecycleError) return marketplaceLifecycleFailure(error.status, error.code, submitted);
  return marketplaceLifecycleFailure(error instanceof z.ZodError && !submitted ? 400 : submitted ? 502 : 503, undefined, submitted);
}
async function lifecycleIdentity(form: FormData, permission: Parameters<typeof authorize>[1]) {
  const identity = await erpAmbientIdentity();
  try { authorize(identity.view, permission); } catch { throw new MarketplaceLifecycleError(403, "marketplace_access_denied"); }
  if (form.get("__marketplaceAuthority") !== identity.authority) throw new PersonalSessionError(409, "authority_changed");
  return identity;
}
async function readLifecycle(identity: ErpRequestIdentity, id: string): Promise<MarketplaceAuthorityWorkspace> {
  const response = await apiFetch(`${lifecycleBase()}/v1/marketplace-accounts/${id}/authority`, { cache: "no-store",
    headers: { "x-yummyai-context-authority": identity.authority }, signal: AbortSignal.timeout(20000) });
  if (!response.ok) { const code = await marketplaceResponseCode(response); await assertErpIdentityCurrent(identity);
    throw new MarketplaceLifecycleError(response.status, code ?? "marketplace_read_unavailable"); }
  const parsed = MarketplaceAuthorityWorkspaceSchema.safeParse(await readMarketplaceJson(response, 1024 * 1024));
  await assertErpIdentityCurrent(identity);
  if (response.status !== 200 || !parsed.success) throw new MarketplaceLifecycleError(502, "marketplace_read_unavailable");
  if (!marketplaceAuthorityMatches(parsed.data, { accountId: id, actorId: identity.view.userId, tenantId: identity.view.tenantId, authority: identity.authority }) ||
    response.headers.has("x-yummyai-context-authority") && response.headers.get("x-yummyai-context-authority") !== identity.authority)
    throw new MarketplaceLifecycleError(409, "authority_changed");
  return parsed.data;
}
async function boundLifecycle(identity: ErpRequestIdentity, id: string, form: FormData, operation: MarketplaceLifecycleOperation) {
  const workspace = await readLifecycle(identity, id);
  if (workspace.lifecycle.authorizationGeneration !== form.get("__authorizationGeneration"))
    throw new MarketplaceLifecycleError(409, "marketplace_authority_changed");
  const allowed = operation === "authorize" || operation === "oauth" || operation === "revoke" ? workspace.access.authorize
    : operation === "sync" ? workspace.access.sync : workspace.access.manage;
  if (!allowed) {
    if (operation === "sync" && workspace.lifecycle.refreshState === "unknown")
      throw new MarketplaceLifecycleError(409, "marketplace_credential_refresh_unknown");
    if (operation === "sync" && (workspace.lifecycle.useState === "in_flight" || workspace.lifecycle.refreshState === "pending"))
      throw new MarketplaceLifecycleError(409, "marketplace_credential_busy");
    throw new MarketplaceLifecycleError(403, "marketplace_access_denied");
  }
  return workspace;
}
type LifecycleMutation = { method: "POST" | "PATCH" | "DELETE"; suffix: string; status: number; body?: unknown;
  schema: ReturnType<typeof MarketplaceAccountViewSchema.strict> | ReturnType<typeof MarketplaceCapabilitySnapshotViewSchema.strict>; message: string };
async function lifecycleMutation(accountId: string, operation: MarketplaceLifecycleOperation, form: FormData,
  prepare: (before: MarketplaceAuthorityWorkspace) => Promise<LifecycleMutation>): Promise<MarketplaceLifecycleActionState> {
  let submitted = false;
  const scope = { operation, ...(EntityIdSchema.safeParse(accountId).success ? { accountId } : {}),
    ...(z.string().regex(/^[a-f0-9]{64}$/).safeParse(form.get("__marketplaceAuthority")).success ? { contextAuthority: String(form.get("__marketplaceAuthority")) } : {}) };
  try {
    const id = EntityIdSchema.parse(accountId.toLowerCase());
    const permission = operation === "sync" || operation === "enable" || operation === "disable" ? Permission.StoreManage : Permission.StoreAuthorize;
    const identity = await lifecycleIdentity(form, permission), before = await boundLifecycle(identity, id, form, operation), request = await prepare(before);
    submitted = true;
    const response = await apiFetch(`${lifecycleBase()}/v1/marketplace-accounts/${id}${request.suffix}`, {
      method: request.method, cache: "no-store", signal: AbortSignal.timeout(120000),
      headers: { "x-yummyai-context-authority": identity.authority, ...(request.body === undefined ? {} : { "content-type": "application/json" }) },
      ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
    });
    if (!response.ok) { const code = await marketplaceResponseCode(response); await assertErpIdentityCurrent(identity);
      return { ...marketplaceLifecycleFailure(response.status, code, true), ...scope }; }
    const parsed = request.schema.safeParse(await readMarketplaceJson(response, 1024 * 1024));
    await assertErpIdentityCurrent(identity);
    if (response.status !== request.status || !parsed.success) return { ...marketplaceLifecycleFailure(502, undefined, true), ...scope };
    const returnedId = "accountId" in parsed.data ? parsed.data.accountId : parsed.data.id;
    if (returnedId.toLowerCase() !== id || parsed.data.platform !== before.account.platform)
      return { ...marketplaceLifecycleFailure(502, undefined, true), ...scope };
    const current = await readLifecycle(identity, id);
    if ((operation === "authorize" && (!current.account.hasCredential || current.account.status === "disabled" || current.account.status === "revoked")) ||
      operation === "sync" && !current.lifecycle.capabilityCurrent || operation === "revoke" && current.account.hasCredential ||
      operation === "disable" && current.account.status !== "disabled" || operation === "enable" && current.account.status === "disabled")
      throw new MarketplaceLifecycleError(409, "marketplace_authority_changed");
    if (operation === "revoke" || operation === "disable") {
      const jar = await cookies();
      for (const cookie of jar.getAll()) if (cookie.name.startsWith(MARKETPLACE_OAUTH_COOKIE_PREFIX)) {
        const binding = readMarketplaceOAuthBinding(cookie.value);
        if (binding?.accountId.toLowerCase() === id && binding.actorId === identity.view.userId && binding.tenantId === identity.view.tenantId)
          jar.set(cookie.name, "", { maxAge: 0, path: "/stores/oauth/callback", httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production" });
      }
    }
    revalidatePath("/stores"); revalidatePath(`/stores/${id}`);
    return { ...scope, status: "success", message: request.message, accountId: id, contextAuthority: identity.authority, workspace: current };
  } catch (error) { return { ...lifecycleFailure(error, submitted), ...scope }; }
}

export async function createMarketplacePublication(
  listingId: string,
  listingVersionId: string,
  platform: "amazon" | "etsy",
  _previous: MarketplaceActionState,
  formData: FormData,
): Promise<MarketplaceActionState> {
  void _previous;
  if (["amazon"].includes(platform)) return failure("Amazon 原校验预览请从绑定节点预览工作区核对 不通过旧中央发布入口准备");
  const scheduledFor = value(formData, "scheduledFor");
  const response = await marketplaceRequest<MarketplacePublicationRequestView>(
    "/v1/marketplace-publications",
    {
      body: JSON.stringify({
        accountId: value(formData, "accountId"),
        listingId,
        listingVersionId,
        marketplaceId: value(formData, "marketplaceId"),
        ...(platform === "amazon" ? { variantSkuId: value(formData, "variantSkuId") } : {}),
        ...(scheduledFor ? { scheduledFor } : {}),
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    },
  );
  if (!response.ok) return failure(response.message);
  revalidatePath(`/listings/${listingId}`);
  if (scheduledFor) return success("发布任务已按计划时间创建。");
  return success(platform === "amazon" ? "Amazon 校验预览已排队。" : "Etsy 草稿创建已排队。");
}

export async function cancelMarketplacePublication(
  listingId: string,
  requestId: string,
  _previous: MarketplaceActionState,
  formData: FormData,
): Promise<MarketplaceActionState> {
  void _previous;
  const response = await marketplaceRequest<MarketplacePublicationRequestView>(
    `/v1/marketplace-publications/${requestId}/cancel`,
    {
      body: JSON.stringify({ reason: value(formData, "reason") }),
      headers: { "content-type": "application/json" },
      method: "POST",
    },
  );
  if (!response.ok) return failure(response.message);
  revalidatePath(`/listings/${listingId}`);
  return success("发布任务已取消。");
}

export async function continueMarketplacePublication(
  listingId: string,
  requestId: string,
  _previous: MarketplaceActionState,
  _formData: FormData,
): Promise<MarketplaceActionState> {
  void _previous;
  void _formData;
  const response = await marketplaceRequest<MarketplacePublicationRequestView>(
    `/v1/marketplace-publications/${requestId}/continue`,
    { method: "POST" },
  );
  if (!response.ok) return failure(response.message);
  revalidatePath(`/listings/${listingId}`);
  return success("下一发布动作已排队。 ");
}

export async function createMarketplacePublicationBatch(
  _previous: MarketplaceActionState,
  formData: FormData,
): Promise<MarketplaceActionState> {
  void _previous;
  try {
    const scheduledFor = value(formData, "scheduledFor");
    const items = formData.getAll("selectedItems").map((entry) => {
      if (typeof entry !== "string") throw new Error("批次项目格式无效。");
      return JSON.parse(entry) as CreateMarketplacePublicationBatchInput["items"][number];
    });
    if (items.length < 2 || items.length > 100) throw new Error("请选择 2–100 个发布目标。");
    const input: CreateMarketplacePublicationBatchInput = {
      accountId: value(formData, "accountId"),
      marketplaceId: value(formData, "marketplaceId"),
      items,
      ...(scheduledFor ? { scheduledFor } : {}),
    };
    const response = await marketplaceRequest<MarketplacePublicationBatchView>(
      "/v1/marketplace-publication-batches",
      {
        body: JSON.stringify(input),
        headers: { "content-type": "application/json" },
        method: "POST",
      },
    );
    if (!response.ok) return failure(response.message);
    revalidatePath("/listings");
    return success(scheduledFor ? "批量发布已按计划时间创建。" : "批量发布预检已排队。");
  } catch (error) {
    return failure(error instanceof Error ? error.message : "批次参数无效。");
  }
}

export async function continueMarketplacePublicationBatch(
  batchId: string,
  _previous: MarketplaceActionState,
  _formData: FormData,
): Promise<MarketplaceActionState> {
  void _previous;
  void _formData;
  const response = await marketplaceRequest<MarketplacePublicationBatchView>(
    `/v1/marketplace-publication-batches/${batchId}/continue`,
    { method: "POST" },
  );
  if (!response.ok) return failure(response.message);
  revalidatePath("/listings");
  return success("批次下一发布动作已排队。");
}

export async function cancelMarketplacePublicationBatch(
  batchId: string,
  _previous: MarketplaceActionState,
  formData: FormData,
): Promise<MarketplaceActionState> {
  void _previous;
  const response = await marketplaceRequest<MarketplacePublicationBatchView>(
    `/v1/marketplace-publication-batches/${batchId}/cancel`,
    {
      body: JSON.stringify({ reason: value(formData, "reason") }),
      headers: { "content-type": "application/json" },
      method: "POST",
    },
  );
  if (!response.ok) return failure(response.message);
  revalidatePath("/listings");
  return success("批次已取消。");
}

export async function createListingReplication(
  listingId: string,
  sourceVersionId: string,
  _previous: MarketplaceActionState,
  formData: FormData,
): Promise<MarketplaceActionState> {
  const title = value(formData, "title");
  const response = await marketplaceRequest(`/v1/listings/${listingId}/replications`, {
    body: JSON.stringify({
      sourceVersionId,
      targetMarketplaceId: value(formData, "targetMarketplaceId"),
      targetLocale: value(formData, "targetLocale"),
      overrides: title ? { title } : {},
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  if (!response.ok) return failure(response.message);
  revalidatePath(`/listings/${listingId}`);
  revalidatePath("/listings");
  return success("目标站点草稿已从批准版本创建。 ");
}

export async function createMarketplaceListingSync(
  listingId: string,
  listingVersionId: string,
  _previous: MarketplaceActionState,
  formData: FormData,
): Promise<MarketplaceActionState> {
  const requestKey = EntityIdSchema.safeParse(value(formData, "requestKey"));
  if (!requestKey.success) return failure("请通过在线同步工作区保存固定原请求标识后提交");
  const action = value(formData, "action") as MarketplaceListingSyncAction;
  const response = await marketplaceRequest<MarketplaceListingSyncRequestView>("/v1/marketplace-listing-syncs", {
    body: JSON.stringify({
      accountId: value(formData, "accountId"),
      action,
      listingId,
      listingVersionId,
      sourcePublicationRequestId: value(formData, "sourcePublicationRequestId"),
      requestKey: requestKey.data,
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  if (!response.ok) return failure(response.message);
  revalidatePath(`/listings/${listingId}`);
  return success("原同步请求已保存 请读取原回执 不代表已入队派发或平台已接受");
}

export async function createMarketplaceAutomationRule(
  listingId: string,
  _previous: MarketplaceActionState,
  formData: FormData,
): Promise<MarketplaceActionState> {
  const actionType = value(formData, "actionType");
  const action = actionType === "queue_listing_sync"
    ? {
        type: actionType,
        accountId: value(formData, "accountId"),
        sourcePublicationRequestId: value(formData, "sourcePublicationRequestId"),
        action: value(formData, "syncAction"),
      }
    : {
        type: "queue_publication",
        accountId: value(formData, "accountId"),
        marketplaceId: value(formData, "marketplaceId"),
        ...(value(formData, "variantSkuId") ? { variantSkuId: value(formData, "variantSkuId") } : {}),
      };
  const response = await marketplaceRequest<MarketplaceAutomationRuleView>("/v1/marketplace-automation-rules", {
    body: JSON.stringify({
      name: value(formData, "name"),
      trigger: "listing_approved",
      conditions: {
        listingId,
        minimumCompleteness: Number(value(formData, "minimumCompleteness") || "100"),
      },
      action,
      enabled: formData.get("enabled") === "on",
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  if (!response.ok) return failure(response.message);
  revalidatePath(`/listings/${listingId}`);
  return success("自动化规则已创建。 ");
}

export async function setMarketplaceAutomationEnabled(
  listingId: string,
  ruleId: string,
  enabled: boolean,
  _previous: MarketplaceActionState,
  _formData: FormData,
): Promise<MarketplaceActionState> {
  void _previous;
  void _formData;
  const response = await marketplaceRequest(`/v1/marketplace-automation-rules/${ruleId}`, {
    body: JSON.stringify({ enabled }),
    headers: { "content-type": "application/json" },
    method: "PATCH",
  });
  if (!response.ok) return failure(response.message);
  revalidatePath(`/listings/${listingId}`);
  return success(enabled ? "自动化规则已启用。" : "自动化规则已停用。");
}

interface MarketplaceResponse<T> {
  data: T;
  message: string;
  ok: boolean;
}

async function marketplaceRequest<T = unknown>(
  path: string,
  init: RequestInit,
): Promise<MarketplaceResponse<T>> {
  const apiBase = process.env.API_BASE_URL;
  if (!apiBase) return { data: undefined as T, message: "API_BASE_URL 未配置。", ok: false };
  try {
    const response = await apiFetch(`${apiBase.replace(/\/$/, "")}${path}`, {
      ...init,
      cache: "no-store",
    });
    const payload = await response.json().catch(() => undefined) as Record<string, unknown> | undefined;
    if (!response.ok) {
      return {
        data: undefined as T,
        message: messageFrom(payload) ?? `操作失败 (${response.status})`,
        ok: false,
      };
    }
    return { data: payload as T, message: "", ok: true };
  } catch (error) {
    return {
      data: undefined as T,
      message: error instanceof Error ? error.message : "操作失败",
      ok: false,
    };
  }
}

function value(formData: FormData, name: string): string {
  const entry = formData.get(name);
  return typeof entry === "string" ? entry.trim() : "";
}

function list(input: string): string[] {
  return input.split(/[,\n]/).map((entry) => entry.trim()).filter(Boolean);
}

function messageFrom(payload: Record<string, unknown> | undefined): string | undefined {
  for (const key of ["detail", "message", "title"]) {
    if (typeof payload?.[key] === "string") return payload[key];
  }
  return undefined;
}

function success(message: string): MarketplaceActionState {
  return { message: message.trim(), status: "success" };
}

function failure(message: string): MarketplaceActionState {
  return { message, status: "error" };
}
