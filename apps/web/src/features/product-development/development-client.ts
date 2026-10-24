export class DevelopmentRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
export async function developmentRequest<T>(
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const mutating = body !== undefined && path !== "channels/preview";
  let response: Response;
  try {
    response = await fetch(`/api/product-development/${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(body === undefined ? 15000 : 30000)])
        : AbortSignal.timeout(body === undefined ? 15000 : 30000),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new DevelopmentRequestError(
      mutating ? "操作结果尚未确认 请核对原记录后在当前页面重试" : "资料暂时无法读取 请重试",
      502,
    );
  }
  const data = await response.json().catch(() => null);
  if (!response.ok)
    throw new DevelopmentRequestError(
      typeof data?.message === "string" && data.message.length <= 500
        ? data.message
        : response.status === 403
          ? "没有操作权限"
          : "请求失败 请刷新核对",
      response.status,
    );
  if (data === null)
    throw new DevelopmentRequestError(
      mutating ? "操作结果尚未确认 请核对原记录后在当前页面重试" : "响应无法核对 请刷新重试",
      502,
    );
  return data as T;
}
export const statuses: Record<string, string> = {
  unmapped: "待映射",
  pending_adaptation: "待制作",
  in_adaptation: "制作中",
  ready_for_customization: "来图方案已确认",
  approved: "制作已审核",
  packaged: "已封存资料包",
  needs_update: "来源有新版本",
  all: "全部状态",
};
export const modes = {
  fixed: "固定印花",
  personalized_text: "文字定制",
  customer_image: "买家图片定制",
  mixed: "图文定制",
};
