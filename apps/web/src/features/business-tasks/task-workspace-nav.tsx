import Link from "next/link";
import { ListChecks, Sparkles } from "lucide-react";

export function TaskWorkspaceNav({ current }: { current: "business" | "analysis" }) {
  return <nav className="at-workspace-nav" aria-label="任务工作台">
    <Link href="/business-tasks" aria-current={current === "business" ? "page" : undefined}><ListChecks size={16} aria-hidden="true" />业务任务</Link>
    <Link href="/ai-tasks" aria-current={current === "analysis" ? "page" : undefined}><Sparkles size={16} aria-hidden="true" />AI 分析任务</Link>
  </nav>;
}
