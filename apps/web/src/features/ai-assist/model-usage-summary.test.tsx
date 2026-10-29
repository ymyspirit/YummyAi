import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ModelUsageSummary } from "@yummyai/contracts/ai/model-usage";
import { ModelTokenUsageLine, ModelUsageSummaryLine } from "./model-usage-summary";

describe("original model token usage", () => {
  it("keeps cached input inside the original total without adding it again", () => {
    const html = renderToStaticMarkup(<ModelTokenUsageLine usage={{
      inputTokens: 1200, outputTokens: 800, cachedInputTokens: 400, totalTokens: 2000,
      totalTokensBasis: "provider",
    }} />);
    expect(html).toContain("输入 <strong>1,200</strong>");
    expect(html).toContain("输出 <strong>800</strong>");
    expect(html).toContain("缓存输入 <strong>400</strong>");
    expect(html).toContain("合计 <strong>2,000</strong>");
    expect(html).not.toContain("2,400");
    expect(html).toContain("缓存已包含在输入中 不重复计入合计");
  });

  it("retains known legacy input while leaving absent response fields unknown", () => {
    const html = renderToStaticMarkup(<ModelTokenUsageLine usage={{ inputTokens: 1200, outputTokens: null }} />);
    expect(html).toContain("输入 <strong>1,200</strong>");
    expect(html.match(/未返回/g)).toHaveLength(3);
    expect(html).not.toContain("合计 <strong>1,200</strong>");
  });

  it("preserves reported zero and the server's reported-components basis", () => {
    const html = renderToStaticMarkup(<ModelTokenUsageLine usage={{
      inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, totalTokens: 0,
      totalTokensBasis: "reported_components",
    }} />);
    expect(html.match(/<strong>0<\/strong>/g)).toHaveLength(4);
    expect(html).toContain("按渠道已报告的输入与输出合计");
    expect(html).not.toContain("未返回");
  });
});

describe("server-owned cumulative model usage", () => {
  const summary: ModelUsageSummary = {
    scope: "order_design_work_item", state: "partial", callCount: 5, reportedCalls: 3, unknownCalls: 2,
    inputTokens: 1200, outputTokens: 800, cachedInputTokens: null, totalTokens: 2000,
  };

  it("labels partial ledger coverage as a known subtotal and keeps the work-item scope", () => {
    const html = renderToStaticMarkup(<ModelUsageSummaryLine summary={summary} />);
    expect(html).toContain("本件无人设计累计 Token · 已知小计");
    expect(html).toContain('data-usage-state="partial"');
    expect(html).toContain("合计 <strong>2,000</strong>");
    expect(html).toContain("缓存输入 <strong>未返回</strong>");
    expect(html).toContain("已返回 3/5 次");
    expect(html).toContain("2 次用量未返回");
  });

  it("distinguishes no submitted calls from calls that returned no usage", () => {
    const empty = renderToStaticMarkup(<ModelUsageSummaryLine summary={{ ...summary,
      scope: "order_design_run", state: "empty", callCount: 0, reportedCalls: 0, unknownCalls: 0,
      inputTokens: null, outputTokens: null, cachedInputTokens: null, totalTokens: null,
    }} />);
    expect(empty).toContain("本次无人设计累计 Token");
    expect(empty).toContain("尚未提交模型调用");
    const unknown = renderToStaticMarkup(<ModelUsageSummaryLine summary={{ ...summary,
      state: "unreported", callCount: 2, reportedCalls: 0, unknownCalls: 2,
      inputTokens: null, outputTokens: null, cachedInputTokens: null, totalTokens: null,
    }} />);
    expect(unknown).toContain("2 次用量未返回");
    expect(unknown).not.toContain("尚未提交模型调用");
    expect(unknown).not.toContain("<strong>0</strong>");
  });

  it("keeps missing historical summaries explicit without inventing call counts", () => {
    const html = renderToStaticMarkup(<ModelUsageSummaryLine />);
    expect(html).toContain("累计调用记录未返回");
    expect(html.match(/<strong>未返回<\/strong>/g)).toHaveLength(4);
    expect(html).not.toContain("0 次");
  });
});
