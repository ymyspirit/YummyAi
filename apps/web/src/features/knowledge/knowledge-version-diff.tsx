import {
  KNOWLEDGE_TOPICS,
  type KnowledgeEntry,
  type KnowledgeFields,
  type KnowledgeWorkspace,
} from "@yummyai/contracts/knowledge";
type Version = KnowledgeEntry["latest"];
const fields = [
  ["title", "标题"],
  ["summary", "摘要"],
  ["body", "正文"],
  ["topic", "主题"],
  ["platform", "适用平台"],
  ["market", "适用站点"],
  ["spuId", "适用商品"],
  ["sourceType", "来源类型"],
  ["sourceLabel", "来源名称"],
  ["sourceUrl", "原文地址"],
  ["owner", "负责人"],
  ["verifiedOn", "核对日期"],
  ["reviewDueOn", "复查日期"],
  ["tags", "标签"],
  ["documentIds", "关联原资料"],
  ["sourceSnapshotIds", "官方来源证据版本"],
  ["claims", "关键主张与适用条件"],
] as const satisfies readonly (readonly [keyof KnowledgeFields, string])[];

export function KnowledgeVersionDiff({
  before,
  after,
  spus,
}: {
  before: Version | null;
  after: Version;
  spus: KnowledgeWorkspace["spus"];
}) {
  const changed = fields.filter(
    ([key]) => !before || JSON.stringify(before[key]) !== JSON.stringify(after[key]),
  );
  function display(version: Version, key: keyof KnowledgeFields): string {
    if (key === "topic") return KNOWLEDGE_TOPICS[version.topic];
    if (key === "platform")
      return { all: "全部平台", amazon: "Amazon", etsy: "Etsy" }[version.platform];
    if (key === "market") return version.market === "ALL" ? "全部站点" : version.market;
    if (key === "sourceType")
      return { official: "官方资料", team: "团队 SOP", case: "复盘案例" }[version.sourceType];
    if (key === "spuId")
      return version.spuId
        ? (spus.find((spu) => spu.id === version.spuId)?.code ?? "指定商品")
        : "全部商品";
    if (key === "tags") return version.tags.join(" · ") || "未填写";
    if (key === "documentIds" || key === "sourceSnapshotIds" || key === "claims")
      return JSON.stringify(version[key] ?? [], null, 2);
    return String(version[key] ?? "") || "未填写";
  }
  return (
    <section className="kb-diff" aria-label="知识版本差异">
      <p className="kb-meta">
        {before
          ? `V${before.version} → V${after.version} · ${changed.length} 个字段有变化`
          : `暂无可比较的历史版本 · 请核对 V${after.version} 的完整内容`}
      </p>
      {!changed.length && <p className="kb-meta">知识内容和适用范围未变化，请核对本次修订说明。</p>}
      <dl className="kb-diff-fields">
        {changed.map(([key, label]) => (
          <div key={key}>
            <dt>{label}</dt>
            <dd className={`kb-diff-values${before ? "" : " kb-diff-first"}`}>
              {before && (
                <p className="kb-diff-value">
                  <strong>原版本 V{before.version}</strong>
                  {"\n"}
                  {display(before, key)}
                </p>
              )}
              <p className="kb-diff-value">
                <strong>本次版本 V{after.version}</strong>
                {"\n"}
                {display(after, key)}
              </p>
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
