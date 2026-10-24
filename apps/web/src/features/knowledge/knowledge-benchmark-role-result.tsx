"use client";
import type { ReactNode } from "react";
import type { AssistResult } from "@yummyai/contracts/ai/assist";
import type { BusinessBenchmarkCase, BenchmarkCase } from "@yummyai/contracts/knowledge/benchmark";

export const benchmarkRoleNames = {
  knowledge_answer: "知识问答", procurement_review: "采购分析", business_review: "经营分析",
  creative: "创意方向", order_review: "订单核对", artwork_preflight: "制图预检",
  template_config: "模板配置", sku_package: "SKU 素材包", after_sales_review: "售后分析",
} satisfies Record<BenchmarkCase["role"], string>;
function Pair({ label, children }: { label: string; children: ReactNode }) { return <div><dt>{label}</dt><dd>{children}</dd></div>; }
function Evidence({ value }: { value: AssistResult["actions"][number]["evidence"] }) {
  return value.length ? <ul className="kb-benchmark-evidence" aria-label="原结果证据">{value.map((evidence, index) => <li key={index}><code>{evidence.sourceId}</code> · {evidence.detail}</li>)}</ul>
    : <p className="kb-meta">本项未保存证据引用 不补造来源</p>;
}
const modes = { fixed: "固定印花", personalized_text: "文字定制", customer_image: "图片定制", mixed: "图文定制" };
function Requirements({ value }: { value: AssistResult["directions"][number]["requirements"] }) {
  return <dl className="kb-benchmark-pairs"><Pair label="定制方式">{modes[value.mode]}</Pair><Pair label="目标人群">{value.audience || "原值为空"}</Pair>
    <Pair label="使用场景">{value.occasion || "原值为空"}</Pair><Pair label="风格">{value.style || "原值为空"}</Pair>
    <Pair label="固定元素">{value.fixedElements || "原值为空"}</Pair><Pair label="图片要求">{value.imageInstructions || "原值为空"}</Pair><Pair label="验收要求">{value.acceptance || "原值为空"}</Pair></dl>;
}
export function BenchmarkBusinessTaskView({ task }: { task: BusinessBenchmarkCase["task"] }) {
  return <section className="kb-benchmark-section" aria-label="已固定的真实业务任务"><h4>已固定的真实业务任务 · {benchmarkRoleNames[task.kind]}</h4>
    <dl className="kb-benchmark-pairs">
      {task.kind === "procurement_review" && <><Pair label="原库存品"><code>{task.stockItemId}</code></Pair><Pair label="原库位"><code>{task.locationId}</code></Pair></>}
      {task.kind === "business_review" && <><Pair label="原利润计算"><code>{task.runId}</code></Pair><Pair label="原比较计算">{task.comparisonRunId ? <code>{task.comparisonRunId}</code> : "未选择比较计算"}</Pair></>}
      {(task.kind === "order_review" || task.kind === "artwork_preflight") && <><Pair label="原订单行"><code>{task.orderLineId}</code></Pair><Pair label="原订单修订">{task.expectedRevision}</Pair>
        {task.kind === "order_review" ? <Pair label="原来源版本">{task.expectedSourceVersionId ? <code>{task.expectedSourceVersionId}</code> : "原提交未固定来源版本"}</Pair>
          : <Pair label="原生产稿版本"><code>{task.expectedEditorVersionId}</code></Pair>}</>}
      {task.kind === "creative" && <><Pair label="原创意项目">{task.projectId ? <code>{task.projectId}</code> : "原项目引用缺失 不猜测其他项目"}</Pair><Pair label="原分析作用域"><code>{task.scopeId}</code></Pair></>}
      {task.kind === "template_config" && <Pair label="原模板解析"><code>{task.inspectionId}</code></Pair>}
      {task.kind === "sku_package" && <><Pair label="原 Listing"><code>{task.listingId}</code></Pair><Pair label="原 Listing 版本"><code>{task.expectedVersionId}</code></Pair></>}
      {task.kind === "after_sales_review" && <><Pair label="原售后单"><code>{task.caseId}</code></Pair><Pair label="原回复语言">{task.locale}</Pair><Pair label="原补充说明">{task.contextNotes || "原值为空"}</Pair></>}
      <Pair label="固定分析重点">{task.taskGoal || "未额外指定"}</Pair><Pair label="原任务指纹"><code>{task.expectedTaskFingerprint}</code></Pair>
      {"expectedFingerprint" in task && <Pair label="原业务数据包指纹"><code>{task.expectedFingerprint}</code></Pair>}
      {task.salesPlan && <Pair label="原销售计划"><code>{task.salesPlan.id}</code> · 修订 {task.salesPlan.revision}</Pair>}
    </dl>
    {task.kind === "creative" && <details className="kb-benchmark-details"><summary>原创意提示词 需求与研究版本</summary><p className="kb-benchmark-verbatim">{task.prompt || "原提示词为空"}</p>
      <Requirements value={task.requirements} /><ul>{task.sources.map((source, index) => <li key={index}>原研究项 <code>{source.researchItemId}</code><br />原快照 <code>{source.snapshotId}</code>
        {source.studyRevisionId && <p>原研究修订 <code>{source.studyRevisionId}</code></p>}</li>)}</ul>
      <p>原需求研究 ID</p><ul>{task.requirements.researchItemIds.map(id => <li key={id}><code>{id}</code></li>)}</ul><p>原规格版本</p><ul>{task.requirements.specificationVersionIds.map(id => <li key={id}><code>{id}</code></li>)}</ul>
      <p>原定制字段版本 {task.requirements.customization.version}</p><ul>{task.requirements.customization.fields.map(field => <li key={field.key}>{field.key} · {field.label} · {field.type} · {field.required ? "必填" : "选填"}</li>)}</ul>
      <ul>{task.requirements.layout.map((placement, index) => <li key={index}>{placement.fieldKey} · {placement.surface ?? "原值未指定面"} · X {placement.xPercent}% · Y {placement.yPercent}% · 宽 {placement.widthPercent}% · 高 {placement.heightPercent}% · {placement.color}</li>)}</ul>
    </details>}
    {task.kind === "artwork_preflight" && <p className="kb-warning">本题为一般制图预检 不执行严格生产自动审核 不能替代原制造版本 规则快照 实测与人工审批</p>}
    {task.kind === "template_config" && <p className="kb-warning">模板解析结构不等于 PSD 像素检查 本题不确认模板或写入图层</p>}
    {task.kind === "after_sales_review" && <p className="kb-meta">按原任务语言核对草稿 不自动改成中文 不发送消息 不执行退款或补发</p>}
    <p className="kb-meta">指纹分别标识任务与业务数据包 原对象或资料变化后停止新尝试 不以当前资料自动改绑旧样本</p>
  </section>;
}
export function BenchmarkRoleResult({ result, ruleBaseline = false }: { result: AssistResult; ruleBaseline?: boolean }) {
  return <section className="kb-benchmark-section kb-benchmark-role-result" aria-label="原业务建议与文本核验边界">
    <h4>原业务建议</h4>
    {ruleBaseline && <p className="kb-warning">规则只摘录固定事实和缺项 未查看图片 不补造创意方向或视觉结论 原结构硬失败保持可见</p>}
    {!result.directions.length && !result.matches.length && !result.templateSlots.length && !result.listingCopy && !result.replyDraft && <p className="kb-meta">原结果没有专用结构化建议</p>}
    {result.directions.length > 0 && <section aria-label="原创意方向"><h4>原创意方向 · {result.directions.length} 项</h4>
      {result.directions.length ? result.directions.map((direction, index) => <details className="kb-benchmark-details" key={index}><summary>方向 {index + 1} · {direction.title}</summary>
        <p>{direction.rationale}</p><dl className="kb-benchmark-pairs"><Pair label="原提示词"><span className="kb-benchmark-verbatim">{direction.prompt}</span></Pair><Pair label="原负向提示词"><span className="kb-benchmark-verbatim">{direction.negativePrompt || "原值为空"}</span></Pair></dl>
        <Requirements value={direction.requirements} /><h4>原建议字段 · {direction.fields.length} 项</h4><ul>{direction.fields.map(field => <li key={field.key}><strong>{field.label}</strong><dl className="kb-benchmark-pairs">
          <Pair label="稳定键"><code>{field.key}</code></Pair><Pair label="类型">{{ short_text: "短文本", long_text: "长文本", image: "图片" }[field.type]}</Pair><Pair label="填写要求">{field.required ? "必填" : "选填"}</Pair><Pair label="长度上限">{field.maxLength === null ? "原值未指定" : field.maxLength}</Pair><Pair label="原填写说明">{field.helpText || "原值为空"}</Pair></dl></li>)}</ul><Evidence value={direction.evidence} />
      </details>) : <p className="kb-meta">原结果没有创意方向 不补造三个方向使规则通过</p>}
    </section>}
    {result.matches.length > 0 && <section aria-label="原匹配建议"><h4>原匹配建议 · {result.matches.length} 项</h4>{result.matches.length ? <ol>{result.matches.map((match, index) => <li key={index}><dl className="kb-benchmark-pairs"><Pair label="原图案版本"><code>{match.artworkVersionId}</code></Pair><Pair label="原规格版本"><code>{match.specificationVersionId}</code></Pair></dl><p>{match.reason}</p><Evidence value={match.evidence} /></li>)}</ol> : <p className="kb-meta">原结果没有匹配建议</p>}</section>}
    {result.templateSlots.length > 0 && <section aria-label="原模板图层建议"><h4>原模板图层建议 · {result.templateSlots.length} 项</h4>{result.templateSlots.length ? result.templateSlots.map((slot, index) => <details className="kb-benchmark-details" key={index}><summary>{slot.name} · {slot.stableKey}</summary>
      <dl className="kb-benchmark-pairs"><Pair label="图层类型">{{ image: "图片", text: "文字", decoration: "装饰", background: "背景" }[slot.kind]}</Pair><Pair label="原填充方式">{{ contain: "完整包含", cover: "覆盖", stretch: "拉伸", tile: "平铺", none: "不填充" }[slot.fillMode]}</Pair>
        <Pair label="是否可替换">{slot.replaceable ? "原建议可替换" : "原建议不可替换"}</Pair><Pair label="原字段键">{slot.fieldKey ?? "未指定"}</Pair><Pair label="原复用名称">{slot.reuseLabel ?? "未指定"}</Pair><Pair label="原理由">{slot.reason || "原值为空"}</Pair></dl><Evidence value={slot.evidence} /></details>) : <p className="kb-meta">原结果没有模板图层建议 不把结构建议当作像素检查</p>}</section>}
    {result.listingCopy && <section aria-label="原 Listing 文案"><h4>原 Listing 文案</h4>{result.listingCopy ? <><dl className="kb-benchmark-pairs"><Pair label="原标题">{result.listingCopy.title}</Pair><Pair label="原描述"><span className="kb-benchmark-verbatim">{result.listingCopy.description}</span></Pair><Pair label="原定制说明">{result.listingCopy.personalizationInstructions || "原值为空"}</Pair></dl>
      <h4>原要点</h4><ul>{result.listingCopy.bullets.map((bullet, index) => <li key={index}>{bullet}</li>)}</ul><h4>原标签</h4><ul>{result.listingCopy.tags.map((tag, index) => <li key={index}>{tag}</li>)}</ul><Evidence value={result.listingCopy.evidence} />
      <h4>原图片文案 · {result.listingCopy.imageDescriptions.length} 项</h4><ul>{result.listingCopy.imageDescriptions.map((image, index) => <li key={index}><code>{image.assetId}</code><p>{image.text}</p><Evidence value={image.evidence} /></li>)}</ul></> : <p className="kb-meta">原结果没有 Listing 文案</p>}</section>}
    {result.replyDraft && <section aria-label="原售后回复草稿"><h4>原售后回复草稿</h4>{result.replyDraft ? <><p>原语言 {result.replyDraft.locale}</p><p className="kb-benchmark-verbatim" lang={result.replyDraft.locale}>{result.replyDraft.body}</p><Evidence value={result.replyDraft.evidence} /></> : <p className="kb-meta">原结果没有售后回复草稿 未补写或翻译</p>}</section>}
    {result.artworkChecks.length > 0 && <section aria-label="原图像检查字段"><h4>原图像检查字段</h4><p className="kb-warning">仅保留原输出 不能据此声称本评测执行了严格生产自动审核</p><ul>{result.artworkChecks.map((check, index) => <li key={index}>{check.code} · {check.status}<p>{check.detail}</p><p>{check.action}</p><Evidence value={check.evidence} /><ul>{check.marks.map((mark, at) => <li key={at}><code>{mark.sourceId}</code> · {mark.label} · X {mark.x} Y {mark.y} 宽 {mark.width} 高 {mark.height}</li>)}</ul></li>)}</ul></section>}
    <section aria-label="原建议行动"><h4>原建议行动</h4>{result.actions.length ? <ol>{result.actions.map((action, index) => <li key={index}>
      <strong>{action.title}</strong><p>{action.detail}</p><p>优先级 {{ high: "优先核对", normal: "常规", low: "后续改进" }[action.priority]}</p><p>原来源 <code>{action.sourceId}</code></p><Evidence value={action.evidence} />
    </li>)}</ol> : <p>原结果没有建议行动 不补造业务结论</p>}</section>
    <p className="kb-warning">业务硬检查只覆盖原来源引用和已声明的文本要求 不证明财务金额语义 采购最优性 图片质量或制造合规 仍需实际人工核验</p>
    <p className="kb-meta">此处仅读取评测原结果 不采用 不生成生产图 不发送消息 不发布 不下单 付款 调账或退款</p>
  </section>;
}
