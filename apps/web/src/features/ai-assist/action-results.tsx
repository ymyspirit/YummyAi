"use client";
import { useState } from "react";
import Link from "next/link";
import type { AssistView } from "@yummyai/contracts/ai/assist";

export function ActionResults({ view, stale }: { view: AssistView; stale: boolean }) {
  const [reply, setReply] = useState(view.result?.replyDraft?.body ?? ""),
    [message, setMessage] = useState("");
  const source = (id: string) => view.sources.find((s) => s.id === id);
  async function copy() {
    try {
      await navigator.clipboard.writeText(reply);
      setMessage("已复制草稿，请核对后在客服渠道发送。");
    } catch {
      setMessage("无法访问剪贴板，请选中文字手动复制。");
    }
  }
  return (
    <>
      {!!view.result?.actions.length && (
        <div className="ai-action-results">
          <h4>建议行动</h4>
          <ol>
            {view.result.actions.map((a, i) => (
              <li key={i}>
                <div>
                  <strong>{a.title}</strong>
                  <span className="ai-action-priority">
                    {{ high: "优先核对", normal: "常规", low: "后续改进" }[a.priority]}
                  </span>
                </div>
                <p>{a.detail}</p>
                {a.evidence.map((e, j) => (
                  <small key={j}>
                    依据：{source(e.sourceId)?.label ?? e.sourceId} · {e.detail}
                  </small>
                ))}
                {source(a.sourceId)?.href && (
                  <Link href={source(a.sourceId)!.href!}>查看业务记录</Link>
                )}
              </li>
            ))}
          </ol>
        </div>
      )}
      {view.result?.replyDraft && (
        <div className="ai-reply-draft">
          <label>
            客服回复草稿
            <textarea
              value={reply}
              maxLength={4000}
              disabled={stale}
              onChange={(e) => setReply(e.target.value)}
            />
          </label>
          <p className="ai-assist-muted">
            核对事实、金额和交期后使用。复制不会发送消息，也不会登记为已沟通。
          </p>
          {view.result.replyDraft.evidence.map((e, i) => (
            <small key={i}>
              回复依据：{source(e.sourceId)?.label ?? e.sourceId} · {e.detail}
            </small>
          ))}
          <button type="button" disabled={stale || !reply.trim()} onClick={() => void copy()}>
            复制回复草稿
          </button>
          {message && <p role="status">{message}</p>}
        </div>
      )}
    </>
  );
}
