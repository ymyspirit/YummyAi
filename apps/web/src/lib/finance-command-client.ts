"use client";

import type { z } from "zod";
import { Permission } from "@yummyai/authz/permissions";
import type { FinanceCommandKind, FinanceCommandScope } from "@yummyai/contracts/finance/finance-command";

export type FinanceCommandIdentity = { authority: string | null; localDevelopment: boolean };
const writeKinds = new Set<FinanceCommandKind>(["statement_record", "fx_rate_record", "bill_record", "payment_record"]);
export function financeCommandOperationPermission(kind: FinanceCommandKind) {
  return writeKinds.has(kind) ? Permission.FinanceWrite : Permission.FinanceReview;
}
export class FinanceCommandRequestError extends Error {
  constructor(readonly status: number, message: string, readonly code: string | null = null) { super(message); }
}
export function financeCommandDenied(error: unknown) {
  return error instanceof FinanceCommandRequestError && ([401, 403, 404].includes(error.status) || error.code === "authority_changed");
}
/** Private copies remain at the API, never in storage, URLs or console output. */
export async function financeCommandRequest<T extends z.ZodType>(path: string, schema: T,
  identity: FinanceCommandIdentity, body?: unknown, signal?: AbortSignal): Promise<z.output<T>> {
  const resultRead = body === undefined && /\/result(?:\/entries)?(?:\?|$)/.test(path);
  let response: Response;
  try {
    response = await fetch(`/api/finance/commands${path ? path.startsWith("?") ? path : `/${path}` : ""}`, {
      method: body === undefined ? "GET" : "POST", credentials: "same-origin", redirect: "error", cache: "no-store",
      headers: body === undefined ? { accept: "application/json" } : { accept: "application/json", "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(body === undefined ? 30_000 : 60_000)]) : AbortSignal.timeout(body === undefined ? 30_000 : 60_000),
    });
  } catch (failure) {
    if (signal?.aborted) throw failure;
    throw new FinanceCommandRequestError(0, resultRead ? "历史结果读取中断 请重新读取原保存记录" : body === undefined ? "暂时无法读取财务原提交 请重新读取" : "本次提交结果尚未确认 请先读取原提交 不要另建提交键");
  }
  const raw: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const code = raw && typeof raw === "object" && "code" in raw && typeof raw.code === "string" ? raw.code : null;
    const messages: Record<number, string> = { 400: "原提交格式无法核对 请检查填写", 401: "身份会话无效 请重新登录", 403: "当前权限不足 已停止读取私有填写", 404: "此本人原提交当前不可读取", 409: "原版本、来源或提交依据已变化 请读取原提交核对", 413: "原报表超过支持的完整传输大小 未裁剪或分片登记", 422: "原业务依据未通过核对 请读取原提交和实际凭据" };
    const resultMessages: Record<number, string> = { 400: "历史结果标识、明细类型或游标无效 请核对后重读", 401: "身份会话无效 已停止读取历史结果", 403: "当前权限不足 已停止显示历史结果", 404: "这笔本人的历史结果当前不可读取", 409: "历史结果依据暂不可核对 不会重算或改写原结果", 413: "历史结果超过支持的读取大小 未截断显示", 422: "原保存结果暂不可完整核对 请重读该笔历史凭据" };
    throw new FinanceCommandRequestError(response.status, (resultRead ? resultMessages : messages)[response.status] ?? (resultRead ? "历史结果响应尚不可核对 请重新读取" : "服务响应尚不可核对 请重新读取原提交"), code);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new FinanceCommandRequestError(502, resultRead ? "返回历史结果格式无法核对 未将缺页或未知值当作完整结果" : "返回凭据格式无法核对 请重新读取原提交");
  const value = parsed.data;
  if (!identity.localDevelopment && (!identity.authority || !value || typeof value !== "object" || !("contextAuthority" in value) || value.contextAuthority !== identity.authority))
    throw new FinanceCommandRequestError(409, "当前账号或权限已变化 已停止显示私有内容 请重新读取", "authority_changed");
  return value;
}
export function financeCommandReadPath(scope: FinanceCommandScope | null, before?: string, view: "active" | "recorded" = "active") {
  const query = new URLSearchParams();
  query.set("view", view);
  if (scope) { query.set("kind", scope.kind); query.set("targetId", scope.targetId ?? "root"); }
  if (before) query.set("before", before);
  return query.size ? `?${query}` : "";
}
