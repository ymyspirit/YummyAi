import { apiFetch } from "../../../../server-api";
import { isSameOriginRequest } from "../../../../same-origin-request";
import { factoryPortalOnly } from "../../../../factory-portal-mode";
import {
  CreateTeamSchema,
  UpdateTeamSchema,
  SetTeamMemberSchema,
  TeamQuerySchema,
} from "@yummyai/contracts/identity/teams";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ path?: string[] }> };
const id = "[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
export const GET = (request: Request, context: Context) => proxy(request, context, "GET");
export const POST = (request: Request, context: Context) => proxy(request, context, "POST");
export const PATCH = (request: Request, context: Context) => proxy(request, context, "PATCH");
async function proxy(request: Request, context: Context, method: "GET" | "POST" | "PATCH") {
  if (factoryPortalOnly()) return failure(404);
  const path = ((await context.params).path ?? []).join("/"),
    url = new URL(request.url);
  const member = new RegExp(`^${id}/members$`, "i").test(path),
    update = new RegExp(`^${id}$`, "i").test(path);
  if (
    !(method === "GET"
      ? path === "" || path === "options"
      : method === "PATCH"
        ? update
        : path === "" || member)
  )
    return failure(404);
  if (method === "GET") {
    if (
      [...url.searchParams.keys()].some((key) => url.searchParams.getAll(key).length !== 1) ||
      (path === "options"
        ? url.searchParams.size > 0
        : !TeamQuerySchema.safeParse(Object.fromEntries(url.searchParams)).success)
    )
      return failure(400);
  } else if (url.searchParams.size) return failure(400);
  let body: string | undefined;
  if (method !== "GET") {
    if (
      !isSameOriginRequest(request) ||
      request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json"
    )
      return failure(403);
    const reader = request.body?.getReader();
    if (!reader) return failure(400);
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        length += next.value.byteLength;
        if (length > 32768) return failure(413);
        chunks.push(next.value);
      }
      body = Buffer.concat(chunks).toString("utf8");
      if (
        !(
          method === "PATCH" ? UpdateTeamSchema : member ? SetTeamMemberSchema : CreateTeamSchema
        ).safeParse(JSON.parse(body)).success
      )
        return failure(400);
    } catch {
      return failure(400);
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
  const base = process.env.API_BASE_URL?.replace(/\/$/, "");
  if (!base) return failure(503);
  try {
    const response = await apiFetch(`${base}/v1/teams${path ? `/${path}` : ""}${url.search}`, {
      method,
      body,
      cache: "no-store",
      headers: body ? { "content-type": "application/json" } : undefined,
      signal:
        method === "GET"
          ? AbortSignal.any([request.signal, AbortSignal.timeout(15000)])
          : AbortSignal.timeout(30000),
    });
    if (!response.ok) {
      const data = [400, 409].includes(response.status)
        ? await response.json().catch(() => null)
        : null;
      return failure(
        response.status,
        typeof data?.message === "string" && data.message.length < 500 ? data.message : undefined,
      );
    }
    return new Response(response.body, {
      status: response.status,
      headers: {
        "content-type": "application/json",
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch {
    return failure(502);
  }
}
function failure(status: number, message?: string) {
  return Response.json(
    {
      message:
        message ?? (status === 403 ? "当前账户没有团队管理权限" : "团队请求未完成 请刷新核对"),
    },
    { status, headers: { "cache-control": "private, no-store" } },
  );
}
