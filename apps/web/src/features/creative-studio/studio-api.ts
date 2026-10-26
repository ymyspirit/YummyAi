"use client";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { ErpContextAuthoritySchema } from "@yummyai/contracts/auth/session";
import { ASSIST_INTENT_CLEAR_EVENT } from "@yummyai/contracts/ai/assist-recovery";
import { ConfigurationRpcSchema, ConfigurationSnapshotSchema, ModelCatalogueSchema } from "@yummyai/contracts/ai/model-configuration";
import { StudioRpcSchema, StudioScopeSchema, publicStudioModelSelectionError } from "@yummyai/contracts/pod/creative-studio";
import { publicStudioPaidImageError } from "@yummyai/contracts/pod/studio-paid-image";
import { CanvasBriefSchema, CanvasProjectSummarySchema } from "@yummyai/contracts/pod/canvas-bridge";
import { STUDIO_PERSONAL_CLEAR_EVENT, STUDIO_PERSONAL_MEDIA_LIMIT, STUDIO_PERSONAL_METADATA_LIMIT, STUDIO_PERSONAL_VERSION, StudioPersonalInvokeSchema, StudioWorkspaceSchema, parseStudioPersonalReply, type StudioWorkspace } from "@yummyai/contracts/pod/studio-personal";
import { useErpAccess } from "../identity/erp-access";

export class StudioApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) { super(message); }
}

/** A captured membership is a response fence, never authorization for an API owner. */
export type StudioRequestContext = {
  authority: string; ownerScope: string; localDevelopment: boolean;
  signal: AbortSignal; isCurrent: () => boolean;
};
export function captureStudioContext(identity: { authority: string | null; ownerScope: string | null; localDevelopment: boolean }, signal: AbortSignal, isCurrent: () => boolean): StudioRequestContext {
  if (!identity.authority || !identity.ownerScope && !identity.localDevelopment) throw contextChanged();
  if (!identity.localDevelopment) {
    if (!ErpContextAuthoritySchema.safeParse(identity.authority).success) throw contextChanged();
    const principal = JSON.parse(identity.authority) as { tenantId: string; userId: string };
    if (identity.ownerScope !== `${principal.tenantId}:${principal.userId}`) throw contextChanged();
  }
  const context = { authority: identity.authority, ownerScope: identity.ownerScope ?? "local-development", localDevelopment: identity.localDevelopment, signal, isCurrent };
  assertStudioCurrent(context);
  return context;
}
export function assertStudioCurrent(context: StudioRequestContext) {
  context.signal.throwIfAborted();
  if (!context.isCurrent()) throw contextChanged();
}
function contextChanged() { return new StudioApiError("当前本人或创作范围已变化 旧内容未采用", 409, "authority_changed"); }

/** Shared by the retained editor, configuration and the original production readers. */
export function useStudioAccessFence(scope = "unassigned") {
  const access = useErpAccess();
  const key = JSON.stringify([access.preferenceScope, access.authority, access.localDevelopment, scope]);
  const currentKey = useRef(key), controller = useRef(new AbortController()), alive = useRef(false), cleared = useRef<string | null>(null);
  currentKey.current = key;
  const [clearedKey, setClearedKey] = useState<string | null>(null);
  const invalidate = useCallback(() => { controller.current.abort(); controller.current = new AbortController(); }, []);
  useLayoutEffect(() => {
    alive.current = true;
    if (controller.current.signal.aborted) controller.current = new AbortController();
    const clear = () => { cleared.current = key; controller.current.abort(); setClearedKey(key); };
    window.addEventListener(ASSIST_INTENT_CLEAR_EVENT, clear);
    window.addEventListener(STUDIO_PERSONAL_CLEAR_EVENT, clear);
    return () => { alive.current = false; controller.current.abort(); window.removeEventListener(ASSIST_INTENT_CLEAR_EVENT, clear); window.removeEventListener(STUDIO_PERSONAL_CLEAR_EVENT, clear); };
  }, [key]);
  const available = !!access.authority && (!!access.preferenceScope || access.localDevelopment) && clearedKey !== key;
  const capture = useCallback((signal?: AbortSignal) => {
    const lifecycle = controller.current;
    const isCurrent = () => alive.current && currentKey.current === key && cleared.current !== key && controller.current === lifecycle;
    return captureStudioContext({ authority: access.authority, ownerScope: access.preferenceScope, localDevelopment: access.localDevelopment }, signal ? AbortSignal.any([lifecycle.signal, signal]) : lifecycle.signal, isCurrent);
  }, [key, access.authority, access.preferenceScope, access.localDevelopment]);
  return { ...access, key, available, capture, invalidate };
}

