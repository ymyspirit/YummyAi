import { AgentReadinessFamilySchema, AgentReadinessSchema } from "@yummyai/contracts/ai/agent-readiness";
import { erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { authorize } from "@yummyai/authz/authorize";
import { Permission } from "@yummyai/authz/permissions";
import { apiFetch } from "../../../../server-api";
import { assertErpIdentityCurrent, erpAuthFailure, erpRequestIdentity } from "../../../../erp-auth/server";
import { PersonalSessionError } from "../../../../identity/core";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ family: string }> };
const headers = { "cache-control": "private, no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" };
const failure = (status: number, changed = false) => Response.json({
  message: changed ? "当前本人身份或权限已变化 请重新读取诊断" : status === 401 ? "请登录自己的运营账户" :
    status === 403 ? "当前没有读取 Agent 诊断的权限" : "启动条件暂时无法核对 请重新读取",
  ...(changed ? { code: "authority_changed" } : {}),
}, { status, headers });

async function boundedJson(response: Response, maximum: number): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Missing diagnosis body");
  const parts: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength;
      if (size > maximum) { await reader.cancel(); throw new Error("Diagnosis body limit"); }
      parts.push(part.value);
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts)));
}

export async function GET(request: Request, context: Context) {
  if (request.method !== "GET") return failure(405);
  const family = AgentReadinessFamilySchema.safeParse((await context.params).family);
  if (!family.success) return failure(404);
  if (new URL(request.url).search) return failure(400);
  try {
    const identity = await erpRequestIdentity(request), authority = erpSessionAuthority(identity.view);
    if (request.headers.get("x-yummyai-context-authority") !== authority) throw new PersonalSessionError(409, "authority_changed");
    try { authorize(identity.view, Permission.WorkflowRead); } catch { return failure(403); }
    const base = process.env.API_BASE_URL?.replace(/\/$/, ""); if (!base) return failure(503);
    const response = await apiFetch(`${base}/v1/ai/agent-readiness/${family.data}`, {
      method: "GET", cache: "no-store", headers: { "x-yummyai-context-authority": authority },
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(35_000)]),
    });
    if (response.status !== 200) {
      let changed = false;
      if (response.status === 409) {
        try { const body = await boundedJson(response, 8192); changed = !!body && typeof body === "object" && "code" in body && body.code === "authority_changed"; }
        catch { /* Original error bodies are never exposed. */ }
      } else await response.body?.cancel();
      await assertErpIdentityCurrent(identity);
      return failure([400, 401, 403, 404, 409, 503].includes(response.status) ? response.status : 502, changed);
    }
    if (!response.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
      await response.body?.cancel(); await assertErpIdentityCurrent(identity); return failure(502);
    }
    const parsed = AgentReadinessSchema.safeParse(await boundedJson(response, 512 * 1024));
    await assertErpIdentityCurrent(identity);
    if (!parsed.success || parsed.data.family !== family.data) return failure(502);
    if (parsed.data.contextAuthority !== authority || response.headers.has("x-yummyai-context-authority") && response.headers.get("x-yummyai-context-authority") !== authority) return failure(409, true);
    return Response.json(parsed.data, { headers: { ...headers, "x-yummyai-context-authority": authority } });
  } catch (error) { return error instanceof PersonalSessionError ? erpAuthFailure(error, request) : failure(502); }
}

/** Diagnosis never accepts a business command, reservation or model request. */
export async function POST() { return failure(405); }
