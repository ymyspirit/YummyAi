import { Suspense } from "react";
import { PrintLibraryWorkspace } from "../../../features/order-centers/print-library-workspace";
export default function Page() {
  return (
    <Suspense fallback={<main className="oc-page" role="status">正在读取工艺库…</main>}>
      <PrintLibraryWorkspace />
    </Suspense>
  );
}
