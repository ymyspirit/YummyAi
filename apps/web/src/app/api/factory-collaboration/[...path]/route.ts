import { apiFetch } from "../../../../server-api";
import { isSameOriginRequest } from "../../../../same-origin-request";
import { factoryPortalOnly } from "../../../../factory-portal-mode";
import {
  FactoryGrantQuerySchema,
  FactoryTaskQuerySchema,
  FactoryGrantCreateSchema,
  FactoryAccessRevokeSchema,
  FactoryTaskAssignSchema,
} from "@yummyai/contracts/suppliers/factory-portal";
export const dynamic = "force-dynamic";
const id = "[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}",
  assignment = new RegExp(`^grants/${id}/work-items$`, "i"),
  revoke = new RegExp(`^(grants|assignments)/${id}/revoke$`, "i");
type Context = { params: Promise<{ path: string[] }> };
export const GET = (request: Request, context: Context) => proxy(request, context, "GET");
export const POST = (request: Request, context: Context) => proxy(request, context, "POST");
async function proxy(request: Request, context: Context, method: "GET" | "POST") {
  if (factoryPortalOnly()) return failure(404);
  const path = (await context.params).path.join("/"),
    url = new URL(request.url),
    isAssignment = assignment.test(path);
  if (
    !(method === "GET"
      ? path === "workspace" || isAssignment
      : path === "grants" || isAssignment || revoke.test(path))
  )
    return failure(404);
  if (method === "GET") {
    if (
      [...url.searchParams.keys()].some((key) => url.searchParams.getAll(key).length !== 1) ||
      !(path === "workspace" ? FactoryGrantQuerySchema : FactoryTaskQuerySchema).safeParse(
        Object.fromEntries(url.searchParams),
      ).success
    )
      return failure(400);
  } else if (url.searchParams.size) return failure(400);
  let body: string | undefined;
  if (method === "POST") {
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
      const value = JSON.parse(body);
      if (
        !(
          path === "grants"
            ? FactoryGrantCreateSchema
            : isAssignment
              ? FactoryTaskAssignSchema
              : FactoryAccessRevokeSchema
        ).safeParse(value).success
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
    const response = await apiFetch(`${base}/v1/factory-collaboration/${path}${url.search}`, {
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
        message ??
        (status === 403 ? "当前账户没有工厂协作管理权限" : "工厂协作请求未完成 请刷新核对"),
    },
    { status, headers: { "cache-control": "private, no-store" } },
  );
}