export function studioReadDenied(cause: unknown) {
  return cause instanceof StudioApiError && ([401, 403].includes(cause.status) || cause.status === 409 && cause.code === "authority_changed");
}
export function studioScopeUnavailable(cause: unknown) {
  return studioReadDenied(cause) || cause instanceof StudioApiError && cause.status === 404;
}

const messages: Record<number, string> = { 400: "请求格式无效 请核对输入", 401: "ERP 登录已失效", 403: "当前本人没有此项创作权限", 404: "当前创作记录不存在或不可访问", 409: "原记录已变化 请先读取原记录再核对 未自动重复保存", 413: "单个素材不能超过 20 MiB", 415: "请求格式不受支持", 422: "素材未通过安全检查", 503: "ERP 创作服务尚未就绪" };
async function boundedJson(response: Response, limit: number, context?: StudioRequestContext): Promise<unknown> {
  if (Number(response.headers.get("content-length")) > limit || !response.headers.get("content-type")?.toLowerCase().startsWith("application/json")) throw new StudioApiError("ERP 返回的内容无法读取", 502);
  const reader = response.body?.getReader();
  if (!reader) throw new StudioApiError("ERP 返回的内容无法读取", 502);
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      if (context) assertStudioCurrent(context);
      const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength;
      if (size > limit) { await reader.cancel(); throw new StudioApiError("ERP 返回的内容超过读取上限", 502); }
      chunks.push(part.value);
    }
    if (context) assertStudioCurrent(context);
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (cause) {
    if (cause instanceof StudioApiError || context?.signal.aborted) throw cause;
    throw new StudioApiError("ERP 返回的内容无法读取", 502);
  } finally { reader.releaseLock(); }
}
async function request(url: string, value: unknown, method: string, signal?: AbortSignal, context?: StudioRequestContext, limit = STUDIO_PERSONAL_METADATA_LIMIT): Promise<unknown> {
  if (context) assertStudioCurrent(context);
  const headers: Record<string, string> = {};
  if (value !== undefined) headers["content-type"] = "application/json";
  if (context && !context.localDevelopment) headers["x-yummyai-context-authority"] = context.authority;
  const signals = [signal, context?.signal, AbortSignal.timeout(30_000)].filter((item): item is AbortSignal => !!item);
  const response = await fetch(url, { method, signal: AbortSignal.any(signals), credentials: "same-origin", cache: "no-store", headers, body: value === undefined ? undefined : JSON.stringify(value) });
  const successful = response.status === 200 || method === "POST" && response.status === 201;
  let result: unknown;
  try { result = await boundedJson(response, successful ? limit : 8 * 1024, context); }
  catch (cause) {
    if (context) assertStudioCurrent(context);
    if (!successful) throw new StudioApiError(messages[response.status] ?? "连接 ERP 失败 当前结果尚未核对", response.status);
    throw cause;
  }
  if (context) assertStudioCurrent(context);
  if (!successful) {
    const errorCode = result && typeof result === "object" && "code" in result ? result.code : undefined;
    const selectionError = publicStudioModelSelectionError(errorCode, response.status) ?? publicStudioPaidImageError(errorCode, response.status);
    if (selectionError) throw new StudioApiError(selectionError.message, response.status, selectionError.code);
    const code = result && typeof result === "object" && "code" in result && typeof result.code === "string" && ["authority_changed", "studio_video_directory_changed", "studio_video_directory_too_large", "studio_video_directory_unavailable"].includes(result.code) ? result.code : undefined;
    if (code === "authority_changed") throw contextChanged();
    const videoMessages: Record<string, string> = { studio_video_directory_changed: "视频历史或原任务已变化 请重新读取完整目录后再打开", studio_video_directory_too_large: "视频历史超过完整读取上限 工具未打开 请联系管理员处理 原记录保持", studio_video_directory_unavailable: "当前服务尚未提供完整视频历史检查 视频工具未打开" };
    if (code) throw new StudioApiError(videoMessages[code]!, response.status, code);
    throw new StudioApiError(messages[response.status] ?? "连接 ERP 失败 当前结果尚未核对", response.status);
  }
  if (context && !context.localDevelopment && response.headers.get("x-yummyai-context-authority") !== context.authority) throw contextChanged();
  return result;
}
function parsed<T>(read: () => T): T { try { return read(); } catch (cause) { if (cause instanceof StudioApiError) throw cause; throw new StudioApiError("ERP 返回的创作记录未通过核对", 502); } }
export async function studioWorkspace(scope: string, context: StudioRequestContext, signal?: AbortSignal): Promise<StudioWorkspace> {
  assertStudioCurrent(context);
  const selected = parsed(() => StudioScopeSchema.parse(scope));
  const raw = await request(`/api/creative-studio/workspace?${new URLSearchParams({ scope: selected })}`, undefined, "GET", signal, context);
  const value = parsed(() => StudioWorkspaceSchema.parse(raw));
  if (value.scope !== selected || value.contextAuthority !== context.authority) throw contextChanged();
  assertStudioCurrent(context); return value;
}
export async function studioApi<T>(path: string, value: unknown, method: string, signal: AbortSignal | undefined, context: StudioRequestContext): Promise<T> {
  if (!context) throw contextChanged();
  if (path !== "configuration" || method !== "POST") throw new StudioApiError("配置请求不受支持", 400);
  const input = parsed(() => ConfigurationRpcSchema.parse(value));
  const result = await request("/api/creative-studio/configuration", input, method, signal, context);
  const output = parsed(() => input.operation === "channel.discover" ? ModelCatalogueSchema.parse(result) : ConfigurationSnapshotSchema.parse(result));
  assertStudioCurrent(context); return output as T;
}
export async function studioRpc<T>(scope: string, input: Record<string, unknown>, signal: AbortSignal | undefined, context: StudioRequestContext): Promise<T> {
  if (!context) throw contextChanged();
  const rpc = parsed(() => StudioRpcSchema.parse({ ...input, scope }));
  if (!context.localDevelopment && rpc.operation === "generate") throw new StudioApiError("真实付费生成暂未启用 已保存的创作与原任务仍可读取", 409, "operator_paused");
  const personal = !context.localDevelopment;
  const body = personal ? parsed(() => StudioPersonalInvokeSchema.parse({ version: STUDIO_PERSONAL_VERSION, contextAuthority: context.authority, request: rpc })) : rpc;
  const raw = await request(`/api/creative-studio/${personal ? "invoke" : "rpc"}`, body, "POST", signal, context, STUDIO_PERSONAL_MEDIA_LIMIT);
  const result = personal ? parsed(() => parseStudioPersonalReply(raw, rpc, context.authority)).data : raw;
  assertStudioCurrent(context); return result as T;
}
export async function studioProject<T>(path: string, signal: AbortSignal | undefined, context: StudioRequestContext): Promise<T> {
  if (!context) throw contextChanged();
  const match = /^briefs\/([0-9a-f-]+)$/i.exec(path);
  if (path !== "projects" && !(context.localDevelopment && path === "briefs") && (!match || !StudioScopeSchema.safeParse(match[1]).success || match[1] === "unassigned")) throw new StudioApiError("创作项目路径不受支持", 400);
  const raw = await request(`/api/canvas-bridge/${path}`, undefined, "GET", signal, context);
  const result = parsed(() => path === "projects" || path === "briefs" ? CanvasProjectSummarySchema.array().max(200).parse(raw) : CanvasBriefSchema.parse(raw));
  assertStudioCurrent(context);
  if (match && result && typeof result === "object" && "id" in result && typeof result.id === "string" && result.id.toLowerCase() !== match[1]?.toLowerCase()) throw contextChanged();
  return result as T;
}

