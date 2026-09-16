import { Suspense } from "react";
import type { OrderWorkspaceModule } from "@yummyai/contracts/order/workspace";
import { OrderCenterWorkspace } from "./order-center-workspace";
export function OrderCenterPage({ module }: { module: OrderWorkspaceModule }) {
  return (
    <Suspense
      fallback={
        <main className="oc-page" role="status">
          正在读取订单…
        </main>
      }
    >
      <OrderCenterWorkspace module={module} />
    </Suspense>
  );
}
