"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { BenchmarkCommandReceiptSchema, BenchmarkReceiptSchema, BENCHMARK_OPERATIONS, benchmarkCommandCanonical,
  BusinessBenchmarkBasisRequestSchema, StartBenchmarkAttemptSchema,
  type BenchmarkOperation, type BusinessBenchmarkCase } from "@yummyai/contracts/knowledge/benchmark";
import { AssistTaskBasisSchema, type AssistTaskInput } from "@yummyai/contracts/ai/task-workspace";
import { governanceApi, knowledgeReadDenied, KnowledgeRequestError } from "./knowledge-api";

export type BusinessBenchmarkRole = z.infer<typeof BusinessBenchmarkBasisRequestSchema>["kind"];
export type BusinessBenchmarkTask = Extract<BusinessBenchmarkCase["task"], { kind: BusinessBenchmarkRole }>;
export type BenchmarkScope = { authority: string; canManage: boolean; canRun: boolean; canApprove: boolean;
  businessRoles?: readonly BusinessBenchmarkRole[]; current(): boolean; deny(): void };
export const benchmarkIntentPrefix = "yummyai.knowledge-benchmark.intent.v1:";
export const benchmarkIntentEvent = "yummyai-benchmark-intents";
const Id = z.uuidv7().transform(value => value.toLowerCase());
const MarkerSchema = z.object({ version: z.literal(1), authority: z.string().min(1).max(65_536), operation: z.enum(BENCHMARK_OPERATIONS),
  parentId: Id.nullable(), requestId: z.uuid(), requestChecksum: z.string().regex(/^[a-f0-9]{64}$/), receiptId: Id.nullable(),
  attemptInput: StartBenchmarkAttemptSchema.optional() }).strict().superRefine((value, context) => {
    if (value.attemptInput && (value.operation !== "attempt.start" || value.attemptInput.requestId !== value.requestId)) context.addIssue({ code: "custom", message: "原纯 ID 意图不一致" });
  });
