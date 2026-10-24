import Link from "next/link";
import { BookOpen, ArrowUpRight } from "lucide-react";
import type { AgentMethodSelection } from "@yummyai/contracts/harness/methods";
import "./method-evidence.css";

export function MethodEvidence({
  selection,
  preview = false,
}: {
  selection?: AgentMethodSelection | null;
  preview?: boolean;
}) {
  return (
    <section
      className="ai-method-evidence"
      aria-label={preview ? "计划采用的方法" : "本次固定的方法"}
    >
      <BookOpen size={15} aria-hidden="true" />
      <div>
        <strong>
          {selection?.mode === "published"
            ? `团队方法 v${selection.version}`
            : selection?.mode === "builtin"
              ? "内置方法"
              : "未记录方法版本"}
        </strong>
        <span>
          {selection
            ? preview
              ? "开始分析前由服务器再次核对"
              : "保留本次任务采用的版本"
            : preview
              ? "请重新读取当前依据"
              : "旧记录不能借用今天的方法批准"}
        </span>
      </div>
      {selection?.mode === "published" && (
        <Link
          href={`/knowledge/methods?method=${encodeURIComponent(selection.methodKey)}&version=${selection.version}`}
          target="_blank"
          rel="noreferrer"
        >
          查看此版本
          <ArrowUpRight size={13} aria-hidden="true" />
        </Link>
      )}
    </section>
  );
}
