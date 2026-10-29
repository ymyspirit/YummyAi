"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  CircleAlert,
  History,
  MessageSquare,
  Plus,
  RefreshCw,
  Settings2,
  Square,
  Wrench,
} from "lucide-react";
import "./agent-chat.css";

/** UI view models only. The adapter owns wire validation and current authority. */
export interface AgentChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  state: "complete" | "streaming" | "failed" | "stopped";
  steps?: Array<{
    id: string;
    label: string;
    state: "running" | "complete" | "failed";
    detail?: string;
  }>;
  usage?: {
    inputTokens: number | null;
    outputTokens: number | null;
    totalTokens: number | null;
    costUsd: string | null;
  };
  footer?: ReactNode;
}

export interface AgentChatSurfaceProps {
  history: Array<{ id: string; title: string; detail: string; active?: boolean }>;
  historyLoading?: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  messages: AgentChatMessage[];
  messagesLoading?: boolean;
  draft: string;
  onDraftChange: (value: string) => void;
  onSend: () => void;
  onStop?: () => void;
  stopLabel?: string;
  busy: boolean;
  canSend: boolean;
  connection?: "idle" | "connecting" | "streaming" | "reconnecting";
  models: Array<{ id: string; label: string }>;
  modelId: string;
  onModelChange: (id: string) => void;
  modelDisabled?: boolean;
  configuration?: ReactNode;
  contextControl?: ReactNode;
  recovery?: ReactNode;
  error?: string;
  onRetryRead?: () => void;
  notice?: ReactNode;
  composerHint?: string;
  placeholder?: string;
  maxMessageLength?: number;
  examples?: readonly string[];
}

const number = (value: number | null) => (value === null ? "未知" : value.toLocaleString("zh-CN"));

function MessageUsage({ usage }: { usage: NonNullable<AgentChatMessage["usage"]> }) {
  return (
    <details className="agent-chat-usage">
      <summary>
        用量 {number(usage.totalTokens)} tokens
        <ChevronDown size={12} aria-hidden="true" />
      </summary>
      <dl>
        <div>
          <dt>输入 tokens</dt>
          <dd>{number(usage.inputTokens)}</dd>
        </div>
        <div>
          <dt>输出 tokens</dt>
          <dd>{number(usage.outputTokens)}</dd>
        </div>
        <div>
          <dt>费用 USD</dt>
          <dd>{usage.costUsd ?? "待核对"}</dd>
        </div>
      </dl>
    </details>
  );
}

function ToolSteps({ steps }: { steps: NonNullable<AgentChatMessage["steps"]> }) {
  const pending = steps.some((step) => step.state === "running");
  return (
    <details className="agent-chat-tools">
      <summary>
        <Wrench size={14} aria-hidden="true" />
        {pending ? "正在处理业务资料" : "查看处理过程"}
        <span>{steps.length} 项</span>
        <ChevronDown size={14} aria-hidden="true" />
      </summary>
      <ol>
        {steps.map((step) => (
          <li key={step.id} data-state={step.state}>
            {step.state === "complete" ? (
              <Check size={14} aria-hidden="true" />
            ) : step.state === "failed" ? (
              <CircleAlert size={14} aria-hidden="true" />
            ) : (
              <span className="agent-chat-progress-dot" aria-hidden="true" />
            )}
            <div>
              <strong>{step.label}</strong>
              {step.detail && <p>{step.detail}</p>}
            </div>
          </li>
        ))}
      </ol>
    </details>
  );
}

