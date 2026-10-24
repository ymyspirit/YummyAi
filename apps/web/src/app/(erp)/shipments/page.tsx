import { OrderCenterPage } from "../../../features/order-centers/order-center-page";
import { ShiposSyncPage } from "../../../features/order-centers/shipos-sync-page";
export const dynamic = "force-dynamic";
export default async function ShipmentPage({ searchParams }: { searchParams: Promise<{ view?: string; supplierId?: string }> }) {
  const query = await searchParams;
  return query.view === "logistics" ? <ShiposSyncPage supplierId={query.supplierId} /> : <OrderCenterPage module="shipments" />;
}
