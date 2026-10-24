import {
  CreateSalesPlanSchema,
  SaveSalesPlanSchema,
  SalesPlanActionSchema,
  SalesPlanDraftSchema,
  SalesPlanQuerySchema,
  SalesPlanReferenceSelectionSchema,
} from "@yummyai/contracts/catalog/sales-plan";
import { apiFetch } from "../../../../server-api";
import {
  LaunchBasisRequestSchema,
  LaunchAdoptRequestSchema,
} from "@yummyai/contracts/catalog/sales-plan-launch";
import { isSameOriginRequest } from "../../../../same-origin-request";
import {
  PreparationStartSchema,
  PreparationCommandSchema,
  PreparationAnalyzeSchema,
  PreparationBasisSchema,
} from "@yummyai/contracts/catalog/sales-plan-agent";
import {
  PrepareProductVisualsSchema,
  GenerateProductVisualSchema,
  ReviewProductVisualSchema,
  AdoptProductVisualsSchema,
  CollectProductVisualsSchema,
} from "@yummyai/contracts/catalog/product-visuals";
import {
  DeliveryReviewSchema,
  DeliverySealSchema,
  DeliveryReadQuerySchema,
  DeliveryExportQuerySchema,
} from "@yummyai/contracts/catalog/sales-plan-delivery";

export const dynamic = "force-dynamic";
const id = "[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const getPath = new RegExp(
  `^(|options|${id}(?:/launch(?:/(?:agent(?:/${id})?|visuals|delivery(?:/packages/${id}/export)?))?)?)$`,
  "i",
);
const postPath = new RegExp(
  `^(|${id}(?:/(?:archive|draft|reference-options|launch/(?:agent(?:/${id}/(?:resume|cancel|basis|analyze))?|basis|adopt|delivery/(?:review|seal)|visuals/(?:prepare|${uuid}/(?:generate|collect|review|adopt)))))?)$`,
  "i",
);
type Context = { params: Promise<{ path?: string[] }> };
export async function GET(request: Request, context: Context) {
  return proxy(request, context, "GET");
}
export async function POST(request: Request, context: Context) {
  return proxy(request, context, "POST");
}
async function proxy(request: Request, context: Context, method: "GET" | "POST") {
  const path = ((await context.params).path ?? []).join("/");
  if (!(method === "GET" ? getPath : postPath).test(path)) return failure(404, "此操作不存在");
  if (
    method === "POST" &&
    (!isSameOriginRequest(request) ||
      !request.headers.get("content-type")?.startsWith("application/json"))
  )
    return failure(403, "请求来源不可用");
  const base = process.env.API_BASE_URL?.replace(/\/$/, "");
  if (!base) return failure(503, "销售方案需要已配置的用户身份与 API");
  try {
    let body: string | undefined,
      query = "";
    if (method === "GET" && !path) {
      const parsed = SalesPlanQuerySchema.parse(
        Object.fromEntries(new URL(request.url).searchParams),
      );
      query = `?${new URLSearchParams(Object.entries(parsed).map(([key, value]) => [key, String(value)]))}`;
    }
    if (method === "GET" && /\/launch\/delivery(?:\/packages\/.+\/export)?$/.test(path)) {
      const params = new URL(request.url).searchParams;
      if ([...params.keys()].some((key) => params.getAll(key).length !== 1))
        return failure(400, "查询参数不能重复");
      const parsed = (
        path.endsWith("/export") ? DeliveryExportQuerySchema : DeliveryReadQuerySchema
      ).parse(Object.fromEntries(params));
      query = `?${new URLSearchParams(Object.entries(parsed).map(([key, value]) => [key, String(value)]))}`;
    }
    if (method === "POST") {
      const reader = request.body?.getReader();
      if (!reader) return failure(400, "缺少保存内容");
      let length = 0;
      const chunks: Uint8Array[] = [];
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        length += next.value.byteLength;
        if (length > 1024 * 1024) {
          await reader.cancel();
          return failure(413, "保存内容过大");
        }
        chunks.push(next.value);
      }
      const schema = path.endsWith("/reference-options")
        ? SalesPlanReferenceSelectionSchema
        : path.includes("/launch/agent")
          ? path.endsWith("/agent")
            ? PreparationStartSchema
            : path.endsWith("/basis")
              ? PreparationBasisSchema
              : path.endsWith("/analyze")
                ? PreparationAnalyzeSchema
                : PreparationCommandSchema
          : path.includes("/launch/delivery/")
            ? path.endsWith("/review")
              ? DeliveryReviewSchema
              : DeliverySealSchema
            : path.includes("/launch/visuals/")
              ? path.endsWith("/prepare")
                ? PrepareProductVisualsSchema
                : path.endsWith("/generate")
                  ? GenerateProductVisualSchema
                  : path.endsWith("/review")
                    ? ReviewProductVisualSchema
                    : path.endsWith("/adopt")
                      ? AdoptProductVisualsSchema
                      : CollectProductVisualsSchema
              : !path
                ? CreateSalesPlanSchema
                : path.endsWith("/archive")
                  ? SalesPlanActionSchema
                  : path.endsWith("/draft")
                    ? SalesPlanDraftSchema
                    : path.endsWith("/launch/basis")
                      ? LaunchBasisRequestSchema
                      : path.endsWith("/launch/adopt")
                        ? LaunchAdoptRequestSchema
                        : SaveSalesPlanSchema;
      body = JSON.stringify(schema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8"))));
    }
    const response = await apiFetch(`${base}/v1/sales-plans${path ? `/${path}` : ""}${query}`, {
      method,
      body,
      cache: "no-store",
      headers: body ? { "content-type": "application/json" } : undefined,
      signal: AbortSignal.timeout(110000),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => null);
      return failure(
        response.status,
        method === "POST" && response.status >= 500
          ? "操作结果尚未确认 请在当前页面重试或重新核对方案"
          : [400, 409, 422].includes(response.status) &&
              typeof error?.message === "string" &&
              error.message.length < 500
            ? error.message
            : response.status === 403
              ? "当前账号没有此操作权限"
              : response.status === 404
                ? "方案不存在或当前账号不可读取"
                : "操作未完成，请稍后重试",
      );
    }
    return new Response(response.body, {
      status: response.status,
      headers: {
        "content-type": path.endsWith("/export") ? "application/zip" : "application/json",
        ...(path.endsWith("/export")
          ? {
              "content-disposition":
                response.headers.get("content-disposition") ??
                'attachment; filename="sales-plan-delivery.zip"',
            }
          : {}),
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    if (error && typeof error === "object" && "issues" in error && Array.isArray(error.issues))
      return failure(400, String(error.issues[0]?.message ?? "请检查保存内容"));
    if (error instanceof SyntaxError) return failure(400, "保存内容格式有误");
    return failure(
      502,
      method === "POST"
        ? "操作结果尚未确认 请在当前页面重试或重新核对方案"
        : "销售方案 API 暂时不可用，请重试",
    );
  }
}
function failure(status: number, message: string) {
  return Response.json({ message }, { status, headers: { "cache-control": "private, no-store" } });
}
