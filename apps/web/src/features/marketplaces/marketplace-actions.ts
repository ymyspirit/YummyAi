"use server";

import type {
  MarketplaceAccountView,
  MarketplaceAutomationRuleView,
  MarketplaceListingSyncRequestView,
  MarketplaceOAuthStartView,
  MarketplacePublicationRequestView,
} from "@yummyai/contracts";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";

import { apiFetch } from "../../server-api";
import { MARKETPLACE_OAUTH_ACCOUNT_COOKIE } from "./marketplace-oauth";

export interface MarketplaceActionState {
  message: string;
  redirectUrl?: string;
  status: "idle" | "success" | "error";
}

export async function createMarketplaceAccount(
  _previous: MarketplaceActionState,
  formData: FormData,
): Promise<MarketplaceActionState> {
  const platform = value(formData, "platform");
  const authorizationMode = value(formData, "authorizationMode");
  const response = await marketplaceRequest<MarketplaceAccountView>("/v1/marketplace-accounts", {
    body: JSON.stringify({
      authorizationMode,
      displayName: value(formData, "displayName"),
      marketplaceIds: list(value(formData, "marketplaceIds")),
      platform,
      region: value(formData, "region"),
      requestedScopes: list(value(formData, "requestedScopes")),
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  if (!response.ok) return failure(response.message);
  revalidatePath("/stores");
  return success("店铺连接已创建，下一步完成授权。 ");
}

export async function authorizeAmazonPrivate(
  accountId: string,
  _previous: MarketplaceActionState,
  formData: FormData,
): Promise<MarketplaceActionState> {
  const response = await marketplaceRequest<MarketplaceAccountView>(
    `/v1/marketplace-accounts/${accountId}/authorization/private`,
    {
      body: JSON.stringify({
        clientId: value(formData, "clientId"),
        clientSecret: value(formData, "clientSecret"),
        refreshToken: value(formData, "refreshToken"),
        sellingPartnerId: value(formData, "sellingPartnerId"),
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    },
  );
  if (!response.ok) return failure(response.message);
  revalidatePath("/stores");
  return success("Amazon 授权已验证并加密保存。 ");
}

export async function startMarketplaceOAuth(
  accountId: string,
  _previous: MarketplaceActionState,
  _formData: FormData,
): Promise<MarketplaceActionState> {
  void _previous;
  void _formData;
  const response = await marketplaceRequest<MarketplaceOAuthStartView>(
    `/v1/marketplace-accounts/${accountId}/authorization/oauth/start`,
    { method: "POST" },
  );
  if (!response.ok) return failure(response.message);
  const cookieStore = await cookies();
  cookieStore.set(MARKETPLACE_OAUTH_ACCOUNT_COOKIE, accountId, {
    httpOnly: true,
    maxAge: 10 * 60,
    path: "/stores/oauth/callback",
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
  });
  return { message: "正在前往平台授权页。", redirectUrl: response.data.authorizationUrl, status: "success" };
}

export async function syncMarketplaceCapabilities(
  accountId: string,
  platform: "amazon" | "etsy",
  _previous: MarketplaceActionState,
  formData: FormData,
): Promise<MarketplaceActionState> {
  const response = await marketplaceRequest(
    `/v1/marketplace-accounts/${accountId}/capabilities/sync`,
    {
      body: JSON.stringify({
        amazonProductTypes: platform === "amazon" ? list(value(formData, "targets")) : [],
        etsyTaxonomyNodeIds: platform === "etsy"
          ? list(value(formData, "targets")).map(Number).filter((entry) => Number.isInteger(entry) && entry > 0)
          : [],
        ttlHours: 24,
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    },
  );
  if (!response.ok) return failure(response.message);
  revalidatePath("/stores");
  return success("店铺身份与发布能力已同步。 ");
}

export async function setMarketplaceAccountEnabled(
  accountId: string,
  enabled: boolean,
  _previous: MarketplaceActionState,
  _formData: FormData,
): Promise<MarketplaceActionState> {
  void _previous;
  void _formData;
  const response = await marketplaceRequest(`/v1/marketplace-accounts/${accountId}`, {
    body: JSON.stringify({ enabled }),
    headers: { "content-type": "application/json" },
    method: "PATCH",
  });
  if (!response.ok) return failure(response.message);
  revalidatePath("/stores");
  return success(enabled ? "店铺已启用，需要重新确认授权。" : "店铺已停用，历史记录继续保留。");
}

export async function revokeMarketplaceAuthorization(
  accountId: string,
  _previous: MarketplaceActionState,
  _formData: FormData,
): Promise<MarketplaceActionState> {
  void _previous;
  void _formData;
  const response = await marketplaceRequest(`/v1/marketplace-accounts/${accountId}/authorization`, {
    method: "DELETE",
  });
  if (!response.ok) return failure(response.message);
  revalidatePath("/stores");
  return success("本地授权已撤销，发布入口已锁定。");
}

export async function createMarketplacePublication(
  listingId: string,
  listingVersionId: string,
  platform: "amazon" | "etsy",
  _previous: MarketplaceActionState,
  formData: FormData,
): Promise<MarketplaceActionState> {
  void _previous;
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
  const response = await marketplaceRequest<MarketplaceListingSyncRequestView>("/v1/marketplace-listing-syncs", {
    body: JSON.stringify({
      accountId: value(formData, "accountId"),
      action: value(formData, "action"),
      listingId,
      listingVersionId,
      sourcePublicationRequestId: value(formData, "sourcePublicationRequestId"),
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  if (!response.ok) return failure(response.message);
  revalidatePath(`/listings/${listingId}`);
  return success(value(formData, "action") === "read" ? "在线价格与库存对账已排队。" : "批准价格与库存写入已排队。");
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
