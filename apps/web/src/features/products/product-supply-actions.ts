"use server";

import { ProductSupplyWorkspaceSchema, ProductSupplyVersionViewSchema } from "@yummyai/contracts/catalog/product-supply";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import { apiFetch } from "../../server-api";

export async function loadProductSupplyWorkspace() {
  try {
    if (!process.env.API_BASE_URL) return { error: "供货资料服务尚未配置。" };
    const response = await apiFetch(`${process.env.API_BASE_URL.replace(/\/$/, "")}/v1/product-suppliers/workspace`, { cache: "no-store" });
    if (!response.ok) return { error: readError(response.status) };
    return { data: ProductSupplyWorkspaceSchema.parse(await response.json()) };
  } catch { return { error: "供货资料暂时无法读取，请刷新后重试。" }; }
}

export async function loadProductSupplyHistory(id: string) {
  if (!EntityIdSchema.safeParse(id).success) return { error: "供货记录标识无效。" };
  try {
    if (!process.env.API_BASE_URL) return { error: "供货资料服务尚未配置。" };
    const response = await apiFetch(`${process.env.API_BASE_URL.replace(/\/$/, "")}/v1/product-suppliers/${id}/history`, { cache: "no-store" });
    if (!response.ok) return { error: readError(response.status) };
    return { versions: ProductSupplyVersionViewSchema.array().parse(await response.json()) };
  } catch { return { error: "报价历史暂时无法读取，请重试。" }; }
}
function readError(status: number) {
  if (status === 401) return "请先登录后查看供货资料。";
  if (status === 403) return "当前成员没有采购资料查看权限。";
  if (status === 404) return "供货记录不存在或当前成员无权访问。";
  return `供货资料读取失败（${status}）。`;
}