export const studioReadOperations = new Set(["state.get", "state.keys", "models", "pillow-runtime", "assets", "asset.preview", "generations", "video.directory", "video.preflight"]);
export function transientStudioError(cause: unknown) {
  return cause instanceof StudioApiError ? [408, 429, 500, 502, 503, 504].includes(cause.status)
    : cause instanceof TypeError || cause instanceof Error && cause.name === "TimeoutError";
}

/** Only use for reads. Keep hydration pending until the existing record can be read. */
export async function recoverStudioRead<T>(read: (signal: AbortSignal) => Promise<T>, options: { signal: AbortSignal; onRetry: (cause: unknown) => void }): Promise<T> {
  let attempt = 0;
  for (;;) {
    options.signal.throwIfAborted();
    try { return await read(AbortSignal.any([options.signal, AbortSignal.timeout(20_000)])); }
    catch (cause) {
      options.signal.throwIfAborted();
      if (!transientStudioError(cause)) throw cause;
      options.onRetry(cause);
      await waitForRecovery(Math.min(1000 * 2 ** Math.min(attempt++, 4), 15_000), options.signal);
    }
  }
}

function waitForRecovery(delay: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); if (typeof window !== "undefined") { window.removeEventListener("online", resume); window.removeEventListener("focus", resume); } };
    const resume = () => { cleanup(); resolve(); };
    const abort = () => { cleanup(); reject(signal.reason); };
    const timer = setTimeout(resume, delay);
    signal.addEventListener("abort", abort, { once: true });
    if (typeof window !== "undefined") { window.addEventListener("online", resume); window.addEventListener("focus", resume); }
    if (signal.aborted) abort();
  });
}
export type StudioAsset = { key: string; namespace: string; assetId: string; fileName: string; mediaType: string; rightsStatus: string; aiGenerated: boolean };
export type StudioJob = { id: string; status: string; input: { prompt: string }; model: { model: string; capability: string }; createdAt: string; error: string | null };
