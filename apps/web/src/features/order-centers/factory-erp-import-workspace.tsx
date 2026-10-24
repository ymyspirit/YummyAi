"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { z } from "zod";
import { Check, FileCheck2, RefreshCw, Search, X } from "lucide-react";
import { Permission } from "@yummyai/authz/permissions";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import {
  ApplyFactoryErpImportSchema, FactoryErpImportViewSchema, FactoryErpCandidatePageSchema,
  FactoryErpApplyResultSchema, FactoryErpSourceLifecycleSchema, FactoryErpSourceLifecyclePageSchema, FactoryErpApplicationPageSchema,
  type FactoryErpImportView, type UploadFactoryErpImport, type ApplyFactoryErpImport,
  type FactoryErpApplyResult, type FactoryErpSourceLifecycle, type FactoryErpApplicationPage,
} from "@yummyai/contracts/order/factory-erp-import";
import { ChangeFactoryErpBindingSchema, FactoryErpBindingChangeResultSchema,
  type ChangeFactoryErpBinding, type FactoryErpBindingChangeResult } from "@yummyai/contracts/order/factory-erp-binding";
import { FactoryErpVoidReviewResultSchema, type ReviewFactoryErpVoid } from "@yummyai/contracts/order/factory-erp-void-review";
import { useErpAccess } from "../identity/erp-access";
import { useLeaveGuard } from "../navigation/use-leave-guard";
import type { OrderReviewState } from "./order-work-detail";
import {
  FactoryErpUploadForm, FactoryErpBindingForm, FactoryErpImportSummary, FactoryErpRawRow,
  FactoryErpApplySummary, FactoryErpLifecycleSummary, factoryErpLifecycleLabel, factoryErpStatusLabel, factoryErpKnownStatus, factoryErpSha256,
  type FactoryErpRowChoice,
} from "./factory-erp-import-form";
import { FactoryErpBindingCorrection, FactoryErpBindingChangeSummary, FactoryErpBindingChangeReceipt, FactoryErpBindingHistory,
  type FactoryErpBindingIntent, type FactoryErpBindingRead } from "./factory-erp-binding-correction";
import { FactoryErpVoidReviewWorkspace, factoryErpVoidRecoveryPrefix, readFactoryErpVoidRecovery, removeFactoryErpVoidRecovery } from "./factory-erp-void-review-workspace";
import type { FactoryErpVoidIntent, FactoryErpVoidSource } from "./factory-erp-void-review-form";
import "./factory-erp-import.css";

const readPermissions = [Permission.OrderRead, Permission.OrderPiiRead, Permission.DesignRead, Permission.AssetRead];
const recoveryPrefix = "yummyai.factory-erp.apply.v1:";
const RecoverySchema = z.object({ version: z.literal(1), authority: z.string().min(1).max(65_536),
  importId: EntityIdSchema, input: ApplyFactoryErpImportSchema }).strict();
const recoveryKey = (authority: string, factoryId: string) => recoveryPrefix + authority + ":" + factoryId;
const changeRecoveryPrefix = "yummyai.factory-erp.binding-change.v1:";
const ChangeRecoverySchema = z.object({ version: z.literal(1), authority: z.string().min(1).max(65_536),
  bindingId: EntityIdSchema, input: ChangeFactoryErpBindingSchema }).strict();
const changeRecoveryKey = (authority: string, factoryId: string) => changeRecoveryPrefix + authority + ":" + factoryId;
function readChangeRecovery(authority: string, factoryId: string) {
  try {
    const key = changeRecoveryKey(authority, factoryId), text = sessionStorage.getItem(key);
    if (!text) return null;
    const result = text.length <= 256 * 1024 ? ChangeRecoverySchema.safeParse(JSON.parse(text)) : null;
    if (!result?.success || result.data.authority !== authority) { sessionStorage.removeItem(key); return null; }
    return result.data;
  } catch { return null; }
}
function removeChangeRecovery(authority: string | null, factoryId: string, expected?: FactoryErpBindingIntent) {
  if (!authority) return;
  try {
    const saved = expected ? readChangeRecovery(authority, factoryId) : null;
    if (saved && (saved.bindingId !== expected!.bindingId || canonicalJson(saved.input) !== canonicalJson(expected!.input))) return;
    sessionStorage.removeItem(changeRecoveryKey(authority, factoryId));
  } catch { /* Current authority is still required on every restored request. */ }
}
function cleanRecovery(authority: string | null) {
  try {
    const keys = Array.from({ length: sessionStorage.length }, (_, index) => sessionStorage.key(index));
    keys.forEach(key => {
      const prefix = [recoveryPrefix, changeRecoveryPrefix, factoryErpVoidRecoveryPrefix].find(value => key?.startsWith(value));
      if (key && prefix && (!authority || !key.startsWith(prefix + authority + ":"))) sessionStorage.removeItem(key);
    });
  } catch { /* A denied storage area never falls back to persisting private source content. */ }
}
function readRecovery(authority: string, factoryId: string) {
  try {
    const key = recoveryKey(authority, factoryId), text = sessionStorage.getItem(key);
    if (!text) return null;
    const parsed = text.length <= 7 * 1024 * 1024 ? RecoverySchema.safeParse(JSON.parse(text)) : null;
    if (!parsed?.success || parsed.data.authority !== authority) { sessionStorage.removeItem(key); return null; }
    return parsed.data;
  } catch { return null; }
}
function removeRecovery(authority: string | null, factoryId: string, expected?: ApplyFactoryErpImport) {
  if (!authority) return;
  try {
    if (expected) { const stored = readRecovery(authority, factoryId); if (stored && canonicalJson(stored.input) !== canonicalJson(expected)) return; }
    sessionStorage.removeItem(recoveryKey(authority, factoryId));
  } catch { /* The next read still checks exact authority. */ }
}
type PreviewRow = FactoryErpImportView["rows"][number];
type Recent = z.infer<typeof FactoryErpSourceLifecyclePageSchema>;
class FactoryErpRequestError extends Error {
  constructor(readonly status: number, message: string, readonly code: "authority_changed" | null = null) { super(message); }
}
const denied = (error: unknown) => error instanceof FactoryErpRequestError &&
  ([401, 403].includes(error.status) || error.code === "authority_changed");
const rejected = (error: unknown) => error instanceof FactoryErpRequestError && !denied(error) &&
  [400, 409, 413, 415, 422].includes(error.status);
const safeMessage = (error: unknown) => error instanceof FactoryErpRequestError ? error.message : "工厂导入依据暂时无法核对 原请求未自动修改";

async function factoryErpRequest<S extends z.ZodType>(path: string, schema: S, authority: string,
  options: { input?: UploadFactoryErpImport | ApplyFactoryErpImport | ChangeFactoryErpBinding | ReviewFactoryErpVoid; signal?: AbortSignal } = {}): Promise<z.output<S>> {
  let response: Response;
  try {
    response = await fetch("/api/factory-erp-import/" + path, {
      method: options.input ? "POST" : "GET", credentials: "same-origin", cache: "no-store", redirect: "error",
      headers: { accept: "application/json", ...(options.input ? { "content-type": "application/json" } : {}) },
      ...(options.input ? { body: JSON.stringify(options.input) } : {}),
      signal: options.input ? AbortSignal.timeout(120_000) : AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(35_000)]),
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new FactoryErpRequestError(0, options.input ? "本次写入响应尚未确认 已保留完整原请求 请按同一编号恢复" : "工厂导入读取中断 请重新读取");
  }
  const reader = response.body?.getReader(), chunks: Uint8Array[] = []; let size = 0, raw: unknown = null;
  try {
    if (reader) {
      while (true) {
        const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.byteLength;
        if (size > (response.ok ? 8 * 1024 * 1024 : 8_192)) { await reader.cancel(); throw new Error("size"); }
        chunks.push(chunk.value);
      }
      const bytes = new Uint8Array(size); let offset = 0;
      chunks.forEach(chunk => { bytes.set(chunk, offset); offset += chunk.byteLength; });
      raw = JSON.parse(new TextDecoder().decode(bytes));
    }
  } catch {
    if (response.ok) throw new FactoryErpRequestError(502, "完整原文件或应用回执无法核对 未截断或补写记录");
  } finally { reader?.releaseLock(); }
  if (!response.ok) {
    const code = raw && typeof raw === "object" && "code" in raw && raw.code === "authority_changed" ? "authority_changed" : null;
    const messages: Record<number, string> = {
      400: "请核对原文件 固定表头与完整组绑定", 401: "本人登录已失效 私有导入资料已清除",
      403: "当前权限不足 私有导入资料已清除", 404: "原导入或候选当前不可访问",
      409: "原文件 预览或整组绑定依据已变化 不会自动替换原请求",
      413: "完整原文件或组绑定超限 未截断提交", 415: "请使用原始 XLSX 或 CSV 文件",
      422: "原表状态 完整数量或固定生产来源未通过核对",
    };
    throw new FactoryErpRequestError(response.status, code ? "当前本人或资料范围已变化 私有导入资料已清除" :
      messages[response.status] ?? "工厂导入结果尚未确认 请保留原请求后重试", code);
  }
  if (response.headers.get("x-yummyai-context-authority") !== authority)
    throw new FactoryErpRequestError(409, "当前本人或资料范围已变化 私有导入资料已清除", "authority_changed");
  const result = schema.safeParse(raw);
  if (!result.success) throw new FactoryErpRequestError(502, "返回的完整工厂导入凭据无法核对 未用当前列表补填");
  return result.data;
}

