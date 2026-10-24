"use client";
import type { z } from "zod";

export type CapacityIdentity = { authority: string | null; localDevelopment: boolean };
export class CapacityRequestError extends Error {
  constructor(readonly status: number, message: string, readonly code: string | null = null) { super(message); }
}
export const capacityDenied = (failure: unknown) => failure instanceof CapacityRequestError && ([401, 403, 404].includes(failure.status) || failure.code === "authority_changed");
export function capacityRecheck() { window.dispatchEvent(new Event("focus")); }
export function capacityError(failure: unknown) { return failure instanceof CapacityRequestError ? failure.message : "请核对产能池 日期 时间和实际生产依据"; }
export async function capacityRequest<S extends z.ZodType>(path: string, schema: S, identity: CapacityIdentity, body?: unknown, signal?: AbortSignal): Promise<z.output<S>> {
  const reading = body === undefined || path.endsWith("/capacity-preview") || path.endsWith("/capacity/resolve-time");
  let response: Response;
  try {
    response = await fetch(`/api/factory-capacity/${path}`, { method: body === undefined ? "GET" : "POST", credentials: "same-origin", redirect: "error", cache: "no-store",
      headers: { accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(body === undefined ? 25_000 : 60_000)]) : AbortSignal.timeout(body === undefined ? 25_000 : 60_000) });
  } catch (failure) { if (signal?.aborted) throw failure; throw new CapacityRequestError(0, reading ? "产能依据读取中断 请重新读取 本次预览不会预留额度" : "本次响应尚未确认 请保留原正文与原键 不另建提交"); }
  const raw: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const code = raw && typeof raw === "object" && "code" in raw && raw.code === "authority_changed" ? "authority_changed" : null;
    const messages: Record<number, string> = { 400: "请核对产能字段 工厂当地日期与完整资源池", 401: "当前身份已失效 私有产能资料已清除", 403: "当前权限不足 私有产能资料已清除", 404: "原工厂或产能记录当前不可访问", 409: "产能余额 固定版本或当地时间已变化 请重新核对", 413: "完整产能资料超过支持大小 未截断提交", 422: "当地时间或产能安排未通过核对 请检查日期和工作规则" };
    if ([401, 403].includes(response.status) || code) capacityRecheck();
    throw new CapacityRequestError(response.status, code ? "当前身份或权限范围已变化 私有产能资料已清除" : messages[response.status] ?? "产能服务响应无法确认 请保留原填写后重读", code);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new CapacityRequestError(502, "产能回执格式无法核对 未用旧资料补填");
  const value = parsed.data;
  if (value && typeof value === "object" && "contextAuthority" in value && !identity.localDevelopment && (!identity.authority || value.contextAuthority !== identity.authority)) {
    capacityRecheck(); throw new CapacityRequestError(409, "当前身份依据已变化 私有产能资料已清除", "authority_changed");
  }
  return parsed.data;
}
export const capacityUnitName = (unit: "each" | "minute") => unit === "minute" ? "分钟" : "件产能单位";
export function capacityReason(code: string) {
  const names: Record<string, string> = {
    factory_capacity_amount_unknown: "当日产能额度未知 请核对实际额度后登记新版本",
    factory_capacity_calendar_invalid: "当地工作日历无法核对 请检查完整工作区间",
    factory_capacity_cutoff_passed: "已过工厂当地截单时间 请选择其他实际生产日期",
    factory_capacity_date_in_past: "所选工厂当地生产日期已经过去",
    factory_capacity_day_closed: "所选当地日期闭厂 没有可预约工作区间",
    factory_capacity_local_time_invalid: "工厂当地时间不存在或存在夏令时歧义 请明确可解析时刻",
    factory_capacity_minutes_exceed_working_time: "分钟额度超过当日实际工作分钟 请核对日历规则",
    factory_capacity_pool_inactive: "必需资源池处于暂停或未启用状态 不能新预约",
    factory_capacity_working_day_ended: "工厂当地工作时段已经结束",
    factory_capacity_factory_inactive: "工厂当前尚未启用 不能新预约",
    factory_capacity_time_zone_changed: "当前工厂时区与固定资源池或生产版本不同 请先核对来源",
    factory_capacity_legacy_untracked: "存在未建立产能台账的历史生产 占用未知 新预约受阻",
    factory_capacity_production_basis_invalid: "原工厂版本或能力版本不可核对 不以当前来源补填",
    factory_capacity_binding_unconfirmed: "该固定能力尚无已确认资源池 新预约受阻",
    factory_capacity_binding_set_changed: "当前必需资源池集合已变化 请重新读取并完整选择",
    factory_capacity_basis_changed: "资源池固定版本已变化 请重新读取和预览",
    factory_capacity_after_completion: "所选工作区间结束晚于预计完工时刻 请核对生产日期和工厂当地完工时间",
    factory_capacity_units_invalid: "本批资源用量超过支持范围 请核对实际数量与每件用量",
    factory_capacity_insufficient: "本批全部商品合计超过该池当日可用产能 请调整实际生产日期",
  };
  return names[code] ?? "产能规则暂时无法核对 请重新读取实际工厂依据";
}
export function capacityLocalInstant(value: string, timeZone: string) { return new Intl.DateTimeFormat("zh-CN", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(value)); }
