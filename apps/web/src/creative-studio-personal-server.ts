import { authorize, ForbiddenError } from "@yummyai/authz/authorize";
import type { Permission as PermissionValue } from "@yummyai/authz/permissions";
import { erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { publicStudioModelSelectionError } from "@yummyai/contracts/pod/creative-studio";
import { apiFetch } from "./server-api";
import { PersonalSessionError } from "./identity/core";
import { assertErpIdentityCurrent, erpAuthFailure, erpRequestIdentity, type ErpRequestIdentity } from "./erp-auth/server";

export const studioPersonalHeaders = { "cache-control": "private, no-store", "x-content-type-options": "nosniff" };
class StudioBodyError extends Error { constructor(readonly status: number) { super("STUDIO_BODY_REJECTED"); } }
export async function readStudioJson(source: Request | Response, limit: number): Promise<unknown> {
  if (Number(source.headers.get("content-length")) > limit) { await source.body?.cancel(); throw new StudioBodyError(413); }
  if (source.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    await source.body?.cancel(); throw new StudioBodyError(415);
  }
  const reader = source.body?.getReader();
  if (!reader) throw new StudioBodyError(400);
  const timeout = AbortSignal.timeout(30_000);
  const signal = source instanceof Request ? AbortSignal.any([source.signal, timeout]) : timeout;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    if (signal.aborted) throw new StudioBodyError(408);
    for (;;) {
      const next = await reader.read();
      if (signal.aborted) throw new StudioBodyError(408);
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > limit) throw new StudioBodyError(413);
      chunks.push(next.value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { throw new StudioBodyError(400); }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { signal.removeEventListener("abort", abort); reader.releaseLock(); }
}
export async function requireStudioPersonalIdentity(request: Request, required: readonly PermissionValue[]) {
  try {
    const identity = await erpRequestIdentity(request);
    if (request.headers.get("x-yummyai-context-authority") !== erpSessionAuthority(identity.view))
      throw new PersonalSessionError(409, "authority_changed");
    for (const permission of required) authorize(identity.view, permission);
    return identity;
  } catch (error) { await request.body?.cancel().catch(() => {}); throw error; }
}
export async function studioPersonalCall(request: Request, identity: ErpRequestIdentity,
  target: string, init: RequestInit, schema: { parse(value: unknown): unknown }, limit: number) {
  // A slow browser upload must not retain the earlier membership ceiling.
  await assertErpIdentityCurrent(identity);
  const base = identity.service.configuration.apiBase.replace(/\/$/, "");
  const headers = new Headers(init.headers);
  headers.set("x-yummyai-context-authority", erpSessionAuthority(identity.view));
  const upstream = await apiFetch(`${base}/v1/${target}`, { ...init, headers, cache: "no-store", redirect: "error",
    signal: AbortSignal.any([request.signal, AbortSignal.timeout(100_000)]) });
  if (!upstream.ok) {
    let payload: unknown;
    try { payload = await readStudioJson(upstream, 8192); } catch { /* Raw diagnostics never cross the BFF. */ }
    await assertErpIdentityCurrent(identity);
    const known = payload && typeof payload === "object" ? payload as { message?: unknown; code?: unknown } : {};
    const publicCodes: Record<number, readonly string[]> = {
      400: ["studio_transfer_invalid"], 404: ["studio_transfer_missing"], 422: ["studio_transfer_unavailable", "studio_video_directory_too_large"],
      409: ["authority_changed", "studio_paid_execution_paused", "studio_original_pin_required", "studio_transfer_changed", "studio_transfer_cancelled", "studio_video_directory_changed"],
    };
    const selectionError = publicStudioModelSelectionError(known.code, upstream.status);
    const code = selectionError?.code ?? (publicCodes[upstream.status]?.includes(String(known.code)) ? String(known.code) : undefined);
    // A Chinese prefix is not a redaction rule: provider diagnostics can mix
    // human text with keys or tokens. Only exact public owner messages pass.
    const publicMessages = new Set(["模型配置已变化，请刷新后重试", "素材未通过安全扫描",
      "另一页面已保存此项目。请保留当前内容，重新打开后再编辑。"]);
    const message = selectionError?.message ?? (code === "studio_paid_execution_paused" ? "生成已暂停 你可以继续编辑和保存"
      : code === "authority_changed" ? "当前本人权限已变化 请重新核对"
        : code === "studio_original_pin_required" ? "送审需要固定原稿版本 请刷新创作工作台后重试"
        : code === "studio_transfer_changed" ? "来源或目标已变化 请保留原请求并重新预览"
        : code === "studio_transfer_cancelled" ? "本次准备已取消 原请求不能再执行"
        : code === "studio_transfer_invalid" ? "创作资料结构或引用不完整 请核对原工作区"
        : code === "studio_transfer_missing" ? "尚未找到原复制准备记录 请先核对结果"
        : code === "studio_transfer_unavailable" ? "原件对象暂时无法核对 复制尚未执行"
        : code === "studio_video_directory_changed" ? "视频日志或任务已变化 请重新读取完整目录"
        : code === "studio_video_directory_too_large" ? "视频日志超过本次完整读取上限 未将部分结果视为空目录"
        : typeof known.message === "string" && publicMessages.has(known.message) ? known.message : undefined);
    return studioPersonalFailure(upstream.status, message, code);
  }
  if (![200, 201].includes(upstream.status)) { await upstream.body?.cancel(); return studioPersonalFailure(502); }
  let raw: unknown;
  try { raw = await readStudioJson(upstream, limit); }
  catch { await assertErpIdentityCurrent(identity); return studioPersonalFailure(502); }
  const value = schema.parse(raw);
  // apiFetch checks headers. Recheck only after every private response byte has
  // arrived and the transport schema has passed; never stream old private bytes.
  await assertErpIdentityCurrent(identity);
  return Response.json(value, { status: upstream.status, headers: { ...studioPersonalHeaders,
    "x-yummyai-context-authority": erpSessionAuthority(identity.view) } });
}
export function studioPersonalFailure(status: number, message?: string, code?: string) {
  if (![400, 401, 403, 404, 408, 409, 413, 415, 422, 429, 503, 504].includes(status)) status = 502;
  const messages: Record<number, string> = { 400: "请求格式无效 请核对输入", 401: "ERP 登录已失效", 403: "当前账户没有此操作权限",
    404: "项目或素材不存在", 408: "数据读取超时 请保留当前内容后重试", 409: "记录或权限已变化 请核对原操作结果", 413: "创作数据超过传输上限", 415: "请求格式不受支持",
    422: "素材未通过安全检查", 429: "请求较多 请稍后重试", 503: "创作服务尚未就绪", 504: "连接超时 请核对原操作结果" };
  return Response.json({ error: message || messages[status] || "连接创作服务失败 请保留当前内容", ...(code ? { code } : {}) },
    { status, headers: studioPersonalHeaders });
}
export function studioPersonalException(error: unknown, request: Request) {
  if (error instanceof PersonalSessionError) return erpAuthFailure(error, request);
  if (error instanceof StudioBodyError) return studioPersonalFailure(error.status);
  if (error instanceof ForbiddenError) return studioPersonalFailure(403);
  return studioPersonalFailure(502);
}
