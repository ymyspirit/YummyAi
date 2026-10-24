import { AmazonReportImportErrorSchema, formatAmazonReportImportError, type AmazonReportImportError } from "@yummyai/contracts/order/report";

class ReportImportError extends Error {
  constructor(diagnostic: AmazonReportImportError) {
    super(formatAmazonReportImportError(diagnostic));
    this.name = "ReportImportError";
  }
}

export function reportUserError(cause: unknown): string {
  // Only this locally constructed error can bypass the generic error filter.
  if (cause instanceof ReportImportError) return cause.message;
  return cause instanceof Error && /^(登录|当前账号|内容已更新|文件|请选择|无法按|操作未完成)/.test(cause.message) ? cause.message : "操作未完成，请刷新后重试。";
}

export async function reportRequest(path: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(`/api/orders/reports/${path}`, { method: body === undefined ? "GET" : "POST", ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }), cache: "no-store", signal: signal ?? AbortSignal.timeout(115_000) });
  if (!response.ok) {
    if (path === "import" && body !== undefined && response.status === 422) {
      const diagnostic = AmazonReportImportErrorSchema.safeParse(await response.json().catch(() => null));
      if (diagnostic.success) throw new ReportImportError(diagnostic.data);
    }
    throw new Error(response.status === 401 ? "登录已失效，请重新登录。" : response.status === 403 ? "当前账号没有执行此操作的权限。" : response.status === 409 ? "内容已更新，请重新打开订单后再操作。" : response.status === 413 ? "文件超过允许的大小。" : "操作未完成，请检查文件或稍后重试。");
  }
  return response.json();
}
