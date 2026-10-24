import { apiFetch } from "../../../../server-api";
import { isSameOriginRequest } from "../../../../same-origin-request";

export const dynamic = "force-dynamic";
const id = "[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const readPath = new RegExp(`^${id}/study$`, "i");
const writePath = new RegExp(`^(archive|creative-sources|${id}/study)$`, "i");
type Context = { params: Promise<{ path: string[] }> };
export async function GET(request: Request, context: Context) {
  return proxy(request, context, "GET");
}
export async function POST(request: Request, context: Context) {
  return proxy(request, context, "POST");
}

async function proxy(request: Request, context: Context, method: "GET" | "POST") {
  const target = (await context.params).path.join("/");
  if (!(method === "GET" ? readPath : writePath).test(target)) return failure(404);
  if (
    method === "POST" &&
    (!isSameOriginRequest(request) ||
      !request.headers.get("content-type")?.startsWith("application/json"))
  )
    return failure(403);
  const base = process.env.API_BASE_URL?.replace(/\/$/, "");
  if (!base) return failure(503);
  let body: string | undefined;
  if (method === "POST") {
    const reader = request.body?.getReader();
    if (!reader) return failure(400);
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > 1024 * 1024) {
        await reader.cancel();
        return failure(413);
      }
      chunks.push(next.value);
    }
    body = Buffer.concat(chunks).toString("utf8");
    try {
      JSON.parse(body);
    } catch {
      return failure(400);
    }
  }
  const query = new URLSearchParams();
  const revision = new URL(request.url).searchParams.get("revision");
  if (method === "GET" && revision) query.set("revision", revision);
  try {
    const response = await apiFetch(
      `${base}/v1/research-items/${target}${query.size ? `?${query}` : ""}`,
      {
        method,
        body,
        cache: "no-store",
        headers: body ? { "content-type": "application/json" } : undefined,
        signal: AbortSignal.timeout(30000),
      },
    );
    if (!response.ok) {
      const error = [400, 409, 422].includes(response.status)
        ? await response.json().catch(() => null)
        : null;
      return failure(
        response.status,
        typeof error?.message === "string" ? error.message.slice(0, 400) : undefined,
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
        (status === 401
          ? "登录已失效，请重新登录"
          : status === 403
            ? "当前账号没有此操作权限"
            : status === 404
              ? "研究资料或版本不存在"
              : "研究资料操作未完成，请稍后重试"),
    },
    { status, headers: { "cache-control": "private, no-store" } },
  );
}