export function AgentChatSurface(props: AgentChatSurfaceProps) {
  const historyId = useId();
  const composerId = useId();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [following, setFollowing] = useState(true);
  const followingRef = useRef(true);
  const viewport = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const tail = props.messages.at(-1);

  // Follow real received content only while the operator remains near the end.
  useEffect(() => {
    if (!followingRef.current || !viewport.current) return;
    viewport.current.scrollTop = viewport.current.scrollHeight;
  }, [props.selectedId, props.messages.length, tail?.text, tail?.steps?.length, props.busy]);

  function followLatest() {
    followingRef.current = true;
    setFollowing(true);
    if (viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight;
  }

  const connectionText =
    props.connection === "reconnecting"
      ? "连接已断开 正在读取原任务"
      : props.connection === "streaming"
        ? "正在接收回复"
        : props.connection === "connecting"
          ? "正在连接任务"
          : props.busy
            ? "任务正在执行"
            : "";
  const sendEnabled = props.canSend && !props.busy && props.draft.trim().length > 0;

  return (
    <section className="agent-chat" aria-label="AI Agent 对话工作台">
      <aside className="agent-chat-history" aria-label="任务对话记录">
        <header>
          <h2>
            <History size={15} aria-hidden="true" />
            任务对话
          </h2>
          <button
            type="button"
            className="agent-chat-icon"
            onClick={props.onNew}
            aria-label="新建对话"
            disabled={props.busy}
          >
            <Plus size={17} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="agent-chat-history-toggle agent-chat-icon"
            aria-expanded={historyOpen}
            aria-controls={historyId}
            aria-label={historyOpen ? "收起对话记录" : "展开对话记录"}
            onClick={() => setHistoryOpen(!historyOpen)}
          >
            <ChevronDown size={17} aria-hidden="true" />
          </button>
        </header>
        <div id={historyId} className="agent-chat-history-body" data-open={historyOpen}>
          <div>
            {props.historyLoading ? (
              <p className="agent-chat-muted" role="status">
                正在读取对话记录
              </p>
            ) : props.history.length ? (
              <nav aria-label="选择任务对话">
                {props.history.map((item) => (
                  <button
                    type="button"
                    key={item.id}
                    aria-current={props.selectedId === item.id ? "true" : undefined}
                    disabled={props.busy && props.selectedId !== item.id}
                    onClick={() => {
                      props.onSelect(item.id);
                      setHistoryOpen(false);
                      followLatest();
                    }}
                  >
                    <span>{item.title}</span>
                    <small>
                      {item.active && (
                        <span className="agent-chat-progress-dot" aria-hidden="true" />
                      )}
                      {item.detail}
                    </small>
                  </button>
                ))}
              </nav>
            ) : (
              <p className="agent-chat-muted">从右侧开始一个任务</p>
            )}
          </div>
        </div>
      </aside>

      <div className="agent-chat-main">
        <header className="agent-chat-heading">
          <div>
            <h2>
              <MessageSquare size={17} aria-hidden="true" />
              AI Agent
            </h2>
            <p>描述任务 继续补充要求 在同一处跟进结果</p>
          </div>
          <a href="/model-billing">模型费用核对</a>
        </header>
        {props.notice && <div className="agent-chat-notice">{props.notice}</div>}
        <div
          ref={viewport}
          className="agent-chat-messages"
          role="log"
          aria-label="任务对话内容"
          aria-live="off"
          aria-busy={props.busy || props.messagesLoading}
          onScroll={() => {
            const element = viewport.current;
            if (!element) return;
            const next = element.scrollHeight - element.scrollTop - element.clientHeight < 90;
            followingRef.current = next;
            setFollowing(next);
          }}
        >
          {props.messagesLoading ? (
            <p className="agent-chat-reading" role="status">
              正在读取原任务与回复
            </p>
          ) : props.messages.length ? (
            props.messages.map((message) => (
              <article
                key={message.id}
                className="agent-chat-message"
                data-role={message.role}
                data-state={message.state}
                aria-label={message.role === "user" ? "我的要求" : "Agent 回复"}
              >
                <header>
                  {message.role === "user" ? "你" : "Agent"}
                  {message.state === "streaming" && <span>回复中</span>}
                  {message.state === "stopped" && <span>已停止</span>}
                  {message.state === "failed" && <span>需要处理</span>}
                </header>
                {Boolean(message.steps?.length) && <ToolSteps steps={message.steps!} />}
                {message.text && <div className="agent-chat-message-text">{message.text}</div>}
                {!message.text && message.state === "streaming" && (
                  <p className="agent-chat-muted">正在等待模型返回内容</p>
                )}
                {message.footer && (
                  <div className="agent-chat-message-footer">{message.footer}</div>
                )}
                {message.usage && <MessageUsage usage={message.usage} />}
              </article>
            ))
          ) : (
            <div className="agent-chat-empty">
              <MessageSquare size={27} aria-hidden="true" />
              <h3>你要处理什么业务</h3>
              <p>直接描述目标 需要补充的资料会显示在对话里</p>
              {Boolean(props.examples?.length) && (
                <div className="agent-chat-examples">
                  {props.examples!.map((example) => (
                    <button
                      type="button"
                      key={example}
                      disabled={props.busy}
                      onClick={() => {
                        props.onDraftChange(example);
                        input.current?.focus();
                      }}
                    >
                      {example}
                      <ArrowUp size={14} aria-hidden="true" />
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
        {!following && props.messages.length > 0 && (
          <button type="button" className="agent-chat-follow" onClick={followLatest}>
            <ArrowDown size={14} aria-hidden="true" />
            查看最新回复
          </button>
        )}
        {connectionText && (
          <p className="agent-chat-connection" role="status">
            <span className="agent-chat-progress-dot" aria-hidden="true" />
            {connectionText}
          </p>
        )}
        {props.error && (
          <div className="agent-chat-error" role="alert">
            <CircleAlert size={16} aria-hidden="true" />
            <p>{props.error}</p>
            {props.onRetryRead && (
              <button type="button" onClick={props.onRetryRead}>
                <RefreshCw size={14} aria-hidden="true" />
                读取原任务
              </button>
            )}
          </div>
        )}
        {props.recovery}
        <form
          className="agent-chat-composer"
          onSubmit={(event) => {
            event.preventDefault();
            if (sendEnabled) props.onSend();
          }}
        >
          {props.contextControl && <div className="agent-chat-context">{props.contextControl}</div>}
          <label className="agent-chat-sr-only" htmlFor={composerId}>
            给 Agent 的要求
          </label>
          <textarea
            id={composerId}
            ref={input}
            rows={3}
            maxLength={props.maxMessageLength ?? 2000}
            value={props.draft}
            onChange={(event) => props.onDraftChange(event.target.value)}
            placeholder={props.placeholder ?? "描述你的任务 或继续补充要求"}
            onKeyDown={(event) => {
              if (
                event.key !== "Enter" ||
                event.shiftKey ||
                event.nativeEvent.isComposing ||
                event.keyCode === 229
              )
                return;
              event.preventDefault();
              if (sendEnabled) props.onSend();
            }}
          />
          <div className="agent-chat-composer-actions">
            <label className="agent-chat-model">
              <span className="agent-chat-sr-only">对话模型</span>
              <select
                aria-label="对话模型"
                value={props.modelId}
                disabled={props.modelDisabled || props.busy || !props.models.length}
                onChange={(event) => props.onModelChange(event.target.value)}
              >
                <option value="">{props.models.length ? "选择模型" : "暂无可用模型"}</option>
                {props.models.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.label}
                  </option>
                ))}
              </select>
            </label>
            {props.configuration && (
              <details className="agent-chat-settings">
                <summary>
                  <Settings2 size={15} aria-hidden="true" />
                  任务设置
                </summary>
                <div>{props.configuration}</div>
              </details>
            )}
            {props.busy && props.onStop ? (
              <button className="agent-chat-stop" type="button" onClick={props.onStop}>
                <Square size={13} aria-hidden="true" />
                {props.stopLabel ?? "停止任务"}
              </button>
            ) : (
              <button className="agent-chat-send" type="submit" disabled={!sendEnabled}>
                <ArrowUp size={16} aria-hidden="true" />
                发送
              </button>
            )}
          </div>
        </form>
        <p className="agent-chat-composer-hint">
          {props.composerHint ?? "Enter 发送 · Shift + Enter 换行"}
        </p>
      </div>
    </section>
  );
}
