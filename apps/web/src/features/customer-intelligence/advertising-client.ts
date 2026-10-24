"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { z } from "zod";
import { useErpAccess } from "../identity/erp-access";
import {
  normalizeAdTerm,
  adCurrencyBasis,
  parseAdMinorAmount,
  formatAdMinorAmount,
  type AdAttributionModel,
  type AdCurrencyBasis,
  type AdMetricColumns,
  type AdActionStatus,
  type AdReportType,
  type AdProductSummary,
} from "@yummyai/contracts/advertising";
export type AdIdentity = { authority: string | null; preferenceScope: string | null; localDevelopment: boolean };
export class AdRequestError extends Error {
  constructor(readonly status: number, message: string, readonly code: string | null = null) { super(message); }
}
export const adDenied = (error: unknown) => error instanceof AdRequestError &&
  ([401, 403].includes(error.status) || error.code === "authority_changed");
export function adError(error: unknown) {
  if (error instanceof AdRequestError) return error.message;
  if (error instanceof Error && error.name !== "ZodError" && /[\u3400-\u9fff]/.test(error.message)) return error.message;
  return "请核对必填项、日期、金额和真实对象 ID";
}
/** Ask the existing ERP identity boundary to recheck the current personal session. */
export function adRecheckSession() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event("focus"));
}
export function adCheckAuthority(value: { contextAuthority: string }, identity: AdIdentity) {
  if (!identity.localDevelopment && (!identity.authority || value.contextAuthority !== identity.authority)) {
    adRecheckSession();
    throw new AdRequestError(409, "当前身份或权限已变化 私有内容已清除 请重新核对身份", "authority_changed");
  }
}
export async function adRequest<T>(
  path: string,
  input?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/advertising/${path}`, {
      method: input === undefined ? "GET" : "POST", credentials: "same-origin", redirect: "error",
      cache: "no-store", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000),
      headers: { accept: "application/json", ...(input === undefined ? {} : { "content-type": "application/json" }) },
      body: input === undefined ? undefined : JSON.stringify(input),
    });
  } catch (failure) {
    if (signal?.aborted) throw failure;
    throw new AdRequestError(0, input === undefined ? "广告记录读取中断 请重新读取" : "本次操作结果尚未确认 请保留原正文和原键重试");
  }
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const code = data && typeof data === "object" && "code" in data && typeof data.code === "string" ? data.code : null;
    const messages: Record<number, string> = {
      400: "广告字段不完整或格式不正确 请核对原填写", 401: "身份会话已失效 私有内容已清除 请重新登录",
      403: "当前权限不足 私有内容已清除 正在重新核对身份", 404: "所选广告记录当前不可访问",
      409: "原版本、来源或提交依据已变化 请核对原操作", 413: "广告报表超过支持的完整传输大小 未截断导入",
      422: "广告来源或业务依据未通过核对 请检查原报表与诊断",
    };
    if ([401, 403].includes(response.status) || code === "authority_changed") adRecheckSession();
    throw new AdRequestError(response.status, code === "authority_changed" ? "当前身份或权限已变化 私有内容已清除" : messages[response.status] ?? "广告服务响应尚未确认 请保留原请求后重试", code);
  }
  if (data === null) throw new AdRequestError(502, "返回凭据无法核对 请保留原请求 不另建提交键");
  return data as T;
}
/** Durable submissions use the same personal-session transport and never fall back to a service identity. */
export async function adCommandRequest<S extends z.ZodType>(path: string, schema: S, identity: AdIdentity, body?: unknown, signal?: AbortSignal): Promise<z.output<S>> {
  const raw = await adRequest(`commands${path ? path.startsWith("?") ? path : `/${path}` : ""}`, body, signal);
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new AdRequestError(502, "广告原提交回执格式无法核对 请读取原命令 不另建提交键");
  const value = parsed.data;
  if (!value || typeof value !== "object" || !("contextAuthority" in value) || typeof value.contextAuthority !== "string") throw new AdRequestError(502, "广告原提交缺少当前身份依据");
  adCheckAuthority(value as { contextAuthority: string }, identity);
  return parsed.data;
}

/** In-memory replay only. Nothing is written to storage and no cross-session recovery is claimed. */
export function useAdMutation(scopeKey: string, allowed: boolean, onDenied?: (message: string) => void) {
  const access = useErpAccess(), authority = access.authority, preferenceScope = access.preferenceScope;
  const scopeStamp = `${authority ?? ""}:${preferenceScope ?? ""}:${scopeKey}`;
  const installed = useRef(scopeStamp);
  const [state, setState] = useState<{ pending: boolean; frozen: boolean; error: string; result: unknown; canEdit: boolean }>({ pending: false, frozen: false, error: "", result: null, canEdit: false });
  const request = useRef<{ path: string; body: unknown } | null>(null), generation = useRef(0), live = useRef(true), lease = useRef<symbol | null>(null);
  const current = useRef({ authority, preferenceScope, scopeKey, allowed, onDenied }); current.current = { authority, preferenceScope, scopeKey, allowed, onDenied };
  useLayoutEffect(() => {
    installed.current = scopeStamp;
    generation.current++; request.current = null; lease.current = null;
    setState({ pending: false, frozen: false, error: "", result: null, canEdit: false });
  }, [authority, preferenceScope, scopeKey, scopeStamp, allowed]);
  useEffect(() => { live.current = true; return () => { live.current = false; generation.current++; request.current = null; }; }, []);
  async function submit<S extends z.ZodType>(path: string, build: () => unknown, schema: S): Promise<z.output<S> | null> {
    if (!current.current.allowed || lease.current) return null;
    const captured = { authority, preferenceScope, scopeKey }, epoch = generation.current, owner = Symbol("advertising-mutation");
    const valid = () => live.current && generation.current === epoch && current.current.allowed && current.current.authority === captured.authority && current.current.preferenceScope === captured.preferenceScope && current.current.scopeKey === captured.scopeKey;
    try {
      const original = request.current ?? { path, body: build() };
      if (original.path !== path) throw new AdRequestError(409, "请先核对原操作 不将原请求改绑到其他对象");
      request.current = original; lease.current = owner;
      setState({ pending: true, frozen: true, error: "", result: null, canEdit: false });
      const raw = await adRequest(original.path, original.body);
      if (!valid()) return null;
      const parsed = schema.safeParse(raw);
      if (!parsed.success) throw new AdRequestError(502, "返回凭据格式无法核对 请重试同一笔原请求");
      request.current = null;
      setState({ pending: false, frozen: false, error: "", result: parsed.data, canEdit: false });
      return parsed.data;
    } catch (failure) {
      if (!valid()) return null;
      if (adDenied(failure)) {
        request.current = null;
        setState({ pending: false, frozen: false, error: adError(failure), result: null, canEdit: false });
        current.current.onDenied?.(adError(failure));
      } else {
        const definite = failure instanceof AdRequestError && [400, 404, 409, 413, 422].includes(failure.status);
        setState({ pending: false, frozen: Boolean(request.current), error: adError(failure), result: null, canEdit: definite });
      }
      return null;
    } finally { if (lease.current === owner) { lease.current = null; if (valid()) setState(s => ({ ...s, pending: false })); } }
  }
  const reset = () => {
    if (lease.current || !current.current.allowed || state.result === null && !state.canEdit) return;
    generation.current++; request.current = null; setState({ pending: false, frozen: false, error: "", result: null, canEdit: false });
  };
  const visible = allowed && installed.current === scopeStamp ? state : { pending: false, frozen: false, error: "", result: null, canEdit: false };
  return { ...visible, locked: visible.pending || visible.frozen || visible.result !== null, submit, reset };
}
export const adIdempotency = () => crypto.randomUUID();
export async function adDownload(path: string): Promise<Blob> {
  let response: Response;
  try { response = await fetch(`/api/advertising/${path}`, { credentials: "same-origin", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(60_000) }); }
  catch { throw new AdRequestError(0, "广告附件读取中断 请重新读取"); }
  if (!response.ok) {
    let code: "authority_changed" | null = null;
    // Only this fixed public code is read; never echo an upstream error body.
    if (response.status === 409 && response.body) {
      const reader = response.body.getReader(), chunks: Uint8Array[] = [];
      let length = 0, oversized = false;
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          length += part.value.byteLength;
          if (length > 4096) { oversized = true; await reader.cancel(); break; }
          chunks.push(part.value);
        }
        if (!oversized) {
          const bytes = new Uint8Array(length); let offset = 0;
          for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
          const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
          if (value && typeof value === "object" && !Array.isArray(value) && "code" in value && value.code === "authority_changed") code = "authority_changed";
        }
      } catch { /* An unreadable denial remains a generic attachment failure. */ }
      finally { reader.releaseLock(); }
    }
    if ([401, 403].includes(response.status) || code === "authority_changed") adRecheckSession();
    throw new AdRequestError(response.status, code === "authority_changed" ? "当前身份或权限已变化 私有内容已清除" : response.status === 401 ? "身份会话失效 私有内容已清除" : response.status === 403 ? "当前没有读取此广告附件的权限 私有内容已清除" : "广告附件当前不可读取 请核对来源后重试", code);
  }
  const kind = response.headers.get("content-type") ?? "";
  if (!kind.startsWith("text/csv") && !kind.startsWith("application/json")) throw new AdRequestError(502, "返回附件类型无法核对 未触发下载");
  const blob = await response.blob();
  if (blob.size > 32 * 1024 * 1024) throw new AdRequestError(502, "返回附件超过完整读取上限 未截断下载");
  return blob;
}
export const adPercent = (bps: number | null) =>
  bps === null ? "—" : `${(bps / 100).toFixed(1)}%`;
export function adMoney(minor: number | null, currency: string | null, basis?: AdCurrencyBasis | null) {
  return formatAdMinorAmount(minor, currency, basis);
}
/** A historical value is editable as major units only when its original precision was saved. */
export function adMajor(minor: number | null, currency: string | null, basis?: AdCurrencyBasis | null) {
  if (minor === null || !currency || !basis) return "";
  return formatAdMinorAmount(minor, currency, basis).slice(currency.length + 1);
}
export function adInputMinor(value: string, currency: string): number | null {
  if (!value.trim()) return null;
  const basis = adCurrencyBasis(currency);
  if (!basis) throw new Error("币种精度尚未确认 暂不能录入该币种金额");
  if (!/^\d+(?:\.\d+)?$/.test(value.trim())) throw new Error("请输入非负十进制金额 不填写币种符号或千位分隔符");
  return parseAdMinorAmount(value.trim(), currency);
}
export const adMetricLabels: Record<keyof AdMetricColumns, string> = {
  impressions: "展示量", clicks: "点击量", purchases: "购买量",
  spendMinor: "广告花费", salesMinor: "归因销售额", bidMinor: "竞价",
};
export const adConversionLabels: Record<AdAttributionModel, string> = {
  click: "点击转化", legacy_click_and_view: "旧版点击与浏览转化",
  shopping_signal_2026: "购物信号转化 shopping signal", all_views_14d: "全部浏览转化 固定 14 天",
  unknown: "未确认指标定义",
};
export const adDayNow = () => new Date().toISOString().slice(0, 10);
export const adLabels: Record<AdReportType, string> = {
  campaign: "活动",
  advertised_product: "广告商品",
  targeting: "投放",
  search_term: "搜索词",
  placement: "广告位",
  converted_product: "已购买商品",
  audience: "受众",
  benchmark: "基准",
  delivery_measurement: "展示测量",
  search_term_share: "搜索词份额",
  top_of_search_share: "搜索顶部份额",
};
export const adStatusLabels: Record<AdActionStatus, string> = {
  pending: "待审阅",
  adopted: "已采纳",
  executed: "已执行",
  observing: "观察中",
  reviewed: "已复盘",
  rejected: "已驳回",
  deferred: "暂缓",
  stale: "已过期",
};
export const adNextStates: Record<AdActionStatus, AdActionStatus[]> = {
  pending: ["adopted", "deferred", "rejected"],
  adopted: ["executed", "deferred", "rejected"],
  executed: ["observing"],
  observing: ["reviewed"],
  reviewed: [],
  rejected: [],
  deferred: ["pending", "rejected"],
  stale: [],
};
export function adRankProgress(product: AdProductSummary) {
  return (product.goal?.fields.coreKeywords ?? []).map((keyword) => {
    const records = product.observations
      .filter(
        (o) =>
          o.kind === "organic_rank" &&
          normalizeAdTerm(o.keyword ?? "") === normalizeAdTerm(keyword) &&
          o.periodStart >= product.goal!.fields.effectiveFrom,
      )
      .sort(
        (a, b) =>
          a.periodStart.localeCompare(b.periodStart) ||
          b.observedAt.localeCompare(a.observedAt) ||
          b.createdAt.localeCompare(a.createdAt),
      );
    const days = new Map<string, (typeof records)[number]>();
    for (const r of records) if (!days.has(r.periodStart)) days.set(r.periodStart, r);
    const daily = [...days.values()],
      first = daily[0],
      latest = daily.at(-1);
    return {
      keyword,
      baseline: first?.organicRank ?? null,
      latest: latest?.organicRank ?? null,
      date: latest?.periodStart ?? null,
      source: latest?.source ?? null,
      change: daily.length > 1 ? latest!.organicRank! - first!.organicRank! : null,
    };
  });
}
