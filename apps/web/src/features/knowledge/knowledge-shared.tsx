"use client";
import Link from "next/link";
import type { AssistView } from "@yummyai/contracts/ai/assist";
import { knowledgeReferenceHref } from "./knowledge-reference";
import {
  KNOWLEDGE_TOPICS,
  type KnowledgeFields,
  type KnowledgeSearch,
  type KnowledgeWorkspace,
} from "@yummyai/contracts/knowledge";
export function knowledgeBlankFields(): KnowledgeFields {
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" });
  return {
    title: "",
    summary: "",
    body: "待从原资料提取",
    topic: "operations",
    platform: "all",
    market: "ALL",
    spuId: null,
    sourceType: "team",
    sourceLabel: "",
    sourceUrl: "",
    owner: "",
    verifiedOn: day.format(new Date()),
    reviewDueOn: day.format(new Date(Date.now() + 90 * 86400_000)),
    tags: [],
  };
}
export function KnowledgeScopeForm({
  value,
  onChange,
  spus,
}: {
  value: KnowledgeSearch;
  onChange: (v: KnowledgeSearch) => void;
  spus: KnowledgeWorkspace["spus"];
}) {
  return (
    <div className="kb-form-grid">
      <label>
        主题
        <select
          aria-label="主题"
          value={value.topic}
          onChange={(e) =>
            onChange({ ...value, topic: e.target.value as KnowledgeSearch["topic"] })
          }
        >
          <option value="all">全部主题</option>
          {Object.entries(KNOWLEDGE_TOPICS).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      </label>
      <label>
        平台
        <select
          aria-label="平台"
          value={value.platform}
          onChange={(e) =>
            onChange({ ...value, platform: e.target.value as KnowledgeSearch["platform"] })
          }
        >
          <option value="all">通用知识</option>
          <option value="amazon">Amazon</option>
          <option value="etsy">Etsy</option>
        </select>
      </label>
      <label>
        站点
        <input
          value={value.market}
          maxLength={3}
          placeholder="US / GB / ALL"
          onChange={(e) => onChange({ ...value, market: e.target.value.toUpperCase() })}
        />
      </label>
      <label>
        产品
        <select
          aria-label="产品"
          value={value.spuIds[0] ?? ""}
          onChange={(e) => onChange({ ...value, spuIds: e.target.value ? [e.target.value] : [] })}
        >
          <option value="">通用知识</option>
          {spus.map((s) => (
            <option key={s.id} value={s.id}>
              {s.code} · {s.name}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
export function KnowledgeMetadataForm({
  value,
  onChange,
  spus,
}: {
  value: KnowledgeFields;
  onChange: (v: KnowledgeFields) => void;
  spus: KnowledgeWorkspace["spus"];
}) {
  const set = <K extends keyof KnowledgeFields>(key: K, v: KnowledgeFields[K]) =>
    onChange({ ...value, [key]: v });
  return (
    <div className="kb-form-grid">
      <label>
        资料标题
        <input
          required
          maxLength={180}
          value={value.title}
          onChange={(e) => set("title", e.target.value)}
        />
      </label>
      <label>
        负责人
        <input
          required
          maxLength={100}
          value={value.owner}
          onChange={(e) => set("owner", e.target.value)}
        />
      </label>
      <label>
        主题
        <select
          aria-label="主题"
          value={value.topic}
          onChange={(e) => set("topic", e.target.value as KnowledgeFields["topic"])}
        >
          {Object.entries(KNOWLEDGE_TOPICS).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      </label>
      <label>
        平台
        <select
          aria-label="平台"
          value={value.platform}
          onChange={(e) => set("platform", e.target.value as KnowledgeFields["platform"])}
        >
          <option value="all">全部平台</option>
          <option value="amazon">Amazon</option>
          <option value="etsy">Etsy</option>
        </select>
      </label>
      <label>
        站点
        <input
          required
          maxLength={3}
          value={value.market}
          onChange={(e) => set("market", e.target.value.toUpperCase())}
        />
      </label>
      <label>
        产品
        <select
          aria-label="产品"
          value={value.spuId ?? ""}
          onChange={(e) => set("spuId", e.target.value || null)}
        >
          <option value="">全部产品</option>
          {spus.map((s) => (
            <option key={s.id} value={s.id}>
              {s.code} · {s.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        来源类型
        <select
          aria-label="来源类型"
          value={value.sourceType}
          onChange={(e) => set("sourceType", e.target.value as KnowledgeFields["sourceType"])}
        >
          <option value="team">团队 SOP</option>
          <option value="official">官方资料</option>
          <option value="case">复盘案例</option>
        </select>
      </label>
      <label>
        来源名称
        <input
          required
          maxLength={240}
          value={value.sourceLabel}
          onChange={(e) => set("sourceLabel", e.target.value)}
        />
      </label>
      <label>
        原文地址
        <input
          type="url"
          maxLength={2000}
          value={value.sourceUrl}
          onChange={(e) => set("sourceUrl", e.target.value)}
        />
      </label>
      <label>
        核对日期
        <input
          type="date"
          required
          value={value.verifiedOn}
          onChange={(e) => set("verifiedOn", e.target.value)}
        />
      </label>
      <label>
        证据复查日期
        <input
          type="date"
          required
          value={value.reviewDueOn}
          onChange={(e) => set("reviewDueOn", e.target.value)}
        />
      </label>
    </div>
  );
}
export function KnowledgeCardChoices({
  entries,
  value,
  onChange,
  label = "关联知识卡",
}: {
  entries: KnowledgeWorkspace["entries"];
  value: string[];
  onChange: (ids: string[]) => void;
  label?: string;
}) {
  return (
    <fieldset className="kb-choices">
      <legend>{label}</legend>
      {!entries.length ? (
        <p className="kb-meta">暂无知识卡，可以先登记需求并保留缺口。</p>
      ) : (
        entries.map((e) => (
          <label key={e.id}>
            <input
              type="checkbox"
              checked={value.includes(e.id)}
              onChange={(ev) =>
                onChange(ev.target.checked ? [...value, e.id] : value.filter((id) => id !== e.id))
              }
            />
            {e.latest.title} · {e.activeVersion ? "已启用 V" + e.activeVersion : "未发布"}
          </label>
        ))
      )}
    </fieldset>
  );
}
export function KnowledgeAnswerCost({ view }: { view: AssistView }) {
  const billing = view.invocations?.[0]?.billing;
  return <span>{billing?.amountUsd !== null && billing?.amountUsd !== undefined ?
    "原费用 $" + billing.amountUsd + " · " + (billing.basis === "configured_rate" ? "配置价格估算" : "处理服务报告") + " · 提供方账单另行核对" :
    billing?.basis === "not_submitted" ? "原调用尚未提交 不据此认定全链路费用为零" : billing?.basis === "not_applicable" ? "本步骤不适用模型费用 不代表全链路零成本" :
    view.costUsd !== null ? "历史费用值 $" + String(view.costUsd) + " · 未保留完整计价依据" : "费用未知 尚无实际费用凭据 不按零计算"}
    {billing?.reconciliation && <> · 人工核对 ${billing.reconciliation.amountUsd}（操作者声明）</>}
  </span>;
}
export function KnowledgeAnswer({ view }: { view: AssistView }) {
  const kinds = { fact: "有据事实", inference: "推断", recommendation: "建议" };
  return (
    <article className="kb-answer">
      <p className="kb-meta">
        {view.request?.kind === "knowledge_answer" ? view.request.search.query : "历史问题"} ·{" "}
        {
          view.stale ? "原依据已变化" : {
            queued: "排队中",
            running: "回答中",
            completed: "已完成",
            failed: "失败",
            cancelled: "已取消",
          }[view.status]
        }
      </p>
      {view.stale ? <p className="kb-warning" role="status">原回答的依据已变化 本次正文与固定引用已隐藏 原任务状态和费用仍保留 请按原结果核对 不自动重新付费</p>
        : view.status === "completed" && !view.result && <p className="kb-warning" role="status">原回答正文当前不可读 原任务状态和费用仍保留 不以空白内容表示回答可用</p>}
      {view.error && (
        <p className="kb-error" role="alert">
          {view.error}
        </p>
      )}
      {!view.stale && view.result && (
        <>
          <p className="kb-prose">{view.result.summary}</p>
          {view.result.findings.map((f, i) => (
            <section key={i} className="kb-finding">
              <strong>
                {f.title} <small>{kinds[f.kind]}</small>
              </strong>
              <p className="kb-prose">{f.detail}</p>
              {f.evidence.map((e, n) => {
                const ref = view.sources.find((s) => s.id === e.sourceId);
                const pinned = view.knowledge.find(item => item.sourceId === e.sourceId);
                const href = pinned ? knowledgeReferenceHref(pinned) : ref?.href;
                return (
                  <p key={n} className="kb-meta">
                    {href ? <Link href={href}>{pinned?.title ?? ref?.label ?? e.sourceId}</Link> : e.sourceId}：{e.detail}
                  </p>
                );
              })}
            </section>
          ))}
          {!!view.result.missingInformation.length && (
            <p className="kb-prose kb-warning">
              资料缺口：{view.result.missingInformation.join("；")}
            </p>
          )}
        </>
      )}
      {!view.stale && view.diagnostics.map((d, i) => (
        <p key={i} className="kb-meta">
          {d}
        </p>
      ))}
      <details>
        <summary>{view.stale ? "本次固定引用当前不可读" : `本次固定引用（${view.knowledge.length}）`}</summary>
        {!view.stale && view.knowledge.map((r) => {
          const href = knowledgeReferenceHref(r);
          return <div key={r.sourceId} className="kb-reference">
            {href ? <Link href={href}>
              {r.title} · V{r.version}
            </Link> : <span>{r.title} · 原知识版本身份无法核对</span>}
            <p className="kb-meta">
              {r.sourceLabel} · 核对 {r.verifiedOn} · 复查 {r.reviewDueOn}
            </p>
            <p className="kb-prose">{r.excerpt}</p>
          </div>;
        })}
      </details>
      <p className="kb-meta">
        模型 {view.modelLabel}（{view.model}） · 提示词 {view.promptVersion} ·{" "}
        <KnowledgeAnswerCost view={view} />
      </p>
    </article>
  );
}
