import { OrderCenterPage } from "../../../features/order-centers/order-center-page";
import { NativeProductionWorkspace } from "../../../features/order-centers/native-production-workspace";
import { Suspense } from "react";
export default async function ProductionPage({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  const params = await searchParams;
  return params.view === "native" ? <Suspense fallback={<main className="oc-page" role="status">正在读取生产来源</main>}><NativeProductionWorkspace /></Suspense> : <OrderCenterPage module="production" />;
}
