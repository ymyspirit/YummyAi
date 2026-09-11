import type { AmazonReportWorkspaceView, MarketplaceAccountView } from "@yummyai/contracts";
import { AmazonReportWorkspaceViewSchema } from "@yummyai/contracts/order/report";
import { MarketplaceAccountViewSchema } from "@yummyai/contracts/marketplace/store";
import { apiFetch } from "../../server-api";

export async function loadAmazonReportWorkspace(): Promise<{ accounts: MarketplaceAccountView[]; workspace: AmazonReportWorkspaceView; error?: string }> {
  const empty = { batches: [], lines: [] };
  const base = process.env.API_BASE_URL?.replace(/\/$/, "");
  if (!base) return { accounts: [], workspace: empty, error: "订单服务尚未配置，请联系管理员。" };
  let accounts: MarketplaceAccountView[] = [];
  try {
    const response = await apiFetch(`${base}/v1/marketplace-accounts`, { cache: "no-store" });
    if (!response.ok) return { accounts, workspace: empty, error: loadError(response.status) };
    const value: unknown = await response.json();
    if (!Array.isArray(value)) throw new Error("Invalid account list");
    accounts = value.map((item) => MarketplaceAccountViewSchema.parse(item)).filter((account) => account.platform === "amazon" && !["disabled", "revoked"].includes(account.status));
    if (!accounts[0]) return { accounts, workspace: empty };
    const workspaceResponse = await apiFetch(`${base}/v1/orders/reports/workspace?accountId=${encodeURIComponent(accounts[0].id)}`, { cache: "no-store" });
    if (!workspaceResponse.ok) return { accounts, workspace: empty, error: loadError(workspaceResponse.status) };
    return { accounts, workspace: AmazonReportWorkspaceViewSchema.parse(await workspaceResponse.json()) };
  } catch {
    return { accounts, workspace: empty, error: "订单服务暂时不可用，请稍后刷新页面。" };
  }
}

function loadError(status: number): string {
  if (status === 401) return "登录已失效，请重新登录后刷新。";
  if (status === 403) return "当前账号没有读取订单报告的权限，请联系管理员。";
  return "订单报告暂时无法读取，请稍后刷新页面。";
}
