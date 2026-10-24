import { Suspense } from "react";
import { BusinessTaskWorkspace } from "../../../features/business-tasks/business-task-workspace";

export const metadata = { title: "业务任务 · YummyAI" };

export default function Page() {
  return <Suspense fallback={<main className="ai-task-workspace" role="status">正在读取业务任务…</main>}>
    <BusinessTaskWorkspace />
  </Suspense>;
}
