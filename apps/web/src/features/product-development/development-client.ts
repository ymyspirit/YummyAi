export async function developmentRequest<T>(
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`/api/product-development/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
    signal,
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(
      data.message ?? (response.status === 403 ? "没有操作权限" : "请求失败，请刷新重试"),
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
