import { Suspense } from "react";
import { MethodWorkbench } from "../../../../features/methods/method-workbench";
export default function Page() {
  return (
    <Suspense
      fallback={
        <main className="oc-page" role="status">
          正在读取方法库…
        </main>
      }
    >
      <MethodWorkbench />
    </Suspense>
  );
}
