import { Suspense } from "react";
import { ModelBillingWorkbench } from "../../../features/model-billing/model-billing-workbench";
export const metadata = { title: "模型费用核对 · YummyAI" };
export default function Page() {
  return (
    <Suspense
      fallback={
        <main className="oc-page" role="status">
          正在读取模型费用…
        </main>
      }
    >
      <ModelBillingWorkbench />
    </Suspense>
  );
}
