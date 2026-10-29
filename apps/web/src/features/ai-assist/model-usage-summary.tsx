import type { ModelTokenUsage, ModelUsageSummary } from "@yummyai/contracts/ai/model-usage";

type UsageValues = Partial<Pick<ModelTokenUsage,
  "inputTokens" | "outputTokens" | "cachedInputTokens" | "totalTokens" | "totalTokensBasis"
>>;

const metrics = [
  ["inputTokens", "输入"],
  ["outputTokens", "输出"],
  ["cachedInputTokens", "缓存输入"],
  ["totalTokens", "合计"],
] as const;

const scopeLabels: Record<ModelUsageSummary["scope"], string> = {
  assist_scope: "本类分析累计 Token",
  order_design_run: "本次无人设计累计 Token",
  order_design_work_item: "本件无人设计累计 Token",
};

function TokenValues({ usage }: { usage?: UsageValues | null }) {
  return <>{metrics.map(([key, label], index) => <span key={key}
    title={key === "cachedInputTokens" ? "缓存已包含在输入中 不重复计入合计" : key === "totalTokens" && usage?.totalTokensBasis === "reported_components" ? "按渠道已报告的输入与输出合计" : undefined}>
    {index > 0 ? " · " : ""}{label} <strong>{usage?.[key] == null ? "未返回" : usage[key].toLocaleString("zh-CN")}</strong>
  </span>)}</>;
}

/** Display the original response only; legacy missing fields remain unknown. */
export function ModelTokenUsageLine({ usage, label = "本次调用 Token", className }: {
  usage?: UsageValues | null;
  label?: string;
  className?: string;
}) {
  return <p className={className} aria-label={`${label} 用量`}>
    {label}：<TokenValues usage={usage} />
  </p>;
}

/** The server owns the complete ledger and deduplication, including calls outside this page. */
export function ModelUsageSummaryLine({ summary, label, className }: {
  summary?: ModelUsageSummary | null;
  label?: string;
  className?: string;
}) {
  const title = label ?? (summary ? scopeLabels[summary.scope] : "累计 Token");
  return <p className={className} aria-label={`${title} 用量`} data-usage-state={summary?.state ?? "unreported"}>
    {title}{summary?.state === "partial" ? " · 已知小计" : ""}：
    {summary?.state === "empty" ? "尚未提交模型调用" : <>
      <TokenValues usage={summary} />
      {summary ? <small> · 已返回 {summary.reportedCalls}/{summary.callCount} 次
        {summary.unknownCalls > 0 ? ` · ${summary.unknownCalls} 次用量未返回` : ""}</small> : <small> · 累计调用记录未返回</small>}
    </>}
  </p>;
}
