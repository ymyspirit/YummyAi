import { Suspense } from "react";
import { ContentProjectWorkspace } from "../../../features/content-projects/content-project-workspace";

export const dynamic = "force-dynamic";
export const metadata = { title: "商品图文项目 · YummyAI" };
export default function ContentProjectsPage() {
  return (
    <Suspense
      fallback={
        <main className="cp-page" aria-busy="true">
          <p role="status">正在读取图文项目…</p>
        </main>
      }
    >
      <ContentProjectWorkspace />
    </Suspense>
  );
}