export type BenchmarkIntent = z.infer<typeof MarkerSchema>;
type Receipt = z.infer<typeof BenchmarkReceiptSchema>;
type Frozen = { path: string; input: { requestId: string } & Record<string, unknown>; requestId: string; marker: BenchmarkIntent };
export function benchmarkError(error: unknown) { return error instanceof KnowledgeRequestError ? error.message : "完整记录或填写无法核对 请保留原编号后重新读取 未补造数据"; }
export function localBenchmarkTime(value: string) { const date = new Date(value), pad = (number: number, size = 2) => String(number).padStart(size, "0");
  if (!Number.isFinite(date.getTime())) return "";
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`; }
export function benchmarkInstant(value: string) { if (!value) throw new Error("time"); return new Date(value).toISOString(); }
export function benchmarkTaskTarget(task: AssistTaskInput) {
  switch (task.kind) {
    case "procurement_review": return `${task.stockItemId}:${task.locationId}`;
    case "business_review": return task.runId;
    case "creative": return task.projectId ?? null;
    case "order_review": case "artwork_preflight": return task.orderLineId;
    case "template_config": return task.inspectionId;
    case "sku_package": return task.listingId;
    case "after_sales_review": return task.caseId;
    default: return null;
  }
}
export function benchmarkTaskScope(task: AssistTaskInput) {
  switch (task.kind) {
    case "procurement_review": return `procurement:${task.stockItemId}:${task.locationId}`;
    case "business_review": return `finance:${task.runId}`;
    case "creative": return `creative:${task.scopeId}`;
    case "order_review": case "artwork_preflight": return `order:${task.orderLineId}`;
    case "template_config": return `template:${task.inspectionId}`;
    case "sku_package": return `listing:${task.listingId}`;
    case "after_sales_review": return `case:${task.caseId}`;
    default: return null;
  }
}
/** Business preview is a cancellable read, not an original mutation or paid start. */
export async function readBenchmarkTaskBasis(input: z.input<typeof BusinessBenchmarkBasisRequestSchema>, scope: BenchmarkScope, signal: AbortSignal) {
  const selection = BusinessBenchmarkBasisRequestSchema.parse(input);
  if (!scope.current() || signal.aborted) return null;
  if (!scope.canManage || !scope.canRun || !scope.businessRoles?.includes(selection.kind))
    throw new KnowledgeRequestError(403, "读取新业务依据需当前评测管理 运行及此角色的资料与运行权限");
  let response: Response;
  try {
    response = await fetch("/api/knowledge-governance/benchmarks/task-basis", {
      method: "POST", cache: "no-store", credentials: "same-origin",
      headers: { "content-type": "application/json", "x-yummyai-context-authority": scope.authority },
      body: JSON.stringify(selection), signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new KnowledgeRequestError(0, "业务依据读取未完成 本次未运行模型或登记固定样本 请重新读取");
  }
  const reader = response.body?.getReader(); if (!reader) throw new KnowledgeRequestError(502, "完整业务依据无法核对");
  const chunks: Uint8Array[] = []; let size = 0, raw: unknown = null;
  try {
    for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength;
      if (size > (response.ok ? 8 * 1024 * 1024 : 8192)) { await reader.cancel(); throw new KnowledgeRequestError(502, "完整业务依据超过读取限制 未采用截断内容"); }
      chunks.push(part.value); }
    const bytes = new Uint8Array(size); let offset = 0;
    chunks.forEach(chunk => { bytes.set(chunk, offset); offset += chunk.byteLength; });
    try { raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    catch { if (response.ok) throw new KnowledgeRequestError(502, "完整业务依据无法核对 未采用替代数据"); }
  } finally { reader.releaseLock(); }
  if (!scope.current() || signal.aborted) return null;
  if (!response.ok) {
    const code = raw && typeof raw === "object" && "code" in raw && raw.code === "authority_changed" ? "authority_changed" : null;
    throw new KnowledgeRequestError(response.status, code ? "当前身份或业务范围已变化 私有依据已隐藏"
      : [401, 403, 404].includes(response.status) ? "当前本人或业务对象读取权限不可核对 私有依据已隐藏" : "业务依据暂时不可读取 请核对真实对象与原版本后重读", code);
  }
  if (response.status !== 200) throw new KnowledgeRequestError(502, "业务依据的读取状态无法核对 未采用替代结果");
  if (response.headers.get("x-yummyai-context-authority") !== scope.authority)
    throw new KnowledgeRequestError(409, "当前身份或业务范围已变化 私有依据已隐藏", "authority_changed");
  const value = AssistTaskBasisSchema.parse(raw), task = value.input;
  if (task.kind !== selection.kind || task.expectedTaskFingerprint !== value.fingerprint || benchmarkTaskTarget(task) !== selection.targetId.toLowerCase() ||
    (task.taskGoal ?? "") !== selection.taskGoal || value.scope !== benchmarkTaskScope(task))
    throw new KnowledgeRequestError(502, "返回依据与原角色 对象或任务指纹不一致 未采用");
  return value;
}
export function useBenchmarkDismiss(scope: BenchmarkScope, onClose: () => void) {
  const [closing, setClosing] = useState(false), timer = useRef<number | null>(null), active = useRef(true), started = useRef(false), latest = useRef(onClose); latest.current = onClose;
  useEffect(() => { active.current = true; return () => { active.current = false; if (timer.current !== null) window.clearTimeout(timer.current); }; }, []);
  const dismiss = (after?: () => void) => {
    if (started.current || !scope.current()) return; started.current = true;
    const finish = () => { if (active.current && scope.current()) (after ?? latest.current)(); };
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) finish();
    else { setClosing(true); timer.current = window.setTimeout(finish, 150); }
  };
  return { closing, dismiss };
}
const storageKey = (value: Pick<BenchmarkIntent, "authority" | "requestId">) => benchmarkIntentPrefix + value.authority + ":" + value.requestId;
const changed = () => window.dispatchEvent(new Event(benchmarkIntentEvent));
export function readBenchmarkIntents(authority: string) {
  const result: BenchmarkIntent[] = [];
  try { for (let index = sessionStorage.length - 1; index >= 0; index--) {
    const name = sessionStorage.key(index); if (!name?.startsWith(benchmarkIntentPrefix)) continue;
    let raw: unknown; try { const text = sessionStorage.getItem(name); raw = text && text.length <= 128 * 1024 ? JSON.parse(text) : null; } catch { sessionStorage.removeItem(name); continue; }
    const parsed = MarkerSchema.safeParse(raw);
    if (!parsed.success || parsed.data.authority !== authority || storageKey(parsed.data) !== name) { sessionStorage.removeItem(name); continue; }
    result.push(parsed.data);
  } } catch { /* No private body is persisted as a fallback. */ }
  return result;
}
export function clearBenchmarkIntents() { try { for (let index = sessionStorage.length - 1; index >= 0; index--) { const key = sessionStorage.key(index); if (key?.startsWith(benchmarkIntentPrefix)) sessionStorage.removeItem(key); } } catch { /* Current private UI also unmounts. */ } }
function saveMarker(value: BenchmarkIntent) {
  const marker = MarkerSchema.parse(value), text = JSON.stringify(marker); sessionStorage.setItem(storageKey(marker), text);
  if (sessionStorage.getItem(storageKey(marker)) !== text) throw new KnowledgeRequestError(0, "原请求标识未能保存 本次未发送"); changed(); return marker;
}
export function forgetBenchmarkIntent(value: BenchmarkIntent) {
  sessionStorage.removeItem(storageKey(value));
  if (sessionStorage.getItem(storageKey(value)) !== null) throw new KnowledgeRequestError(0, "原回执已登记 恢复标识尚未清除 请保留原编号");
  changed();
}
export async function readBenchmarkReceipt(value: BenchmarkIntent, scope: BenchmarkScope, signal?: AbortSignal) {
  const result = BenchmarkCommandReceiptSchema.parse(await governanceApi("benchmarks/requests/" + value.requestId, undefined, signal, scope.authority));
  if (!scope.current()) return null;
  if (result.requestId !== value.requestId || result.operation !== value.operation || result.parentId !== value.parentId || result.requestChecksum !== value.requestChecksum || value.receiptId && value.receiptId !== result.receipt.id)
    throw new KnowledgeRequestError(502, "原请求的操作 父对象或校验值不一致 未采用另一笔回执");
  saveMarker({ ...value, receiptId: result.receipt.id }); return result;
}

export function useBenchmarkRead<T>(path: string | null, schema: z.ZodType<T>, scope: BenchmarkScope, expectedId?: string, revision = 0) {
  const [tick, setTick] = useState(0), [snapshot, setSnapshot] = useState<{ stamp: string; data: T | null; error: string; reading: boolean } | null>(null);
  const sequence = useRef(0), active = useRef<string | null>(path); active.current = path;
  const stamp = `${path ?? ""}:${revision}:${tick}`;
  useEffect(() => {
    const controller = new AbortController(), token = ++sequence.current;
    const valid = () => !controller.signal.aborted && sequence.current === token && active.current === path && scope.current();
    if (!path || !scope.current()) return () => controller.abort();
    if (expectedId && !Id.safeParse(expectedId).success) { setSnapshot({ stamp, data: null, error: "请填写完整有效的原记录 ID", reading: false }); return () => controller.abort(); }
    setSnapshot({ stamp, data: null, error: "", reading: true });
    governanceApi("benchmarks/" + path, undefined, controller.signal, scope.authority).then(raw => {
      if (!valid()) return;
      const parsed = schema.safeParse(raw); if (!parsed.success) throw new KnowledgeRequestError(502, "完整原记录无法核对 未截断或采用替代数据");
      if (expectedId && parsed.data && typeof parsed.data === "object") {
        const id = "id" in parsed.data ? parsed.data.id : "experimentId" in parsed.data ? parsed.data.experimentId : undefined;
        if (id !== undefined && id !== expectedId.toLowerCase()) throw new KnowledgeRequestError(502, "返回记录不是所选原 ID");
      }
      if (valid()) setSnapshot({ stamp, data: parsed.data, error: "", reading: false });
    }).catch(error => { if (valid()) { if (knowledgeReadDenied(error)) scope.deny(); else setSnapshot({ stamp, data: null, error: benchmarkError(error), reading: false }); } });
    return () => { controller.abort(); sequence.current++; };
  }, [path, schema, scope, expectedId, revision, tick, stamp]);
  const current = scope.current() && snapshot?.stamp === stamp ? snapshot : null;
  return { data: current?.data ?? null, error: current?.error ?? "", reading: Boolean(path && (!current || current.reading)), reload: useCallback(() => setTick(value => value + 1), []) };
}
type Page = { items: unknown[]; total: number; nextCursor: string | null };
export function useBenchmarkPage<T extends Page>(path: string | null, schema: z.ZodType<T>, scope: BenchmarkScope) {
  const [position, setPosition] = useState<{ path: string | null; trail: Array<string | undefined> }>({ path, trail: [undefined] });
  const trail = position.path === path ? position.trail : [undefined], cursor = trail.at(-1);
  const read = useBenchmarkRead(path ? path + (path.includes("?") ? "&" : "?") + new URLSearchParams({ limit: "20", ...(cursor ? { cursor } : {}) }) : null, schema, scope);
  const reset = useCallback(() => { setPosition({ path, trail: [undefined] }); read.reload(); }, [path, read.reload]);
  return { ...read, canPrevious: trail.length > 1, reset,
    previous: () => setPosition({ path, trail: trail.length > 1 ? trail.slice(0, -1) : [undefined] }),
    next: () => { if (read.data?.nextCursor) setPosition({ path, trail: [...trail, read.data.nextCursor] }); } };
}
function operationFor(path: string): { operation: BenchmarkOperation; parentId: string | null } {
  if (path === "datasets") return { operation: "dataset.create", parentId: null };
  if (path === "experiments") return { operation: "experiment.create", parentId: null };
  const parts = path.split("/"), parentId = Id.parse(parts[1]);
  if (parts[0] === "datasets" && parts[2] === "save") return { operation: "dataset.save", parentId };
  if (parts[0] === "datasets" && parts[2] === "publish") return { operation: "dataset.publish", parentId };
  if (parts[0] === "attempts" && parts[2] === "review") return { operation: "attempt.review", parentId };
  if (parts[0] === "experiments" && parts[2] === "attempts" && parts[3] === "start") return { operation: "attempt.start", parentId };
  if (parts[0] === "experiments" && parts[2] === "expenses") return { operation: "expense.record", parentId };
  if (parts[0] === "experiments" && parts[2] === "reports") return { operation: "report.create", parentId };
  throw new KnowledgeRequestError(400, "不支持的原操作入口");
}
function permitted(scope: BenchmarkScope, operation: BenchmarkOperation) {
  if (operation === "dataset.create" || operation === "dataset.save") return scope.canManage;
  if (operation === "dataset.publish") return scope.canManage && scope.canRun && scope.canApprove;
  if (operation === "experiment.create" || operation === "attempt.start") return scope.canManage && scope.canRun;
  return scope.canApprove;
}
export async function benchmarkRequestChecksum(operation: BenchmarkOperation, parentId: string | null, input: unknown) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(benchmarkCommandCanonical(operation, parentId, input)));
  return Array.from(new Uint8Array(bytes), value => value.toString(16).padStart(2, "0")).join("");
}
export function useBenchmarkMutation(scope: BenchmarkScope) {
  const [frozen, setFrozen] = useState<Frozen | null>(null), [receipt, setReceipt] = useState<Receipt | null>(null), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const lock = useRef(false), alive = useRef(true), original = useRef<Frozen | null>(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; original.current = null; }; }, []);
  const valid = () => alive.current && scope.current();
  async function execute(value: Frozen) {
    try {
      const result = BenchmarkReceiptSchema.parse(await governanceApi("benchmarks/" + value.path, value.input, undefined, scope.authority));
      if (!valid()) return;
      if (!permitted(scope, value.marker.operation)) { scope.deny(); return; }
      setReceipt(result); setError("");
      try { saveMarker({ ...value.marker, receiptId: result.id }); } catch { setError("原操作已经登记 本页保留实际 ID 请先记录编号后读取 不再提交"); }
    } catch (failure) { if (valid()) { if (knowledgeReadDenied(failure)) scope.deny(); else setError(benchmarkError(failure)); } }
    finally { lock.current = false; if (valid()) setBusy(false); }
  }
  async function submit(path: string, input: { requestId: string } & Record<string, unknown>) {
    if (lock.current || original.current || receipt || !valid()) return;
    lock.current = true; setBusy(true); setError("");
    try {
      const identity = operationFor(path);
      if (!permitted(scope, identity.operation)) { scope.deny(); return; }
      const prior = readBenchmarkIntents(scope.authority).find(item => item.operation === identity.operation && item.parentId === identity.parentId);
      if (prior) throw new KnowledgeRequestError(409, "此操作仍有原请求待核对 请先在原请求恢复区读取 不以新编号重复登记");
      const requestChecksum = await benchmarkRequestChecksum(identity.operation, identity.parentId, input);
      if (!valid()) return;
      const marker = saveMarker({ version: 1, authority: scope.authority, ...identity, requestId: input.requestId, requestChecksum, receiptId: null,
        ...(identity.operation === "attempt.start" ? { attemptInput: StartBenchmarkAttemptSchema.parse(input) } : {}) });
      const value = { path, input: structuredClone(input), requestId: input.requestId, marker }; original.current = value; setFrozen(value);
      await execute(value);
    } catch (failure) { if (valid()) setError(benchmarkError(failure)); }
    finally { lock.current = false; if (valid()) setBusy(false); }
  }
  async function retry() { if (lock.current || receipt || !original.current || !valid()) return; lock.current = true; setBusy(true); setError(""); await execute(original.current); }
  async function restore(marker: BenchmarkIntent) {
    if (!marker.attemptInput || marker.operation !== "attempt.start" || !marker.parentId || marker.authority !== scope.authority || lock.current || original.current || receipt || !valid()) return;
    lock.current = true; setBusy(true); setError("");
    try {
      if (!permitted(scope, marker.operation)) { scope.deny(); return; }
      const checksum = await benchmarkRequestChecksum(marker.operation, marker.parentId, marker.attemptInput);
      if (!valid() || checksum !== marker.requestChecksum) { if (valid()) setError("原纯 ID 请求校验值不一致 未重建或发送"); return; }
      const value: Frozen = { path: "experiments/" + marker.parentId + "/attempts/start", input: marker.attemptInput, requestId: marker.requestId, marker };
      original.current = value; setFrozen(value); await execute(value);
    } catch (failure) { if (valid()) setError(benchmarkError(failure)); }
    finally { lock.current = false; if (valid()) setBusy(false); }
  }
  return { frozen, receipt, error, busy, locked: busy || frozen !== null || receipt !== null, submit, retry, restore,
    invalid: (message: string) => { if (valid() && !original.current) setError(message); },
    clear: () => {
      if (lock.current || !valid()) return false;
      try { if (original.current) forgetBenchmarkIntent(original.current.marker); }
      catch { setError("原操作已登记 恢复标识尚未清除 请保留原编号后重试确认 不再提交"); return false; }
      original.current = null; setFrozen(null); setReceipt(null); setError(""); return true;
    } };
}
export type BenchmarkMutation = ReturnType<typeof useBenchmarkMutation>;
