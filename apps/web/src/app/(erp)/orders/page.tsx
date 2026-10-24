import { OrderCenterPage } from "../../../features/order-centers/order-center-page";
import { OrderWorkspaceHeader } from "../../../features/orders/order-workspace-header";
import { AmazonReportWorkspace } from "../../../features/orders/amazon-report-workspace";
import { loadAmazonReportWorkspace } from "../../../features/orders/amazon-report-loader";
import "../../../features/orders/amazon-report-workspace.css";
export const dynamic = "force-dynamic";
export default async function OrdersPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if ((await searchParams).view === "reports") {
    const result = await loadAmazonReportWorkspace();
    return <main className="research-main order-main order-report-main"><OrderWorkspaceHeader view="reports" /><AmazonReportWorkspace accounts={result.accounts} initialWorkspace={result.workspace} initialError={result.error} /></main>;
  }
  return <OrderCenterPage module="orders" />;
}