type Choice = FactoryErpRowChoice & { included: boolean };
type Review = { input: ApplyFactoryErpImport; fileName: string; importId: string; sent: boolean };
type Model = {
  scope: string; view: FactoryErpImportView | null; reading: boolean; error: string; notice: string; importDraft: string;
  lifecycle: FactoryErpSourceLifecycle | null;
  fileDirty: boolean; preparing: boolean; upload: UploadFactoryErpImport | null; uploading: boolean; uploadRejected: boolean; reset: number;
  choices: Record<number, Choice>; choiceChecksum: string | null; editing: PreviewRow | null; closing: boolean;
  review: Review | null; applying: boolean; applyRejected: boolean; receipt: FactoryErpApplyResult | null; receiptInput: ApplyFactoryErpImport | null; receiptPage: number;
  recent: Recent | null; recentReading: boolean; recentError: string; recentTrail: Array<string | undefined>;
  applications: FactoryErpApplicationPage | null; applicationsReading: boolean; applicationsError: string; applicationTrail: Array<string | undefined>;
  applicationDraft: string; historicalReceipt: FactoryErpApplyResult | null; historicalReceiptPage: number; receiptReading: boolean; receiptError: string;
  correcting: PreviewRow | null; change: FactoryErpBindingIntent | null; changing: boolean; changeRejected: boolean;
  changeReceipt: FactoryErpBindingChangeResult | null; changeReceiptInput: FactoryErpBindingIntent | null; bindingHistoryVersion: number;
  voidSource: FactoryErpVoidSource | null; voidFocus: { bindingId: string; nonce: number } | null;
};
const fresh = (scope: string): Model => ({
  scope, view: null, reading: false, error: "", notice: "", importDraft: "", lifecycle: null,
  fileDirty: false, preparing: false, upload: null, uploading: false, uploadRejected: false, reset: 0,
  choices: {}, choiceChecksum: null, editing: null, closing: false, review: null, applying: false, applyRejected: false,
  receipt: null, receiptInput: null, receiptPage: 0, recent: null, recentReading: false, recentError: "", recentTrail: [undefined],
  applications: null, applicationsReading: false, applicationsError: "", applicationTrail: [undefined],
  applicationDraft: "", historicalReceipt: null, historicalReceiptPage: 0, receiptReading: false, receiptError: "",
  correcting: null, change: null, changing: false, changeRejected: false, changeReceipt: null, changeReceiptInput: null, bindingHistoryVersion: 0,
  voidSource: null, voidFocus: null,
});

export function FactoryErpApplyReceipt({ value, page, onPage, historical = false }: { value: FactoryErpApplyResult; page: number; onPage(page: number): void; historical?: boolean }) {
  const current = Math.min(page, Math.max(0, Math.ceil(value.observations.length / 25) - 1));
  return <section aria-label={historical ? "工厂原应用历史回执" : "工厂状态应用回执"} className="fei-receipt">
    <h4 tabIndex={-1}>{historical ? "原工厂状态应用回执" : "工厂状态观察已登记"}</h4><p>这是该次应用保存的原回执 不是重新推断今天的状态 读取不会再次应用状态</p>
    <dl className="fei-pairs"><div><dt>实际应用 ID</dt><dd><code>{value.id}</code></dd></div>
      <div><dt>原导入 ID</dt><dd><code>{value.importId}</code></dd></div>
      <div><dt>原文件校验值</dt><dd><code>{value.fileChecksum}</code></dd></div>
      <div><dt>原预览校验值</dt><dd><code>{value.previewChecksum}</code></dd></div>
      <div><dt>原请求校验值</dt><dd><code>{value.requestChecksum}</code></dd></div>
      <div><dt>应用登记时间</dt><dd>{value.createdAt}</dd></div></dl>
    <p>实际处理 {value.appliedRows} 个原表整组 原发货数量仍未知 不代表承运揽收 质检合格或内部订单取消</p>
    <div className="fei-actions"><button className="oc-button" type="button" disabled={current === 0} onClick={() => onPage(current - 1)}>{historical ? "上一页历史应用回执" : "上一页应用回执"}</button>
      <button className="oc-button" type="button" disabled={(current + 1) * 25 >= value.observations.length} onClick={() => onPage(current + 1)}>{historical ? "下一页历史应用回执" : "下一页应用回执"}</button></div>
    <p>当前显示 {current * 25 + 1}–{Math.min((current + 1) * 25, value.observations.length)} / {value.observations.length} 条完整回执</p>
    <ol className="fei-results">{value.observations.slice(current * 25, (current + 1) * 25).map(row => <li key={row.rowNumber}>
      <strong>原表第 {row.rowNumber} 行 · {row.disposition === "exception" ? "记录异常 不取消内部订单" : row.disposition === "advanced" ? "工厂状态已推进" : "保持既有状态 未重复推进"}</strong>
      <p>{row.status === "shipped" ? "工厂已发货" : row.status === "scheduled" ? "已排产" : "无成功工厂状态"}</p>
      <p>原绑定 <code>{row.bindingId}</code> · 不可变观察 <code>{row.observationId}</code></p>
    </li>)}</ol>
  </section>;
}

