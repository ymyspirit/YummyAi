import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import {
  CaptureMediaPageSchema,
  CaptureMediaReadLeaseSchema,
} from "@yummyai/contracts/capture/media-preview";
import { apiFetch } from "../../../../server-api";

export const dynamic = "force-dynamic";
const privateHeaders = {
  "cache-control": "private, no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};
type Context = { params: Promise<{ path: string[] }> };
export async function GET(request: Request, context: Context) {
  const { path } = await context.params,
    query = new URL(request.url).searchParams;
  if (request.headers.get("sec-fetch-site") === "cross-site") return failure(403);
  if (![1, 2].includes(path.length) || path.some((part) => !EntityIdSchema.safeParse(part).success))
    return failure(404);
  const content = path.length === 2;
  if (
    [...query.keys()].some(
      (key) => key !== (content ? "v" : "after") || query.getAll(key).length > 1,
    )
  )
    return failure(400);
  const after = query.get("after"),
    version = query.get("v");
  if (
    (after !== null && !EntityIdSchema.safeParse(after).success) ||
    (version !== null && !/^\d{1,8}$/.test(version))
  )
    return failure(400);
  const base = process.env.API_BASE_URL?.replace(/\/$/, "");
  if (!base) return failure(503);
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(content ? 120_000 : 30_000)]);
  try {
    if (!content) {
      const response = await apiFetch(
        `${base}/v1/captures/${path[0]}/media${after ? `?after=${after}` : ""}`,
        { cache: "no-store", signal },
      );
      if (!response.ok) return failure(response.status);
      const value = CaptureMediaPageSchema.safeParse(await response.json());
      return value.success && value.data.snapshotId === path[0]
        ? Response.json(value.data, { headers: privateHeaders })
        : failure(502);
    }
    const range = request.headers.get("range");
    if (range && (!/^bytes=(?:\d+-\d*|-\d+)$/.test(range) || range.length > 60))
      return failure(400);
    const leaseResponse = await apiFetch(
      `${base}/v1/captures/${path[0]}/media/${path[1]}/read-url`,
      { method: "POST", cache: "no-store", signal },
    );
    if (!leaseResponse.ok) return failure(leaseResponse.status);
    const lease = CaptureMediaReadLeaseSchema.safeParse(await leaseResponse.json());
    if (!lease.success || !process.env.S3_ENDPOINT || !process.env.S3_PRIVATE_BUCKET)
      return failure(502);
    const target = new URL(lease.data.url),
      endpoint = new URL(process.env.S3_ENDPOINT);
    const prefix = `${endpoint.pathname.replace(/\/$/, "")}/${encodeURIComponent(process.env.S3_PRIVATE_BUCKET)}/`;
    if (
      target.origin !== endpoint.origin ||
      !["http:", "https:"].includes(target.protocol) ||
      target.username ||
      target.password ||
      target.hash ||
      !target.pathname.startsWith(prefix)
    )
      return failure(502);
    // Storage gets only the signed URL and a validated Range, never the API bearer,
    // caller cookies, arbitrary destinations or caller-selected object paths.
    const stored = await fetch(target, {
      cache: "no-store",
      redirect: "error",
      signal,
      headers: range ? { range } : undefined,
    });
    if (stored.status === 416) {
      await stored.body?.cancel();
      return new Response(null, {
        status: 416,
        headers: {
          ...privateHeaders,
          "content-range": `bytes */${lease.data.byteSize}`,
          "accept-ranges": "bytes",
        },
      });
    }
    const contentType = stored.headers.get("content-type")?.split(";")[0]?.trim(),
      length = Number(stored.headers.get("content-length"));
    const contentRange = stored.headers.get("content-range"),
      match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(contentRange ?? "");
    const expected = range ? requestedInterval(range, lease.data.byteSize) : undefined;
    const validRange =
      match &&
      Number(match[3]) === lease.data.byteSize &&
      Number(match[1]) <= Number(match[2]) &&
      Number(match[2]) < lease.data.byteSize &&
      Number(match[2]) - Number(match[1]) + 1 === length &&
      expected &&
      Number(match[1]) === expected[0] &&
      Number(match[2]) === expected[1];
    if (
      stored.status !== (range ? 206 : 200) ||
      contentType !== lease.data.mediaType ||
      !Number.isSafeInteger(length) ||
      length <= 0 ||
      length > lease.data.byteSize ||
      (range ? !validRange : length !== lease.data.byteSize)
    ) {
      await stored.body?.cancel();
      return failure(502);
    }
    return new Response(stored.body, {
      status: stored.status,
      headers: {
        ...privateHeaders,
        "content-type": lease.data.mediaType,
        "content-length": String(length),
        "accept-ranges": "bytes",
        "content-disposition": "inline",
        "content-security-policy": "default-src 'none'; sandbox",
        ...(contentRange && range ? { "content-range": contentRange } : {}),
      },
    });
  } catch {
    return failure(503);
  }
}
function requestedInterval(range: string, total: number): [number, number] | undefined {
  const [start, end] = range.slice(6).split("-");
  if (start === "") {
    const count = Number(end);
    return Number.isSafeInteger(count) && count > 0
      ? [Math.max(0, total - count), total - 1]
      : undefined;
  }
  const first = Number(start),
    last = end === "" ? total - 1 : Math.min(Number(end), total - 1);
  return Number.isSafeInteger(first) &&
    Number.isSafeInteger(last) &&
    first >= 0 &&
    first < total &&
    last >= first
    ? [first, last]
    : undefined;
}
function failure(status: number) {
  const message =
    (
      {
        400: "媒体请求参数无效",
        401: "登录已失效 请重新登录",
        403: "当前成员没有查看此媒体的权限",
        404: "媒体不存在或不在当前资料范围",
        409: "媒体尚无可用的已扫描归档 请刷新状态",
        502: "归档媒体的内容或格式未通过读取检查",
        503: "媒体读取暂不可用 请稍后重试",
      } as Record<number, string>
    )[status] ?? "媒体读取未完成 请刷新状态后重试";
  return Response.json(
    { message },
    { status: status >= 400 && status < 600 ? status : 502, headers: privateHeaders },
  );
}
