import { KnowledgeProductOptionsQuerySchema, KnowledgeProductOptionsSchema } from "@yummyai/contracts/knowledge";
import { erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { apiFetch } from "../../../../server-api";
import { assertErpIdentityCurrent, erpAuthFailure, erpRequestIdentity } from "../../../../erp-auth/server";
import { PersonalSessionError } from "../../../../identity/core";

export const dynamic = "force-dynamic";
const headers = { "cache-control": "private, no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" };
const failure = (status: number, code?: string) => Response.json({
  message: status === 401 ? "请登录自己的运营账户" : status === 403 ? "当前没有产品知识范围的读取权限" :
    status === 409 ? "当前身份或产品范围已变化 请重新读取" : "产品知识范围暂不可读取 请重试",
  ...(code ? { code } : {}),
}, { status, headers });

async function readCandidates(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Missing product candidate response");
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength;
      if (size > 128 * 1024) { await reader.cancel(); throw new Error("Product candidate response too large"); }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
}

export async function GET(request: Request) {
  const query = new URL(request.url).searchParams;
  if ([...query.keys()].some(key => key !== "q") || query.getAll("q").length > 1) return failure(400);
  const parsed = KnowledgeProductOptionsQuerySchema.safeParse({ q: query.get("q") ?? "" });
  if (!parsed.success) return failure(400);
  try {
    const identity = await erpRequestIdentity(request), authority = erpSessionAuthority(identity.view);
    if (request.headers.get("x-yummyai-context-authority") !== authority)
      throw new PersonalSessionError(409, "authority_changed");
    const base = process.env.API_BASE_URL?.replace(/\/$/, ""); if (!base) return failure(503);
    const response = await apiFetch(`${base}/v1/knowledge/product-options?${new URLSearchParams(parsed.data)}`, {
      cache: "no-store", signal: AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]),
    });
    if (response.status !== 200) {
      await response.body?.cancel(); await assertErpIdentityCurrent(identity);
      return failure([400, 401, 403, 404, 408, 409, 422, 503].includes(response.status) ? response.status : 502);
    }
    const raw = await readCandidates(response);
    await assertErpIdentityCurrent(identity);
    const value = KnowledgeProductOptionsSchema.parse(raw);
    if (value.contextAuthority !== authority || response.headers.has("x-yummyai-context-authority") && response.headers.get("x-yummyai-context-authority") !== authority)
      return failure(409, "authority_changed");
    return Response.json(value, { headers: { ...headers, "x-yummyai-context-authority": authority } });
  } catch (error) {
    return error instanceof PersonalSessionError ? erpAuthFailure(error, request) : failure(502);
  }
}
