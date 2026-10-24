export class SalesPlanRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
export const salesPlanReadDenied = (error: unknown) =>
  error instanceof SalesPlanRequestError && [401, 403, 404].includes(error.status);
export async function salesPlanRequest<T>(
  path = "",
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  try {
    const response = await fetch(
      `/api/sales-plans${path ? (path.startsWith("?") ? path : `/${path}`) : ""}`,
      {
        method: body === undefined ? "GET" : "POST",
        cache: "no-store",
        signal: AbortSignal.any([
          ...(signal ? [signal] : []),
          AbortSignal.timeout(body === undefined ? 20000 : 120000),
        ]),
        headers: body === undefined ? undefined : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
    );
    const data = await response.json().catch(() => null);
    if (!response.ok)
      throw new SalesPlanRequestError(
        response.status,
        body !== undefined && response.status >= 500
          ? "操作结果尚未确认 请在当前页面重试或重新核对方案"
          : typeof data?.message === "string" && data.message.length <= 500
            ? data.message
            : "销售方案暂时不可用 请重新核对",
      );
    if (!data || typeof data !== "object")
      throw new SalesPlanRequestError(
        502,
        body === undefined
          ? "销售方案返回内容无法核对 请重试读取"
          : "操作结果尚未确认 请在当前页面重试或重新核对方案",
      );
    return data as T;
  } catch (error) {
    if (signal?.aborted || error instanceof SalesPlanRequestError) throw error;
    throw new SalesPlanRequestError(
      0,
      body === undefined
        ? "销售方案暂时无法读取 请重试"
        : "操作结果尚未确认 请在当前页面重试或重新核对方案",
    );
  }
}