export function FactoryErpImportWorkspace({ factories, initialFactoryId = "", disabled = false, unavailable = false, onStateChange, onChanged, onDenied }: {
  factories: Array<{ id: string; name: string }>; initialFactoryId?: string; disabled?: boolean;
  unavailable?: boolean; onStateChange?(state: OrderReviewState): void; onChanged(): void; onDenied?(): void;
}) {
  const access = useErpAccess(), canRead = !unavailable && readPermissions.every(permission => access.canTenant(permission));
  const canWrite = canRead && access.canTenant(Permission.OrderWrite);
  const [factoryId, setFactoryId] = useState(() => factories.some(factory => factory.id === initialFactoryId) ? initialFactoryId : "");
  const scope = JSON.stringify([access.authority, access.preferenceScope, factoryId, canRead, canWrite]);
  const [model, setModel] = useState<Model>(() => fresh(scope)), [deniedScope, setDeniedScope] = useState("");
  const [voidState, setVoidState] = useState<OrderReviewState>({ dirty: false, busy: false, loading: false });
  const [retentionPulse, setRetentionPulse] = useState(0);
  const retention = useRef({ scope, bounds: new Map<string, { expiresAt: string; deadline: number }>() });
  if (retention.current.scope !== scope) retention.current = { scope, bounds: new Map() };
  const sourceReadable = useCallback((id: string) => retention.current.scope === scope &&
    (retention.current.bounds.get(id)?.deadline ?? 0) > performance.now(), [scope]);
  const observeLifecycle = useCallback((value: FactoryErpSourceLifecycle, startedAt: number) => {
    if (retention.current.scope !== scope) return;
    const prior = retention.current.bounds.get(value.id);
    if (prior && prior.expiresAt !== value.expiresAt) throw new FactoryErpRequestError(502, "原来源保留依据不一致 未延长私有内容显示");
    // Start at request dispatch so network/body latency can only shorten access.
    const deadline = value.access === "retained" ? startedAt + Date.parse(value.expiresAt) - Date.parse(value.checkedAt) : 0;
    retention.current.bounds.set(value.id, { expiresAt: value.expiresAt, deadline: Math.min(prior?.deadline ?? deadline, deadline) });
  }, [scope]);
  const redactExpired = useCallback((current: Model): Model => current.scope === scope && current.view && !sourceReadable(current.view.id) ? {
    ...current, view: null, editing: null, correcting: null, closing: false, choices: {}, choiceChecksum: null, voidSource: null,
    notice: "已到期 原文已隐藏 请重新读取清理状态 原请求编号与历史回执未自动更改",
  } : current, [scope, sourceReadable]);
  const alive = useRef(true), life = useRef(0), readSequence = useRef(0), recentSequence = useRef(0);
  const readAbort = useRef<AbortController | null>(null), recentAbort = useRef<AbortController | null>(null), closeTimer = useRef<number | null>(null);
  const historyReads = useRef({ applicationSequence: 0, receiptSequence: 0, applicationAbort: null as AbortController | null, receiptAbort: null as AbortController | null });
  const cancelHistoricalReads = useCallback(() => {
    const history = historyReads.current; history.applicationSequence++; history.receiptSequence++;
    history.applicationAbort?.abort(); history.receiptAbort?.abort();
  }, []);
  const writing = useRef<object | null>(null), root = useRef<HTMLElement>(null);
  const ownerPreference = useRef(access.preferenceScope), deniedCallback = useRef(onDenied);
  deniedCallback.current = onDenied;
  if (ownerPreference.current === null && access.preferenceScope !== null) ownerPreference.current = access.preferenceScope;
  const ownerMatches = ownerPreference.current === access.preferenceScope;
  const live = useRef({ scope, canRead, canWrite, authority: access.authority, factoryId });
  live.current = { scope, canRead, canWrite, authority: access.authority, factoryId };
  const stored = useRef(model); stored.current = model;
  const permitted = ownerMatches && canRead && access.authority !== null && factories.some(factory => factory.id === factoryId) && deniedScope !== scope;
  const state = permitted && model.scope === scope ? model : fresh(scope);
  const view = state.view && sourceReadable(state.view.id) ? state.view : null;
  const rawLocked = !!state.upload || !!state.review || !!state.change || !!state.changeReceipt;
  const locked = rawLocked || voidState.dirty || voidState.busy;
  const sourceId = state.lifecycle?.id ?? null;
  const pending = !!state.upload || state.review?.sent === true || state.change?.sent === true || voidState.busy;
  const rawBusy = state.preparing || state.uploading || state.applying || state.changing;
  const networkBusy = rawBusy || voidState.busy;
  const dirty = state.fileDirty || Object.keys(state.choices).length > 0 || !!state.editing || !!state.review || !!state.upload || !!state.correcting || !!state.change || voidState.dirty;
  useLeaveGuard(dirty, networkBusy || pending, permitted);
  const patch = useCallback((update: Partial<Model>) => {
    if (live.current.scope !== scope) return;
    setModel(previous => redactExpired({ ...(previous.scope === scope ? previous : fresh(scope)), ...update, scope }));
  }, [scope, redactExpired]);
  const deny = useCallback(() => {
    life.current++; readSequence.current++; recentSequence.current++; readAbort.current?.abort(); recentAbort.current?.abort(); writing.current = null;
    cancelHistoricalReads();
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    removeRecovery(live.current.authority, live.current.factoryId);
    removeChangeRecovery(live.current.authority, live.current.factoryId);
    removeFactoryErpVoidRecovery(live.current.authority, live.current.factoryId);
    setDeniedScope(scope); setModel(fresh(scope)); deniedCallback.current?.(); window.dispatchEvent(new Event("focus"));
  }, [scope, cancelHistoricalReads]);
  const readFailure = useCallback((error: unknown) => { if (denied(error) || error instanceof FactoryErpRequestError && error.status === 404) deny(); }, [deny]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; life.current++; readSequence.current++; recentSequence.current++;
    readAbort.current?.abort(); recentAbort.current?.abort(); cancelHistoricalReads(); if (closeTimer.current !== null) window.clearTimeout(closeTimer.current); }; }, [cancelHistoricalReads]);
  useLayoutEffect(() => {
    life.current++; readSequence.current++; recentSequence.current++; readAbort.current?.abort(); recentAbort.current?.abort(); writing.current = null;
    cancelHistoricalReads();
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    cleanRecovery(canRead && canWrite && ownerMatches ? access.authority : null);
    const restored = canRead && canWrite && access.authority && factoryId ? readRecovery(access.authority, factoryId) : null;
    const restoredChange = canRead && canWrite && access.authority && factoryId ? readChangeRecovery(access.authority, factoryId) : null;
    setModel({ ...fresh(scope), ...(restored ? { review: { input: restored.input, importId: restored.importId,
      fileName: "原文件名称未保留 可另行按导入 ID 读取", sent: true }, notice: "已恢复本人固定原应用请求 请明确点击原请求重试读取结果 不自动应用" } : {}),
    ...(restoredChange ? { change: { bindingId: restoredChange.bindingId, input: restoredChange.input, sent: true },
      notice: "已恢复本人固定原绑定变更请求 请明确按原请求恢复结果 不自动解除或改绑" } : {}) });
    setDeniedScope("");
    setVoidState({ dirty: false, busy: false, loading: false });
  }, [scope, access.authority, canRead, canWrite, factoryId, ownerMatches, cancelHistoricalReads]);
  useEffect(() => {
    setModel(redactExpired);
    const next = [...retention.current.bounds.values()].map(value => value.deadline).filter(deadline => deadline > performance.now()).sort((a, b) => a - b)[0];
    if (next === undefined) return;
    const timer = window.setTimeout(() => {
      if (!alive.current || live.current.scope !== scope) return;
      setModel(redactExpired); setRetentionPulse(value => value + 1);
    }, Math.min(2_147_000_000, Math.max(1, next - performance.now())));
    return () => window.clearTimeout(timer);
  }, [scope, state.lifecycle, state.recent, retentionPulse, redactExpired]);
  useLayoutEffect(() => {
    if (factoryId || !canRead || !canWrite || !access.authority || !ownerMatches) return;
    try {
      const prefixes = [recoveryPrefix, changeRecoveryPrefix, factoryErpVoidRecoveryPrefix].map(prefix => prefix + access.authority + ":");
      const ids = [...new Set(Array.from({ length: sessionStorage.length }, (_, index) => sessionStorage.key(index))
        .flatMap(key => { const prefix = prefixes.find(value => key?.startsWith(value)); return key && prefix ? [key.slice(prefix.length)] : []; })
        .filter(id => factories.some(factory => factory.id === id) && (readRecovery(access.authority!, id) !== null || readChangeRecovery(access.authority!, id) !== null || readFactoryErpVoidRecovery(access.authority!, id) !== null)))];
      if (ids.length === 1) setFactoryId(ids[0]!);
    } catch { /* Manual factory selection remains available when storage is unavailable. */ }
  }, [factoryId, canRead, canWrite, access.authority, ownerMatches, factories]);
  useEffect(() => { onStateChange?.({ dirty, busy: networkBusy || pending, loading: state.reading || voidState.loading }); }, [dirty, networkBusy, pending, state.reading, voidState.loading, onStateChange]);

  const readRecent = useCallback(async (cursor?: string, trail: Array<string | undefined> = [undefined]) => {
    if (!live.current.canRead || !live.current.authority || !live.current.factoryId || live.current.scope !== scope || deniedScope === scope) return;
    const hadRecent = stored.current.scope === scope && stored.current.recent !== null;
    const abort = new AbortController(), token = ++recentSequence.current; recentAbort.current?.abort(); recentAbort.current = abort;
    const valid = () => alive.current && !abort.signal.aborted && live.current.scope === scope && live.current.canRead && recentSequence.current === token;
    patch({ recentReading: true, recentError: "" });
    try {
      const startedAt = performance.now();
      const params = new URLSearchParams({ factoryId: live.current.factoryId, limit: "20", ...(cursor ? { cursor } : {}) });
      const result = await factoryErpRequest("lifecycle?" + params, FactoryErpSourceLifecyclePageSchema, live.current.authority, { signal: abort.signal });
      if (!valid()) return;
      if (result.items.some(item => item.factoryId !== live.current.factoryId)) throw new FactoryErpRequestError(502, "原文件列表与所选工厂不一致");
      result.items.forEach(item => observeLifecycle(item, startedAt));
      patch({ recent: result, recentReading: false, recentTrail: trail });
    } catch (error) {
      if (valid()) { if (denied(error) || error instanceof FactoryErpRequestError && error.status === 404 && hadRecent) deny();
        else patch({ recentReading: false, recentError: safeMessage(error) }); }
    }
  }, [scope, deniedScope, patch, deny, observeLifecycle]);
  useEffect(() => { if (permitted) void readRecent(); }, [permitted, readRecent]);

  const readImport = useCallback(async (id: string, offset = 0, includePrivate = true) => {
    if (!live.current.canRead || !live.current.authority || live.current.scope !== scope || deniedScope === scope) return;
    const old = stored.current.scope === scope ? stored.current : fresh(scope);
    if (old.upload || old.review && old.review.importId !== id || old.change && old.change.input.source.importId !== id) return;
    const different = (old.lifecycle?.id ?? old.view?.id) !== id;
    if (different) cancelHistoricalReads();
    const abort = new AbortController(), token = ++readSequence.current; readAbort.current?.abort(); readAbort.current = abort;
    const valid = () => alive.current && !abort.signal.aborted && live.current.scope === scope && live.current.canRead && readSequence.current === token;
    patch({ reading: true, error: "", ...(different ? { view: null, lifecycle: null, choices: {}, choiceChecksum: null, editing: null, correcting: null, closing: false, voidSource: null,
      applications: null, applicationsReading: false, applicationsError: "", applicationTrail: [undefined], applicationDraft: "",
      historicalReceipt: null, historicalReceiptPage: 0, receiptReading: false, receiptError: "" } : {}) });
    try {
      const readLifecycle = async () => {
        const startedAt = performance.now();
        const result = await factoryErpRequest("imports/" + id + "/lifecycle", FactoryErpSourceLifecycleSchema, live.current.authority!, { signal: abort.signal });
        if (!valid()) return null;
        if (result.factoryId !== live.current.factoryId) throw new FactoryErpRequestError(502, "原导入属于其他工厂 请明确选择对应工厂");
        if (result.id !== id.toLowerCase()) throw new FactoryErpRequestError(502, "原导入 ID 与保留凭据不一致");
        observeLifecycle(result, startedAt);
        patch({ lifecycle: result });
        return result;
      };
      const lifecycle = await readLifecycle();
      if (!valid() || !lifecycle) return;
      if (!includePrivate || !sourceReadable(id)) { patch({ reading: false, importDraft: "" }); return; }
      let result: FactoryErpImportView;
      try {
        result = await factoryErpRequest("imports/" + id + "?" + new URLSearchParams({ offset: String(offset), limit: "25" }),
          FactoryErpImportViewSchema, live.current.authority!, { signal: abort.signal });
      } catch (error) {
        if (!valid()) return;
        if (error instanceof FactoryErpRequestError && error.status === 404) {
          patch({ view: null, editing: null, correcting: null, choices: {}, choiceChecksum: null, voidSource: null });
          const checked = await readLifecycle();
          if (!valid() || !checked) return;
          if (!sourceReadable(id)) { patch({ reading: false, importDraft: "" }); return; }
          patch({ reading: false, importDraft: "", error: "原文当前不可读取 保留与清理凭据及原应用历史仍可核对 不据此认定已永久删除" });
          return;
        }
        throw error;
      }
      if (!valid()) return;
      if (result.factoryId !== live.current.factoryId) { patch({ reading: false, error: "原导入属于其他工厂 请先明确选择对应工厂" }); return; }
      if (result.id !== id.toLowerCase() || result.fileChecksum !== lifecycle.fileChecksum || result.previewChecksum !== lifecycle.previewChecksum ||
        result.expiresAt !== lifecycle.expiresAt) throw new FactoryErpRequestError(502, "原文件与固定保留凭据不一致");
      if (!sourceReadable(id)) { patch({ view: null, reading: false, importDraft: "" }); return; }
      patch({ view: result, reading: false, importDraft: "", editing: null, correcting: null, closing: false });
    } catch (error) {
      if (!valid()) return;
      if (denied(error) || error instanceof FactoryErpRequestError && error.status === 404 &&
        (old.lifecycle?.id === id || old.view?.id === id || old.recent?.items.some(item => item.id === id))) deny();
      else patch({ reading: false, error: safeMessage(error) });
    }
  }, [scope, deniedScope, patch, deny, observeLifecycle, sourceReadable, cancelHistoricalReads]);
  useEffect(() => {
    const current = stored.current;
    const id = current.review?.importId ?? current.change?.input.source.importId;
    if (permitted && current.scope === scope && id && !current.lifecycle && !current.reading) void readImport(id, 0, false);
  }, [scope, permitted, state.review?.importId, state.change?.input.source.importId, readImport]);
  useEffect(() => {
    const check = () => {
      if (document.visibilityState === "hidden" || live.current.scope !== scope) return;
      setModel(redactExpired); setRetentionPulse(value => value + 1);
      const current = stored.current;
      if (current.scope !== scope || current.uploading || current.applying || current.changing || current.preparing || current.editing || current.correcting) return;
      if (current.lifecycle) void readImport(current.lifecycle.id, current.view?.offset ?? 0, !!current.view);
      void readRecent(current.recentTrail.at(-1), current.recentTrail);
    };
    window.addEventListener("focus", check); document.addEventListener("visibilitychange", check);
    return () => { window.removeEventListener("focus", check); document.removeEventListener("visibilitychange", check); };
  }, [scope, readImport, readRecent, redactExpired]);

  const readApplications = useCallback(async (cursor?: string, trail: Array<string | undefined> = [undefined]) => {
    const id = sourceId, current = stored.current;
    if (!id || !live.current.canRead || !live.current.authority || live.current.scope !== scope || deniedScope === scope || current.lifecycle?.id !== id) return;
    const history = historyReads.current, abort = new AbortController();
    const token = ++history.applicationSequence; history.applicationAbort?.abort(); history.applicationAbort = abort;
    const valid = () => alive.current && !abort.signal.aborted && live.current.scope === scope && live.current.canRead &&
      history.applicationSequence === token && stored.current.lifecycle?.id === id;
    patch({ applicationsReading: true, applicationsError: "" });
    try {
      const result = await factoryErpRequest("imports/" + id + "/applications?" + new URLSearchParams({ limit: "20", ...(cursor ? { cursor } : {}) }),
        FactoryErpApplicationPageSchema, live.current.authority, { signal: abort.signal });
      if (!valid()) return;
      if (result.items.some(item => item.importId !== id)) throw new FactoryErpRequestError(502, "应用历史与所选原来源不一致");
      patch({ applications: result, applicationsReading: false, applicationTrail: trail });
    } catch (error) {
      if (!valid()) return;
      if (denied(error) || error instanceof FactoryErpRequestError && error.status === 404) deny();
      else patch({ applicationsReading: false, applicationsError: safeMessage(error) });
    }
  }, [scope, sourceId, deniedScope, patch, deny]);
  useEffect(() => { if (permitted && sourceId) void readApplications(); }, [permitted, sourceId, state.lifecycle?.lastApplicationId, readApplications]);

  async function readApplication(rawId: string) {
    const parsed = EntityIdSchema.safeParse(rawId.trim()), id = sourceId, lifecycle = stored.current.lifecycle;
    if (!parsed.success) { patch({ receiptError: "请填写完整有效的原应用 ID" }); return; }
    if (!id || !lifecycle || lifecycle.id !== id || !live.current.canRead || !live.current.authority || live.current.scope !== scope || deniedScope === scope) return;
    const applicationId = parsed.data.toLowerCase(), history = historyReads.current, abort = new AbortController();
    const token = ++history.receiptSequence; history.receiptAbort?.abort(); history.receiptAbort = abort;
    const hadReceipt = stored.current.historicalReceipt?.id === applicationId || lifecycle.lastApplicationId === applicationId ||
      stored.current.applications?.items.some(item => item.id === applicationId) === true;
    const valid = () => alive.current && !abort.signal.aborted && live.current.scope === scope && live.current.canRead &&
      history.receiptSequence === token && stored.current.lifecycle?.id === id;
    patch({ receiptReading: true, receiptError: "", historicalReceipt: null, historicalReceiptPage: 0 });
    try {
      const result = await factoryErpRequest("imports/" + id + "/applications/" + applicationId, FactoryErpApplyResultSchema,
        live.current.authority, { signal: abort.signal });
      if (!valid()) return;
      if (result.id !== applicationId || result.importId !== id || result.fileChecksum !== lifecycle.fileChecksum || result.previewChecksum !== lifecycle.previewChecksum)
        throw new FactoryErpRequestError(502, "原应用回执与所选来源或固定校验值不一致");
      patch({ historicalReceipt: result, receiptReading: false, applicationDraft: applicationId });
    } catch (error) {
      if (!valid()) return;
      if (denied(error) || error instanceof FactoryErpRequestError && error.status === 404 && hadReceipt) deny();
      else patch({ receiptReading: false, receiptError: safeMessage(error) });
    }
  }
  function closeHistoricalReceipt() {
    historyReads.current.receiptSequence++; historyReads.current.receiptAbort?.abort();
    patch({ historicalReceipt: null, historicalReceiptPage: 0, receiptReading: false, receiptError: "" });
  }

  const loadCandidates = useCallback(async (query: { q: string; cursor?: string }, signal: AbortSignal) => {
    const id = stored.current.view?.id;
    if (!live.current.canRead || !live.current.authority || live.current.scope !== scope) throw new FactoryErpRequestError(403, "当前原生产候选不可读取");
    if (!id || !sourceReadable(id)) throw new FactoryErpRequestError(410, "原来源已到期 候选与原文已隐藏");
    const result = await factoryErpRequest("candidates?" + new URLSearchParams({
      factoryId: live.current.factoryId, limit: "25", ...(query.q ? { q: query.q } : {}), ...(query.cursor ? { cursor: query.cursor } : {}),
    }), FactoryErpCandidatePageSchema, live.current.authority, { signal });
    if (live.current.scope !== scope || stored.current.view?.id !== id || !sourceReadable(id)) throw new FactoryErpRequestError(410, "原来源已变化或到期 旧候选未重新显示");
    return result;
  }, [scope, sourceReadable]);
  const bindingRequest: FactoryErpBindingRead = useCallback(async <S extends z.ZodType>(path: string, schema: S, signal: AbortSignal): Promise<z.output<S>> => {
    const captured = live.current;
    if (!captured.canRead || !captured.authority || captured.scope !== scope || deniedScope === scope)
      throw new FactoryErpRequestError(403, "当前原工厂绑定不可读取");
    const result = await factoryErpRequest(path, schema, captured.authority, { signal });
    if (live.current.scope !== scope || !live.current.canRead || live.current.factoryId !== captured.factoryId || live.current.authority !== captured.authority)
      throw new FactoryErpRequestError(409, "当前本人或工厂已变化 旧绑定读取未回填", "authority_changed");
    if (result && typeof result === "object" && "factoryId" in result && result.factoryId !== captured.factoryId)
      throw new FactoryErpRequestError(502, "原绑定与当前所选工厂不一致");
    return result;
  }, [scope, deniedScope]);
  const readVoidSource = useCallback((id: string, privateContent: boolean) => { void readImport(id, 0, privateContent); }, [readImport]);
  const voidSourceExpired = useCallback((id: string) => stored.current.scope === scope && stored.current.lifecycle?.id === id && stored.current.lifecycle.access === "expired", [scope]);
  const submitVoidReview = useCallback(async (intent: FactoryErpVoidIntent) => {
    const captured = live.current;
    if (writing.current || !captured.canWrite || !captured.authority || captured.scope !== scope || disabled || deniedScope === scope)
      throw new FactoryErpRequestError(403, "当前不能登记原作废核对");
    const current = stored.current;
    if (current.upload || current.review || current.change || current.receipt || current.changeReceipt ||
      readRecovery(captured.authority, captured.factoryId) || readChangeRecovery(captured.authority, captured.factoryId))
      throw new FactoryErpRequestError(409, "还有待确认原应用或绑定变更 本次原核对未发送");
    const ticket = {}; writing.current = ticket;
    try { return await factoryErpRequest("bindings/" + intent.bindingId + "/void-reviews", FactoryErpVoidReviewResultSchema, captured.authority, { input: intent.input }); }
    finally { if (writing.current === ticket) writing.current = null; }
  }, [scope, disabled, deniedScope]);

  async function upload(input: UploadFactoryErpImport) {
    if (writing.current || stored.current.change || stored.current.changeReceipt || !live.current.canWrite || !live.current.authority || live.current.scope !== scope || disabled || deniedScope === scope) return;
    if (readFactoryErpVoidRecovery(live.current.authority, live.current.factoryId)) { patch({ error: "仍有待确认的原作废核对 请先恢复其结果 本次未上传新文件" }); return; }
    const ticket = {}, epoch = life.current; writing.current = ticket;
    readSequence.current++; readAbort.current?.abort();
    patch({ upload: input, uploading: true, uploadRejected: false, reading: false, error: "", notice: "" });
    const valid = () => alive.current && live.current.scope === scope && live.current.canWrite && epoch === life.current;
    let uploaded: FactoryErpImportView | null = null;
    try {
      const result = await factoryErpRequest("upload", FactoryErpImportViewSchema, live.current.authority, { input });
      if (!valid()) return;
      if (result.factoryId !== input.factoryId || result.fileChecksum !== input.checksumSha256) throw new FactoryErpRequestError(502, "原文件与上传回执不一致");
      uploaded = result;
      const startedAt = performance.now();
      const lifecycle = await factoryErpRequest("imports/" + result.id + "/lifecycle", FactoryErpSourceLifecycleSchema, live.current.authority!, {});
      if (!valid()) return;
      if (lifecycle.id !== result.id || lifecycle.factoryId !== input.factoryId || lifecycle.fileChecksum !== result.fileChecksum ||
        lifecycle.previewChecksum !== result.previewChecksum || lifecycle.expiresAt !== result.expiresAt) throw new FactoryErpRequestError(502, "上传与原来源保留凭据不一致");
      observeLifecycle(lifecycle, startedAt); cancelHistoricalReads();
      patch({ lifecycle, view: sourceReadable(result.id) ? result : null, upload: null, uploading: false, fileDirty: false,
        reset: stored.current.reset + 1, choices: {}, choiceChecksum: null, editing: null, closing: false, receipt: null, voidSource: null,
        applications: null, applicationsReading: false, applicationsError: "", applicationTrail: [undefined], applicationDraft: "",
        historicalReceipt: null, historicalReceiptPage: 0, receiptReading: false, receiptError: "", notice: "原文件与预览已保存 尚未应用工厂状态" });
      void readRecent();
    } catch (error) {
      if (valid()) {
        if (denied(error) || uploaded && error instanceof FactoryErpRequestError && error.status === 404) deny();
        else if (uploaded) {
          patch({ upload: null, uploading: false, uploadRejected: false, fileDirty: false, reset: stored.current.reset + 1,
            importDraft: uploaded.id, error: "原文件上传已保存 保留凭据读取未完成 请按原导入 ID 核对 不重复上传",
            notice: "已登记原导入 ID " + uploaded.id + " 尚未应用工厂状态" });
          void readRecent();
        } else patch({ uploading: false, uploadRejected: rejected(error), error: safeMessage(error) });
      }
    } finally { if (writing.current === ticket) writing.current = null; }
  }
  function chooseRow(value: FactoryErpRowChoice) {
    if (!view || !sourceReadable(view.id) || locked || !canWrite || disabled || live.current.scope !== scope) return;
    setModel(previous => previous.scope === scope ? redactExpired({ ...previous, editing: null, closing: false,
      correcting: null, choices: { ...previous.choices, [value.row.rowNumber]: { ...value, included: true } },
      choiceChecksum: previous.choiceChecksum ?? view.previewChecksum }) : previous);
  }
  function closeEditor() {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    const finish = () => { if (alive.current && live.current.scope === scope) patch({ editing: null, correcting: null, closing: false }); };
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) finish();
    else { patch({ closing: true }); closeTimer.current = window.setTimeout(finish, 150); }
  }
  function prepare() {
    if (!view || !sourceReadable(view.id) || locked || disabled || !canWrite || state.reading || state.choiceChecksum !== view.previewChecksum || live.current.scope !== scope) return;
    const choices = Object.values(state.choices).filter(item => item.included);
    if (!choices.length || choices.some(item => !item.association || !factoryErpKnownStatus(item.row.rawStatus) || item.row.diagnostics.length > 0)) return;
    const result = ApplyFactoryErpImportSchema.safeParse({
      fileChecksum: view.fileChecksum, previewChecksum: view.previewChecksum, idempotencyKey: crypto.randomUUID(), confirmed: true,
      rows: choices.sort((left, right) => left.row.rowNumber - right.row.rowNumber).map(item =>
        ({ rowNumber: item.row.rowNumber, wholeGroupConfirmed: true, items: item.items, association: item.association })),
    });
    if (!result.success) { patch({ error: "完整组绑定有重复交付项或数量依据缺失 请核对全部选中组 不会截断或自动改绑" }); return; }
    patch({ review: { input: structuredClone(result.data), fileName: "原文件名称仅在保留期内另行读取", importId: view.id, sent: false }, error: "", notice: "" });
  }
  async function apply(review: Review) {
    if (writing.current || !live.current.canWrite || !live.current.authority || live.current.scope !== scope || disabled || deniedScope === scope) return;
    const lifecycle = stored.current.lifecycle;
    if (!sourceReadable(review.importId) && !(review.sent && lifecycle?.id === review.importId && lifecycle.access === "expired")) {
      patch({ error: "原来源已到期或保留依据尚未核对 本次未应用 请重新读取清理状态" }); return;
    }
    try {
      const recovery = RecoverySchema.parse({ version: 1, authority: live.current.authority, importId: review.importId, input: review.input });
      const existing = readRecovery(live.current.authority, live.current.factoryId);
      if (readChangeRecovery(live.current.authority, live.current.factoryId) || readFactoryErpVoidRecovery(live.current.authority, live.current.factoryId)) {
        patch({ error: "同一工厂还有待确认的原绑定变更或作废核对 请先恢复该请求 本次原应用未发送" }); return;
      }
      if (existing && (existing.importId !== review.importId || canonicalJson(existing.input) !== canonicalJson(review.input))) {
        patch({ error: "同一工厂已有另一笔待确认原应用 请先刷新页面恢复该原请求 本次未发送也未覆盖它" }); return;
      }
      sessionStorage.setItem(recoveryKey(live.current.authority, live.current.factoryId), JSON.stringify(recovery));
    } catch {
      patch({ error: "当前浏览器无法保留完整原应用请求 本次未发送 请检查浏览器存储或减少本次明确选择的整组" }); return;
    }
    const ticket = {}, epoch = life.current; writing.current = ticket;
    readSequence.current++; readAbort.current?.abort();
    const original = { ...review, sent: true }; patch({ review: original, applying: true, applyRejected: false, reading: false, error: "", notice: "" });
    const valid = () => alive.current && live.current.scope === scope && live.current.canWrite && epoch === life.current;
    try {
      const result = await factoryErpRequest("imports/" + review.importId + "/apply", FactoryErpApplyResultSchema, live.current.authority, { input: review.input });
      if (!valid()) return;
      const requestChecksum = await factoryErpSha256(new TextEncoder().encode(canonicalJson({
        version: 1, operation: "factory-erp-apply", importId: review.importId, input: review.input,
      })));
      if (!valid()) return;
      if (result.importId !== review.importId || result.fileChecksum !== review.input.fileChecksum || result.previewChecksum !== review.input.previewChecksum ||
        result.requestChecksum !== requestChecksum)
        throw new FactoryErpRequestError(502, "固定原请求与应用回执不一致");
      patch({ receipt: result, receiptInput: review.input, receiptPage: 0, review: null, applying: false, choices: {}, choiceChecksum: null });
      requestAnimationFrame(() => {
        if (!valid()) return; const heading = root.current?.querySelector<HTMLElement>('[aria-label="工厂状态应用回执"] h4');
        heading?.scrollIntoView({ block: "nearest", behavior: "instant" }); heading?.focus({ preventScroll: true });
      });
    } catch (error) {
      if (valid()) { if (denied(error)) deny(); else patch({ applying: false, applyRejected: rejected(error), error: safeMessage(error) }); }
    } finally { if (writing.current === ticket) writing.current = null; }
  }
  function prepareChange(value: FactoryErpBindingIntent) {
    if (!view || !sourceReadable(view.id) || !canWrite || disabled || locked || networkBusy || live.current.scope !== scope ||
      state.correcting?.binding?.id !== value.bindingId || value.input.source.importId !== view.id ||
      value.input.source.fileChecksum !== view.fileChecksum || value.input.source.previewChecksum !== view.previewChecksum ||
      value.input.source.rowNumber !== state.correcting.rowNumber) return;
    patch({ change: { bindingId: value.bindingId, input: structuredClone(value.input), sent: false }, correcting: null,
      editing: null, closing: false, choices: {}, choiceChecksum: null, changeRejected: false, error: "", notice: "原绑定变更请求已固定 尚未解除或改绑" });
  }
  async function executeChange(intent: FactoryErpBindingIntent) {
    if (writing.current || !live.current.canWrite || !live.current.authority || live.current.scope !== scope || disabled || deniedScope === scope ||
      stored.current.review || stored.current.upload) return;
    const importId = intent.input.source.importId, lifecycle = stored.current.lifecycle;
    if (!sourceReadable(importId) && !(intent.sent && lifecycle?.id === importId && lifecycle.access === "expired")) {
      patch({ error: "有效来源已到期或保留依据尚未核对 未创建新变更 请重新读取清理状态后核对原请求" }); return;
    }
    try {
      if (readRecovery(live.current.authority, live.current.factoryId) || readFactoryErpVoidRecovery(live.current.authority, live.current.factoryId)) {
        patch({ error: "同一工厂还有待确认的原状态应用或作废核对 请先恢复该请求 本次绑定变更未发送" }); return;
      }
      const existing = readChangeRecovery(live.current.authority, live.current.factoryId);
      if (existing && (existing.bindingId !== intent.bindingId || canonicalJson(existing.input) !== canonicalJson(intent.input))) {
        patch({ error: "同一工厂已有另一笔待确认绑定变更 本次未发送或覆盖 请刷新恢复原请求" }); return;
      }
      const saved = ChangeRecoverySchema.parse({ version: 1, authority: live.current.authority, bindingId: intent.bindingId, input: intent.input });
      sessionStorage.setItem(changeRecoveryKey(live.current.authority, live.current.factoryId), JSON.stringify(saved));
    } catch {
      patch({ error: "当前浏览器无法保留固定原绑定变更请求 本次未发送 请核对浏览器会话存储" }); return;
    }
    const ticket = {}, epoch = life.current; writing.current = ticket;
    readSequence.current++; readAbort.current?.abort();
    const original = { ...intent, sent: true };
    patch({ change: original, changing: true, changeRejected: false, reading: false, error: "", notice: "" });
    const valid = () => alive.current && live.current.scope === scope && live.current.canWrite && epoch === life.current;
    try {
      const result = await factoryErpRequest("bindings/" + intent.bindingId + "/changes", FactoryErpBindingChangeResultSchema,
        live.current.authority, { input: intent.input });
      if (!valid()) return;
      const requestChecksum = await factoryErpSha256(new TextEncoder().encode(canonicalJson({
        version: 1, operation: "factory-erp-binding-change", bindingId: intent.bindingId, input: intent.input,
      })));
      if (!valid()) return;
      if (result.bindingId !== intent.bindingId || result.factoryId !== live.current.factoryId || result.action !== intent.input.action ||
        result.reasonCode !== intent.input.reasonCode || result.originalRevision !== intent.input.expectedRevision ||
        result.originalItemsChecksum !== intent.input.expectedItemsChecksum || result.originalObservationSequence !== intent.input.expectedObservationSequence ||
        canonicalJson(result.source) !== canonicalJson(intent.input.source) || result.requestChecksum !== requestChecksum)
        throw new FactoryErpRequestError(502, "原绑定变更请求与实际回执不一致 未按当前状态补写");
      patch({ change: null, changeReceipt: result, changeReceiptInput: original, changing: false, choices: {}, choiceChecksum: null });
      requestAnimationFrame(() => {
        if (!valid()) return;
        const heading = root.current?.querySelector<HTMLElement>('[aria-label="原工厂绑定变更回执"] h4');
        heading?.scrollIntoView({ block: "nearest", behavior: "instant" }); heading?.focus({ preventScroll: true });
      });
    } catch (error) {
      if (valid()) { if (denied(error)) deny(); else patch({ changing: false, changeRejected: rejected(error), error: safeMessage(error) }); }
    } finally { if (writing.current === ticket) writing.current = null; }
  }
  function readOther(id: string) {
    if (locked || networkBusy || state.editing || state.correcting) return;
    if (Object.keys(state.choices).length > 0 && !window.confirm("有尚未应用的整组选择 确认放弃这些选择并读取另一份原导入")) return;
    void readImport(id);
  }
  function readById(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const id = EntityIdSchema.safeParse(state.importDraft.trim());
    if (!id.success) { patch({ error: "请填写完整有效的原工厂导入 ID" }); return; }
    readOther(id.data.toLowerCase());
  }
  const selectionCount = Object.values(state.choices).filter(item => item.included).length;
  if (!ownerMatches) return <section className="fei-workspace" aria-label="工厂 Excel／CSV 状态同步"><h3>工厂 Excel／CSV 状态同步</h3>
    <p>当前本人已变化 旧工厂资料和填写已隐藏 请重新进入当前身份页面读取</p>
    <button className="oc-button" type="button" onClick={() => window.location.reload()}>重新读取当前身份页面</button></section>;
  if (!canRead) return <section className="fei-workspace" aria-label="工厂 Excel／CSV 状态同步"><h3>工厂 Excel／CSV 状态同步</h3>
    <p>当前账户缺少订单 私人订单资料 设计或资产的租户读取权限 私有导入资料已隐藏</p></section>;
  return <section ref={root} className="fei-workspace" aria-label="工厂 Excel／CSV 状态同步">
    <header className="fei-heading"><div><h3><FileCheck2 size={17} aria-hidden="true" />工厂 Excel／CSV 状态同步</h3>
      <p>先预览原文件 明确整组绑定后再确认应用 不自动向外部工厂提交</p></div></header>
    <label className="fei-factory">导入工厂<select aria-label="导入工厂" value={factoryId} disabled={disabled || dirty || networkBusy || pending} onChange={event => setFactoryId(event.target.value)}>
      <option value="">先明确选择真实工厂</option>{factories.map(factory => <option key={factory.id} value={factory.id}>{factory.name}</option>)}
    </select></label>
    {deniedScope === scope && <p role="alert" className="oc-delivery-error">当前本人或读取范围已变化 私有原文件 预览和填写已清除 请重新核对当前身份权限</p>}
    {!factoryId && <p className="fei-hint">先选择工厂 再读取原导入或上传原文件 同一个外部编号不跨工厂自动合并</p>}
    {permitted && <>
      {!canWrite && <p className="fei-hint">当前仅可读取原导入 登记和应用还需要订单写权限</p>}
      {canWrite && <FactoryErpUploadForm factoryId={factoryId} scope={scope} reset={state.reset} disabled={disabled || locked || !!state.receipt || !!state.editing || !!state.correcting || state.reading || Object.keys(state.choices).length > 0}
        onPrepared={input => void upload(input)} onDirty={value => patch({ fileDirty: value })} onPreparing={value => patch({ preparing: value })} />}
      {state.upload && <section aria-label="恢复原工厂文件上传" className="fei-review">
        <h4>原文件上传响应尚未确认</h4><p>{state.upload.fileName} · 原文件 <code>{state.upload.checksumSha256}</code></p>
        <p>原请求编号 <code>{state.upload.idempotencyKey}</code> · 完整原字节和选项仅在当前页面保留 不换编号上传另一份文件</p>
        <p className="fei-hint">整页刷新不会保留未确认上传的字节和请求编号 请从本工厂已保存导入历史核对原文件 或按已知原导入 ID 读取 不声称已恢复原上传请求</p>
        <button className="oc-button primary" type="button" disabled={disabled || state.uploading} onClick={() => void upload(state.upload!)}>按原请求恢复上传</button>
        {state.uploadRejected && <button className="oc-button" type="button" onClick={() => patch({ upload: null, uploadRejected: false, error: "", fileDirty: false, reset: state.reset + 1 })}>原上传被明确拒绝 重新选择文件</button>}
      </section>}
      <form className="fei-search" aria-label="按原导入 ID 读取工厂文件" onSubmit={readById}>
        <label>工厂导入 ID<input name="importId" value={state.importDraft} disabled={disabled || locked || networkBusy} onChange={event => patch({ importDraft: event.target.value })} placeholder="输入完整原导入 ID" autoComplete="off" /></label>
        <button className="oc-button" type="submit" disabled={disabled || locked || networkBusy || !state.importDraft}><Search size={14} aria-hidden="true" />按导入 ID 读取</button>
      </form>
      {state.error && <p role="alert" className="oc-delivery-error">{state.error}</p>}
      {state.notice && <p role="status">{state.notice}</p>}
      {state.reading && <p role="status">正在核对来源保留凭据与所选原文件页</p>}
      {state.lifecycle && <>
        <FactoryErpLifecycleSummary value={state.lifecycle} expired={!sourceReadable(state.lifecycle.id)} />
        <div className="fei-actions">
          <button className="oc-button" type="button" disabled={disabled || state.reading || networkBusy} onClick={() => void readImport(state.lifecycle!.id, 0, false)}><RefreshCw size={14} aria-hidden="true" />重新读取清理状态</button>
          {sourceReadable(state.lifecycle.id) && !view && <button className="oc-button" type="button" disabled={disabled || state.reading || networkBusy} onClick={() => void readImport(state.lifecycle!.id)}>读取保留期内原文</button>}
        </div>
        <section className="fei-application-history" aria-label="原工厂状态应用历史">
          <h4>原工厂状态应用历史</h4><p>按所选原导入分页读取已登记应用 只读回执不依赖原文仍在保留期 不再次应用或重算今天的状态</p>
          <div className="fei-actions">
            <button className="oc-button" type="button" disabled={disabled || state.applicationsReading} onClick={() => void readApplications()}>重新读取原应用历史</button>
            <button className="oc-button" type="button" disabled={disabled || state.applicationsReading || state.applicationTrail.length < 2} onClick={() => {
              const trail = state.applicationTrail.slice(0, -1); void readApplications(trail.at(-1), trail);
            }}>上一页原应用历史</button>
            <button className="oc-button" type="button" disabled={disabled || state.applicationsReading || !state.applications?.nextCursor} onClick={() =>
              void readApplications(state.applications!.nextCursor!, [...state.applicationTrail, state.applications!.nextCursor!])}>下一页原应用历史</button>
          </div>
          {state.applicationsReading && <p role="status">正在读取原应用历史</p>}
          {state.applicationsError && <p role="alert" className="oc-delivery-error">{state.applicationsError}</p>}
          {state.applications && <><p>本页 {state.applications.items.length} 笔已登记应用{state.applications.nextCursor ? " 还有下一页" : " 本次查询已到末页"}</p>
            <ul className="fei-history">{state.applications.items.map(item => <li key={item.id}>
              <p>原应用 ID <code>{item.id}</code> · 已登记 {item.appliedRows} 个整组</p><p>应用登记时间 {item.createdAt}</p>
              <button className="oc-button" type="button" disabled={disabled || state.receiptReading} onClick={() => void readApplication(item.id)}>读取原应用回执 {item.id.slice(-8)}</button>
            </li>)}</ul>{!state.applications.items.length && <p>当前来源尚无已登记应用 不据此推断工厂未生产或未发货</p>}</>}
          <form className="fei-search" aria-label="按原应用 ID 读取回执" onSubmit={event => { event.preventDefault(); void readApplication(state.applicationDraft); }}>
            <label>原应用 ID<input name="applicationId" value={state.applicationDraft} disabled={disabled || state.receiptReading} autoComplete="off"
              placeholder="输入这份原导入的完整应用 ID" onChange={event => patch({ applicationDraft: event.target.value })} /></label>
            <button className="oc-button" type="submit" disabled={disabled || state.receiptReading || !state.applicationDraft}><Search size={14} aria-hidden="true" />读取原应用回执</button>
          </form>
          {state.lifecycle.lastApplicationId && <button className="oc-button" type="button" disabled={disabled || state.receiptReading} onClick={() => void readApplication(state.lifecycle!.lastApplicationId!)}>读取最近原应用回执</button>}
          {state.receiptReading && <p role="status">正在读取不可变原应用回执</p>}
          {state.receiptError && <p role="alert" className="oc-delivery-error">{state.receiptError}</p>}
          {state.historicalReceipt && <FactoryErpApplyReceipt value={state.historicalReceipt} historical page={state.historicalReceiptPage} onPage={page => patch({ historicalReceiptPage: page })} />}
          {(state.receiptReading || state.historicalReceipt) && <button className="oc-button" type="button" onClick={closeHistoricalReceipt}><X size={14} aria-hidden="true" />关闭原应用回执读取</button>}
        </section>
      </>}
      {view && <><FactoryErpImportSummary view={view} />
        {state.choiceChecksum !== null && state.choiceChecksum !== view.previewChecksum && <p role="alert" className="oc-delivery-error">当前预览依据已有变化 旧组选择未自动改绑 请明确清除后重新核对</p>}
        <nav className="fei-actions" aria-label="原工厂文件预览分页">
          <button className="oc-button" type="button" disabled={disabled || locked || networkBusy || state.reading || !!state.editing || !!state.correcting || view.offset === 0} onClick={() => void readImport(view.id, Math.max(0, view.offset - view.limit))}>上一页原表</button>
          <button className="oc-button" type="button" disabled={disabled || locked || networkBusy || state.reading || !!state.editing || !!state.correcting || view.offset + view.rows.length >= view.rowCount} onClick={() => void readImport(view.id, view.offset + view.limit)}>下一页原表</button>
          <button className="oc-button" type="button" disabled={disabled || locked || networkBusy || state.reading || !!state.editing || !!state.correcting} onClick={() => void readImport(view.id, view.offset)}><RefreshCw size={14} aria-hidden="true" />重新读取本页原表</button>
        </nav>
        <p className="fei-hint">原文件共 {view.rowCount} 行 本页只显示 {view.rows.length} 行 已确认组跨页保留 不把当前页说成全文件</p>
        <div className="fei-rows" key={view.id + ":" + view.offset}>{view.rows.map(row => {
          const selected = state.choices[row.rowNumber], blocked = !factoryErpKnownStatus(row.rawStatus) || row.diagnostics.length > 0;
          return <article className="fei-row" aria-label={"工厂原表第 " + row.rowNumber + " 行"} key={row.rowNumber}>
            <div className="fei-row-heading"><strong>第 {row.rowNumber} 行 · 编号 {row.externalId}</strong><span>{row.rawStatus} → {factoryErpStatusLabel(row.rawStatus)}</span></div>
            <p>原订单号 {row.orderReference || "原值为空"} · 商品种类 {row.itemKinds} · 商品总数 {row.itemQuantity}</p>
            <p>原更新时间 {row.updatedAtLocal || "原值为空"} · 未确认时区 不转换为 UTC</p>
            <p className="fei-hint">运单号 {row.trackingReference || "原值为空"} 仅保留原值 不据此判定已发货或揽收</p>
            <FactoryErpRawRow row={row} headers={view.headers} />
            {row.diagnostics.length > 0 && <p className="oc-delivery-error">本行不可应用 {row.diagnostics.map(item => item.code).join(" · ")}</p>}
            {selected && <><label className="fei-check"><input type="checkbox" checked={selected.included} disabled={disabled || locked || !canWrite}
              onChange={event => setModel(previous => previous.scope === scope ? redactExpired({ ...previous, choices: { ...previous.choices, [row.rowNumber]: { ...selected, included: event.target.checked } } }) : previous)} />
              已核对完整组 本次选择应用第 {row.rowNumber} 行</label>
              <p className="fei-hint">{selected.fromExisting ? "已明确复用原完整绑定" : "人工核对原计数合计 " + selected.quantity} · {selected.items.length} 个固定原交付项</p></>}
            {!selected && row.binding && <p className="fei-hint">该外部编号已有固定组 需要明确核对并选择复用 不自动应用</p>}
            {row.association && <p className="fei-hint">关联修订 {row.association.revision}{row.association.activeBindingId ? " 当前活动绑定 " : row.association.revision > 0 ? " 原组已解除 最近解除凭据 " : " 尚无原绑定 "}
              {(row.association.activeBindingId || row.association.releaseId) && <code>{row.association.activeBindingId ?? row.association.releaseId}</code>}
              {row.association.releaseId && " 重新绑定需要重新明确核对 不沿用解除前预览"}</p>}
            {!row.association && <p className="oc-delivery-error">当前关联修订依据未返回 请重新读取后再准备新应用</p>}
            {canWrite && <div className="fei-actions"><button className="oc-button" type="button" disabled={disabled || locked || !!state.receipt || blocked || !row.association || state.reading || !!state.correcting} onClick={() => {
              if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
              patch({ editing: row, correcting: null, closing: false, error: "" });
            }}>核对整组绑定 第 {row.rowNumber} 行</button>
              {row.binding && <button className="oc-button" type="button" disabled={disabled || locked || !!state.receipt || blocked || state.reading || !!state.editing || Object.keys(state.choices).length > 0}
                onClick={() => { if (closeTimer.current !== null) window.clearTimeout(closeTimer.current); patch({ correcting: row, editing: null, closing: false, error: "" }); }}>解除或更正原绑定 第 {row.rowNumber} 行</button>}
            </div>}
            <div className="fei-actions">
              {row.binding && <button className="oc-button" type="button" disabled={disabled || locked || networkBusy} onClick={() => patch({ voidFocus: { bindingId: row.binding!.id, nonce: (state.voidFocus?.nonce ?? 0) + 1 } })}>读取本行绑定作废观察 第 {row.rowNumber} 行</button>}
              {canWrite && <button className="oc-button" type="button" disabled={disabled || locked || networkBusy || blocked || state.reading || !!state.editing || !!state.correcting} onClick={() => {
                if (!sourceReadable(view.id)) return;
                patch({ voidSource: { source: { importId: view.id, fileChecksum: view.fileChecksum, previewChecksum: view.previewChecksum, rowNumber: row.rowNumber }, rawStatus: row.rawStatus },
                  notice: "已明确选择本行作为作废核对证据 尚未登记核对 不自动更改原绑定或状态" });
              }}>选作本次作废核对来源 第 {row.rowNumber} 行</button>}
            </div>
          </article>;
        })}</div>
        {state.editing && canWrite && <div className="fei-editor" data-closing={state.closing ? "true" : "false"} inert={state.closing} aria-disabled={state.closing}>
          <FactoryErpBindingForm key={scope + ":" + view.id + ":" + state.editing.rowNumber}
            scope={scope + ":" + view.id + ":" + state.editing.rowNumber} row={state.editing} headers={view.headers}
            disabled={disabled || locked || state.closing} loadCandidates={loadCandidates} onSave={chooseRow} onCancel={closeEditor} onDenied={readFailure} />
        </div>}
        {state.correcting?.binding && canWrite && <div className="fei-editor" data-closing={state.closing ? "true" : "false"} inert={state.closing} aria-disabled={state.closing}>
          <FactoryErpBindingCorrection key={scope + ":" + view.id + ":correction:" + state.correcting.rowNumber}
            scope={scope + ":" + view.id + ":correction:" + state.correcting.rowNumber} bindingId={state.correcting.binding.id}
            source={{ importId: view.id, fileChecksum: view.fileChecksum, previewChecksum: view.previewChecksum, rowNumber: state.correcting.rowNumber }}
            itemQuantity={state.correcting.itemQuantity} disabled={disabled || locked || state.closing} request={bindingRequest}
            loadCandidates={loadCandidates} onPrepare={prepareChange} onCancel={closeEditor} onDenied={readFailure} />
        </div>}
        {canWrite && !state.review && !state.receipt && <div className="fei-actions">
          <button className="oc-button primary" type="button" disabled={disabled || networkBusy || locked || state.reading || !!state.editing || !!state.correcting || selectionCount === 0 || state.choiceChecksum !== view.previewChecksum} onClick={prepare}>核对选中整组应用（{selectionCount}）</button>
          <button className="oc-button" type="button" disabled={disabled || locked || networkBusy || !Object.keys(state.choices).length} onClick={() => patch({ choices: {}, choiceChecksum: null, editing: null })}>明确清除全部组选择</button>
        </div>}
      </>}
      {state.review && <><FactoryErpApplySummary input={state.review.input} fileName={state.review.fileName} />
        <p>原导入 ID <code>{state.review.importId}</code> · 原请求仅保存编号 校验值 行号与固定绑定 不保存原文件或原表私人内容</p>
        {!view && <button className="oc-button" type="button" disabled={state.reading || state.applying} onClick={() => void readImport(state.review!.importId)}>另行读取原导入预览</button>}
        <p className="fei-hint">{state.review.sent ? "原请求已发出 结果未确认时只能按同一路径 正文和编号恢复 不重做预览或改绑" : "原请求已固定 尚未应用 请明确确认"}</p>
        {!sourceReadable(state.review.importId) && <p className="fei-hint">原文保留期已结束或尚未核对 不允许创建新应用 已发出原请求仅在服务器确认到期后按同正文和编号读取既存回执</p>}
        <div className="fei-actions"><button className="oc-button primary" type="button" disabled={disabled || state.applying ||
          !sourceReadable(state.review.importId) && !(state.review.sent && state.lifecycle?.id === state.review.importId && state.lifecycle.access === "expired")} onClick={() => void apply(state.review!)}>
          <Check size={14} aria-hidden="true" />{state.applying ? "正在核对原应用结果" : state.review.sent && state.lifecycle?.access === "expired" ? "按原请求读取已登记回执" : state.review.sent ? "重试原确认应用" : "确认应用原预览"}
        </button>
          {(!state.review.sent || state.applyRejected) && <button className="oc-button" type="button" disabled={state.applying} onClick={() => {
            if (state.review?.sent) removeRecovery(access.authority, factoryId, state.review.input);
            patch({ review: null, applyRejected: false, error: "" });
          }}><X size={14} aria-hidden="true" />{state.applyRejected ? "原请求被明确拒绝 返回核对" : "返回修改整组选择"}</button>}
        </div></>}
      {state.receipt && <><FactoryErpApplyReceipt value={state.receipt} page={state.receiptPage} onPage={page => patch({ receiptPage: page })} />
        <button className="oc-button primary" type="button" onClick={() => {
          if (state.receiptInput) removeRecovery(access.authority, factoryId, state.receiptInput);
          const currentId = state.receipt!.importId; patch({ receipt: null, receiptInput: null, notice: "原应用已登记 正在另行读取当前预览与交付状态" });
          onChanged(); void readImport(currentId, view?.offset ?? 0); void readRecent();
        }}>确认原应用回执并读取当前状态</button></>}
      {state.change && <><FactoryErpBindingChangeSummary value={state.change} />
        <p>原请求只保留编号 校验值 行号和明确组集合 不保留文件名 外部编号 运单或原表私人列值</p>
        {!sourceReadable(state.change.input.source.importId) && <p className="fei-hint">原文已到期或保留依据尚未核对 不创建新变更 服务器确认到期后 已发出同一原请求只允许恢复既存回执</p>}
        <div className="fei-actions"><button className="oc-button primary" type="button" disabled={disabled || state.changing ||
          !sourceReadable(state.change.input.source.importId) && !(state.change.sent && state.lifecycle?.id === state.change.input.source.importId && state.lifecycle.access === "expired")}
          onClick={() => void executeChange(state.change!)}><Check size={14} aria-hidden="true" />{state.changing ? "正在核对原绑定变更结果" :
            state.change.sent ? "按原请求恢复绑定变更结果" : state.change.input.action === "release" ? "确认仅解除原组关联" : "确认更正并应用本行到新组"}</button>
          {(!state.change.sent || state.changeRejected) && <button className="oc-button" type="button" disabled={state.changing} onClick={() => {
            if (state.change?.sent) removeChangeRecovery(access.authority, factoryId, state.change);
            patch({ change: null, changeRejected: false, error: "", notice: "原绑定变更未自动重做 请重新读取原表后明确核对" });
          }}><X size={14} aria-hidden="true" />{state.changeRejected ? "原变更被明确拒绝 返回核对" : "放弃未提交的固定变更"}</button>}
        </div></>}
      {state.changeReceipt && <><FactoryErpBindingChangeReceipt value={state.changeReceipt} />
        <button className="oc-button primary" type="button" onClick={() => {
          if (state.changeReceiptInput) removeChangeRecovery(access.authority, factoryId, state.changeReceiptInput);
          const id = state.changeReceipt!.source.importId;
          patch({ changeReceipt: null, changeReceiptInput: null, bindingHistoryVersion: state.bindingHistoryVersion + 1, notice: "原变更回执已确认 正在另行读取当前关联与交付状态" });
          onChanged(); void readImport(id, view?.offset ?? 0); void readRecent();
        }}>确认原绑定变更回执并读取当前状态</button></>}
      <FactoryErpBindingHistory key={scope + ":binding-history:" + state.bindingHistoryVersion} scope={scope} factoryId={factoryId}
        disabled={disabled || networkBusy || voidState.dirty} request={bindingRequest} onDenied={readFailure}
        onReviewVoids={id => patch({ voidFocus: { bindingId: id, nonce: (state.voidFocus?.nonce ?? 0) + 1 } })} />
      <FactoryErpVoidReviewWorkspace key={scope + ":void-review"} scope={scope} factoryId={factoryId} authority={access.authority!} canWrite={canWrite}
        disabled={disabled || rawBusy || rawLocked || !!state.editing || !!state.correcting || Object.keys(state.choices).length > 0}
        source={state.voidSource && sourceReadable(state.voidSource.source.importId) ? state.voidSource : null} focus={state.voidFocus}
        request={bindingRequest} submit={submitVoidReview} sourceReadable={sourceReadable} sourceExpired={voidSourceExpired}
        onReadSource={readVoidSource} onStateChange={setVoidState} onDenied={readFailure} onBindingCorrection={id => {
          const row = view?.rows.find(value => value.binding?.id === id);
          if (!row || !view || !sourceReadable(view.id)) { patch({ notice: "请先读取仍在保留期的同编号原表行 再核对该完整原组的解除或更正 目标绑定 " + id }); return; }
          if (locked || networkBusy || Object.keys(state.choices).length > 0) return;
          patch({ correcting: row, editing: null, closing: false, error: "", notice: "已打开准确原组解除或更正 核对结论不会替代真实变更凭据" });
        }} onChanged={() => {
          patch({ voidSource: null, bindingHistoryVersion: state.bindingHistoryVersion + 1 });
          onChanged(); if (state.lifecycle) void readImport(state.lifecycle.id, view?.offset ?? 0, !!view); void readRecent();
        }} />
      <details className="fei-details"><summary>读取本工厂已保存导入历史</summary>
        <p>这是按当前工厂分页读取的全部来源生命周期记录 包含已到期和已清理项 不含文件名 原行或外部编号 不是当前页生产候选的推断</p>
        {state.recentReading && <p role="status">正在读取来源保留与清理历史</p>}
        {state.recentError && <p role="alert" className="oc-delivery-error">{state.recentError}</p>}
        <div className="fei-actions"><button className="oc-button" type="button" disabled={state.recentReading} onClick={() => void readRecent()}>重新读取导入历史</button>
          <button className="oc-button" type="button" disabled={state.recentReading || state.recentTrail.length < 2} onClick={() => { const trail = state.recentTrail.slice(0, -1); void readRecent(trail.at(-1), trail); }}>上一页导入历史</button>
          <button className="oc-button" type="button" disabled={state.recentReading || !state.recent?.nextCursor} onClick={() => void readRecent(state.recent!.nextCursor!, [...state.recentTrail, state.recent!.nextCursor!])}>下一页导入历史</button></div>
        {state.recent && <><p>本页 {state.recent.items.length} 份原来源{state.recent.nextCursor ? " 还有下一页" : " 本次查询已到末页"}</p>
          <ul className="fei-history">{state.recent.items.map(item => <li key={item.id}><strong>{factoryErpLifecycleLabel(item, !sourceReadable(item.id))}</strong><p>原导入 <code>{item.id}</code> · 上传登记 {item.createdAt}</p>
            <p>保留截止 {item.expiresAt} · 服务器核验 {item.checkedAt}</p>
            <p>原字节 <code>{item.fileChecksum}</code></p><button className="oc-button" type="button" disabled={disabled || locked || networkBusy || !!state.editing || !!state.correcting} onClick={() => readOther(item.id)}>读取原导入 {item.id.slice(-8)}</button></li>)}</ul>
          {!state.recent.items.length && <p>本工厂尚无来源生命周期记录</p>}</>}
      </details>
    </>}
  </section>;
}
