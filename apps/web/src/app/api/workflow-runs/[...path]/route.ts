import { WorkflowResponsibilityViewSchema } from "@yummyai/contracts/workflow/responsibility";
import { WorkflowTaskInboxQuerySchema, WorkflowTaskInboxViewSchema } from "@yummyai/contracts/workflow/task-inbox";
import { WorkflowRunDetailSchema } from "@yummyai/contracts/workflow";
import {
  WorkflowNodeInspectionSchema,
  WorkflowRepairOptionsSchema,
  WorkflowArtifactInspectionSchema,
} from "@yummyai/contracts/workflow/operator";
import { apiFetch } from "../../../../server-api";

export const dynamic = "force-dynamic";
const id = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const headers = {
  "cache-control": "private, no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};
export async function GET(request: Request, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  if (path.length === 1 && path[0] === "tasks") return taskInbox(request);
  if (!id.test(path[0] ?? "")) return failure(404);
  const node =
    path.length === 4 &&
    path[1] === "nodes" &&
    Boolean(path[2]) &&
    !path[2]!.includes("/") &&
    !path[2]!.includes("\\") &&
    ![...path[2]!].some((character) => character.charCodeAt(0) < 32) &&
    ![".", ".."].includes(path[2]!) &&
    path[2]!.length <= 120;
  const artifact = path[1] === "artifacts" && id.test(path[2] ?? "");
  const file = artifact && path.length === 4 && path[3] === "file";
  const schema =
    path.length === 1
      ? WorkflowRunDetailSchema
      : node && path[3] === "execution"
        ? WorkflowNodeInspectionSchema
        : node && path[3] === "repair-options"
          ? WorkflowRepairOptionsSchema
          : node && path[3] === "responsibility"
            ? WorkflowResponsibilityViewSchema
            : artifact && path.length === 3
              ? WorkflowArtifactInspectionSchema
              : null;
  if (!schema && !file) return failure(404);
  const url = new URL(request.url),
    q = url.searchParams.get("q") ?? "";
  if (
    [...url.searchParams.keys()].some(
      (key) => key !== "q" || !node || !["repair-options", "responsibility"].includes(path[3]!),
    ) ||
    q.length > 100 ||
    url.searchParams.getAll("q").length > 1
  )
    return failure(400);
  const base = process.env.API_BASE_URL?.replace(/\/$/, "");
  if (!base) return failure(503);
  const upstream = new URL(`${base}/v1/workflow-runs/${path.map(encodeURIComponent).join("/")}`);
  if (q) upstream.searchParams.set("q", q);
  try {
    const response = await apiFetch(upstream, {
      cache: "no-store",
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(60_000)]),
    });
    if (!response.ok) return failure(response.status);
    if (file) {
      if (!response.headers.get("content-type")?.startsWith("application/zip")) return failure(502);
      return new Response(response.body, {
        headers: {
          ...headers,
          "content-type": "application/zip",
          "content-disposition":
            response.headers.get("content-disposition") ??
            "attachment; filename=custom-product-package.zip",
          "content-security-policy": "default-src 'none'; sandbox",
        },
      });
    }
    const value = schema!.safeParse(await response.json());
    return value.success ? Response.json(value.data, { headers }) : failure(502);
  } catch {
    return failure(503);
  }
}
async function taskInbox(request: Request) {
  const search = new URL(request.url).searchParams;
  if ([...search.keys()].some((key) => search.getAll(key).length > 1)) return failure(400);
  const query = WorkflowTaskInboxQuerySchema.safeParse(Object.fromEntries(search));
  if (!query.success) return failure(400);
  const base = process.env.API_BASE_URL?.replace(/\/$/, "");
  if (!base) return failure(503);
  const upstream = new URL(`${base}/v1/workflow-runs/tasks`);
  for (const [key, value] of Object.entries(query.data)) upstream.searchParams.set(key, String(value));
  try {
    const response = await apiFetch(upstream, { cache: "no-store", signal: AbortSignal.any([request.signal, AbortSignal.timeout(60_000)]) });
    if (!response.ok) return failure(response.status);
    const body = WorkflowTaskInboxViewSchema.safeParse(await response.json());
    return body.success ? Response.json(body.data, { headers }) : failure(502);
  } catch { return failure(503); }
}
function failure(status: number) {
  const message =
    (
      {
        400: "请求参数无效，请重新打开任务",
        401: "登录已失效，请重新登录",
        403: "当前成员没有查看或操作该任务的权限",
        404: "任务或产物不存在，或不在当前范围内",
        409: "商品或素材已变化，请回到原业务模块核对",
        422: "产物尚未满足要求，请核对缺项",
        502: "任务服务返回的内容不完整",
        503: "任务服务暂不可用，请稍后刷新",
      } as Record<number, string>
    )[status] ?? "读取未完成，请稍后刷新";
  return Response.json(
    { message },
    { status: status >= 400 && status < 600 ? status : 502, headers },
  );
}
