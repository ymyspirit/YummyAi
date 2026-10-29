"use client";

import Link from "next/link";
import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { ArrowRight, Settings2 } from "lucide-react";
import { AgentChatWorkbench } from "./agent-chat-workbench";
import { AiTaskWorkspace } from "./ai-task-workspace";
import "./agent-workspace-entry.css";

/** Existing protocol links remain in their original owner and form. */
export function AgentWorkspaceEntry() {
  const search = useSearchParams();
  const [opened, setOpened] = useState(false);
  const legacy = [...search.keys()].some((key) => key !== "chat");
  if (legacy) return <AiTaskWorkspace />;
  return (
    <div className="agent-workspace-entry">
      <header className="agent-workspace-heading">
        <div>
          <h1>AI 任务工作台</h1>
          <p>直接提问 连续追问 查看来源与实际用量</p>
        </div>
        <nav aria-label="业务处理入口">
          <Link href="/orders">
            订单中心
            <ArrowRight size={14} aria-hidden="true" />
          </Link>
          <Link href="/business-tasks">
            业务任务
            <ArrowRight size={14} aria-hidden="true" />
          </Link>
        </nav>
      </header>
      <AgentChatWorkbench />
      <details
        className="agent-workspace-advanced"
        onToggle={(event) => {
          if (event.currentTarget.open) setOpened(true);
        }}
      >
        <summary>
          <Settings2 size={15} aria-hidden="true" />
          业务分析与高级工具<span>查看原任务 工具配置与履约建议</span>
        </summary>
        {opened && <AiTaskWorkspace />}
      </details>
    </div>
  );
}
