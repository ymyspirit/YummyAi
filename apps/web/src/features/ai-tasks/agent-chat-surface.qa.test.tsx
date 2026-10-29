import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AgentChatSurface, type AgentChatSurfaceProps } from "./agent-chat-surface";

function render(overrides: Partial<AgentChatSurfaceProps> = {}) {
  const props: AgentChatSurfaceProps = {
    history: [],
    selectedId: null,
    onSelect: vi.fn(),
    onNew: vi.fn(),
    messages: [],
    draft: "",
    onDraftChange: vi.fn(),
    onSend: vi.fn(),
    busy: false,
    canSend: true,
    connection: "idle",
    models: [],
    modelId: "",
    onModelChange: vi.fn(),
    ...overrides,
  };
  return { html: renderToStaticMarkup(<AgentChatSurface {...props} />), props };
}

describe("Agent conversation presentation boundaries", () => {
  it("keeps missing usage and cost unknown instead of fabricating a zero total", () => {
    const { html } = render({
      messages: [
        {
          id: "reply-unknown",
          role: "assistant",
          text: "已读取资料",
          state: "complete",
          usage: { inputTokens: null, outputTokens: null, totalTokens: null, costUsd: null },
        },
      ],
    });
    expect(html).toContain("用量 未知 tokens");
    expect(html).toContain("待核对");
    expect(html).not.toContain("用量 0 tokens");
    expect(html).not.toContain("$0");
  });

  it("shows the provider total and exact cost without adding token categories again", () => {
    const { html } = render({
      messages: [
        {
          id: "reply-known",
          role: "assistant",
          text: "核对完成",
          state: "complete",
          usage: { inputTokens: 1200, outputTokens: 300, totalTokens: 1500, costUsd: "0.00540000" },
        },
      ],
    });
    expect(html).toContain("用量 1,500 tokens");
    expect(html).toContain("0.00540000");
    expect(html).not.toContain("3,000");
  });

  it("keeps an explicitly reported zero distinct from an unknown usage receipt", () => {
    const { html } = render({
      messages: [
        {
          id: "reply-zero",
          role: "assistant",
          text: "无模型调用",
          state: "complete",
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: "0.00000000" },
        },
      ],
    });
    expect(html).toContain("用量 0 tokens");
    expect(html).toContain("0.00000000");
    expect(html).not.toContain("待核对");
  });

  it("escapes model and user content instead of executing markup or creating invented actions", () => {
    const untrusted = '<script>window.privateData()</script><img src=x onerror="steal()">';
    const { html } = render({
      messages: [
        { id: "user-html", role: "user", text: untrusted, state: "complete" },
        { id: "model-html", role: "assistant", text: untrusted, state: "complete" },
      ],
    });
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x");
    expect(html.match(/&lt;script&gt;/g)).toHaveLength(2);
    expect(html).toContain("&lt;img src=x");
  });

  it("offers a separate stop control only for an actually busy task", () => {
    const stopping = render({
      busy: true,
      connection: "streaming",
      onStop: vi.fn(),
      draft: "下一项要求",
    });
    expect(stopping.html).toContain("正在接收回复");
    expect(stopping.html).toContain("停止任务");
    expect(stopping.html).not.toContain('type="submit"');
    const idle = render({ busy: false, connection: "idle", onStop: vi.fn(), draft: "下一项要求" });
    expect(idle.html).not.toContain("停止任务");
    expect(idle.html).not.toContain("正在接收回复");
    expect(idle.html).toContain('type="submit"');
  });

  it("labels stream failure recovery as reading the original task and never sends during render", () => {
    const { html, props } = render({
      error: "连接已中断 原任务可能仍在运行",
      onRetryRead: vi.fn(),
      canSend: false,
      messages: [{ id: "partial", role: "assistant", text: "已收到的部分回复", state: "failed" }],
    });
    expect(html).toContain("读取原任务");
    expect(html).toContain("已收到的部分回复");
    expect(html).not.toContain("重新生成");
    expect(html).not.toContain("重发请求");
    expect(props.onSend).not.toHaveBeenCalled();
    expect(props.onRetryRead).not.toHaveBeenCalled();
  });

  it("disables sending while busy, unauthorized or without a substantive draft", () => {
    for (const scenario of [
      { busy: false, canSend: false, draft: "读取订单" },
      { busy: false, canSend: true, draft: "  \n " },
      { busy: true, canSend: true, draft: "读取订单" },
    ]) {
      const { html } = render(scenario);
      expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled=""/);
    }
  });

  it("keeps processing details collapsed and separates a partial draft from a final reply", () => {
    const { html } = render({
      busy: true,
      messages: [
        {
          id: "live",
          role: "assistant",
          text: "正在核对",
          state: "streaming",
          steps: [
            { id: "read-1", label: "读取订单资料", state: "running", detail: "只读取已授权的订单" },
          ],
        },
      ],
    });
    expect(html).toContain('data-state="streaming"');
    expect(html).toContain("回复中");
    expect(html).toContain("正在处理业务资料");
    expect(html).toMatch(/<details class="agent-chat-tools">/);
    expect(html).not.toMatch(/<details class="agent-chat-tools"[^>]*\bopen/);
    expect(html).not.toContain("审核通过");
  });
});
