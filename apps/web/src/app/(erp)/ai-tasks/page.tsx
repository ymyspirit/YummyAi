import { Suspense } from "react";
import { redirect } from "next/navigation";
import { AiTaskWorkspace } from "../../../features/ai-tasks/ai-task-workspace";
export const metadata = { title: "AI 任务工作台 · YummyAI" };
export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  if (params.business === "1") {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (key === "business" || value === undefined) continue;
      for (const item of Array.isArray(value) ? value : [value]) query.append(key, item);
    }
    redirect(`/business-tasks${query.size ? `?${query}` : ""}`);
  }
  return (
    <Suspense
      fallback={
        <main className="oc-page" role="status">
          正在读取 AI 任务…
        </main>
      }
    >
      <AiTaskWorkspace />
    </Suspense>
  );
}
