import { Suspense } from "react";
import { KnowledgeWorkbench } from "../../../features/knowledge/knowledge-workbench";
export const metadata = { title: "运营知识库 · YummyAI" };
export default function Page() {
  return (
    <Suspense
      fallback={
        <main className="oc-page" role="status">
          正在读取知识…
        </main>
      }
    >
      <KnowledgeWorkbench />
    </Suspense>
  );
}
