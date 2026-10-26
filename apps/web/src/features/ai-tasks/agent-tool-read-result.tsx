"use client";
import { useState, type ReactNode } from "react";
import Link from "next/link";
import { ChevronLeft, ChevronRight, FileSearch, ShieldCheck } from "lucide-react";
import type { AgentToolResult } from "@yummyai/contracts/ai/agent-tools";
import type { CreativeExecutionView } from "@yummyai/contracts/harness/creative-operator";
import type { KnowledgeSearchResult } from "@yummyai/contracts/knowledge";
import type { FactoryCapacityWorkspace } from "@yummyai/contracts/suppliers/factory-capacity";
import { AgentBalanceRows, AgentExceptionRows } from "./agent-read-tools";
import { MethodEvidence } from "../ai-assist/method-evidence";
import { capacityLocalInstant, capacityReason, capacityUnitName } from "../order-centers/production-capacity-api";
import { knowledgeReferenceHref } from "../knowledge/knowledge-reference";

const phases: Record<CreativeExecutionView["phase"], string> = {
  pending: "等待派发", preparing: "处理中", submitted: "已记录提交", response_staging: "保存原响应",
  response_ready: "原响应可恢复", completed: "技术处理完成", failed: "执行未完成", uncertain: "原提交待核对",
};
const executionKinds: Record<CreativeExecutionView["kind"], string> = {
  creative_candidate: "候选生成", creative_adaptation: "画幅适配", template_compile: "模板编译", mockup_render: "场景套图", studio_generation: "工作台生成",
};
const poolStatuses = { draft: "草稿", active: "启用", paused: "暂停", archived: "归档" };
function Pair({ label, children }: { label: string; children: ReactNode }) {
  return <div><dt>{label}</dt><dd>{children}</dd></div>;
}
function sourceLink(value: string) {
  try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : null; }
  catch { return null; }
}
export function AgentToolCoverage({ result }: { result: AgentToolResult }) {
  const range = result.coverage;
  return <div className="atb-coverage" aria-label="本次读取范围"><ShieldCheck size={15} aria-hidden="true" /><div>
    {range.kind === "paged_collection" ? <p>已读取 {range.readCount} / {range.total} · {range.complete ? "已完整读取该集合" : "尚未完整读取"}</p> :
      range.kind === "ranked_subset" ? <><p>扫描 {range.scanned} 条 · 返回排序候选 {range.returned} 条 · 最多前六条</p><p>这是相关候选 不代表知识库全量</p></> :
        range.kind === "bounded_history" ? <><p>本页 {range.returned} 条执行记录 · 每页最多二十条 · 有界历史</p><p>{range.nextCursor ? "还有更早记录 可继续读取" : "本次历史页已读完"}{range.eventsMayBeTruncated ? " · 部分执行事件仍有未返回项" : ""} 不称全量执行审计</p></> :
          <><p>工厂当地 {range.from} 起 {range.days} 天 · 返回 {range.pools} 个资源池</p><p>这是指定日期窗口 不代表工厂全部历史或未来产能</p></>}
  </div></div>;
}
export function AgentToolReadResult({ result }: { result: AgentToolResult }) {
  return <section className="atb-result" aria-label="原生工具读取结果">
    <header><h3><FileSearch size={16} aria-hidden="true" />原生工具读取结果</h3><span className="atb-badge">只读</span></header>
    <AgentToolCoverage result={result} />
    <p className="atb-muted">核对于 {result.checkedAt} · 此次读取不调用模型 不登记业务写入</p>
    {result.tool === "orders.exceptions.page" ? <><AgentExceptionRows items={result.data.items} />{!result.data.items.length && <p>本次原集合没有符合筛选的异常</p>}<Link href="/orders">进入原订单工作区核对</Link></> :
      result.tool === "inventory.balances.page" ? <><AgentBalanceRows items={result.data.items} />{!result.data.items.length && <p>本次原集合没有库存余额记录</p>}<Link href="/inventory">进入原库存工作区核对</Link></> :
        result.tool === "knowledge.search" ? <KnowledgeToolResult data={result.data} /> :
          result.tool === "creative.history" ? <><dl className="atb-pairs"><Pair label="原对象类型">{{ design_batch: "批量设计", inspection: "PSD 模板检查", mockup_batch: "批量套图", studio_generation: "工作台生成" }[result.data.scope]}</Pair><Pair label="原对象 ID"><code>{result.data.ownerId}</code></Pair></dl>
            <p className="atb-muted">执行完成仅表示技术步骤完成 不替代素材权利 生产审核或业务采用</p><ol className="atb-rows">{result.data.entries.map(entry => <CreativeToolEntry key={entry.id} entry={entry} />)}</ol>{!result.data.entries.length && <p>所选原对象当前没有已登记的执行记录</p>}</> :
            <FactoryToolResult key={result.callId} data={result.data} />}
    <details className="atb-proof"><summary>本次读取身份与校验依据</summary><dl className="atb-pairs">
      <Pair label="读取回执 ID"><code>{result.callId}</code></Pair><Pair label="原工具"><code>{result.tool}</code></Pair>
      <Pair label="定义校验值"><code>{result.definitionChecksum}</code></Pair><Pair label="本次输入校验值"><code>{result.inputChecksum}</code></Pair><Pair label="原结果校验值"><code>{result.dataChecksum}</code></Pair>
      {(result.tool === "orders.exceptions.page" || result.tool === "inventory.balances.page") && <Pair label="原集合校验值"><code>{result.data.collectionFingerprint}</code></Pair>}
    </dl><p className="atb-muted">校验依据描述此次原生读取 不证明建议正确或外部事实已验真</p></details>
  </section>;
}
export function KnowledgeToolResult({ data }: { data: KnowledgeSearchResult }) {
  return <section aria-label="知识检索候选"><p className="atb-muted">关键词检索 · 原检索时间 {data.retrievedAt} · 只展示原版本摘录</p>
    {!!data.diagnostics.length && <ul className="atb-diagnostics">{data.diagnostics.map((text, index) => <li key={index}>{text}</li>)}</ul>}
    <ol className="atb-rows">{data.references.map(reference => {
      const href = sourceLink(reference.sourceUrl);
      const fixedHref = knowledgeReferenceHref(reference);
      return <li key={reference.sourceId + ":" + reference.versionId}><h4>{reference.title} <span className="atb-badge">原版本 {reference.version}</span></h4>
        <p className="atb-prose">{reference.excerpt}</p><dl className="atb-pairs">
          <Pair label="来源">{reference.sourceLabel || "未提供"}</Pair><Pair label="核对日 / 复查日">{reference.verifiedOn} / {reference.reviewDueOn}</Pair>
          <Pair label="原知识条目"><code>{reference.entryId}</code></Pair><Pair label="原版本 ID"><code>{reference.versionId}</code></Pair>
          <Pair label="来源引用"><code>{reference.sourceId}</code></Pair><Pair label="原校验值"><code>{reference.checksum}</code></Pair>
          <Pair label="原排序分数">{reference.score}</Pair>
        </dl>{fixedHref ? <Link href={fixedHref}>核对原知识 V{reference.version}</Link> : <p className="atb-muted">原知识版本身份无法核对 未改用当前版本</p>}
        {href ? <a href={href} target="_blank" rel="noreferrer noopener">打开原来源</a> : <p className="atb-muted">未提供可打开的原来源地址</p>}</li>;
    })}</ol>{!data.references.length && <p>没有符合当前范围的知识候选 请核对关键词 主题 平台和站点</p>}
    <Link href="/knowledge">进入知识原工作区核对</Link>
  </section>;
}
export function CreativeToolEntry({ entry }: { entry: CreativeExecutionView }) {
  return <li className="atb-execution" aria-label={executionKinds[entry.kind] + "原执行"}><header><h4>{executionKinds[entry.kind]}</h4><span className="atb-badge" data-state={entry.phase}>{phases[entry.phase]}</span></header>
    <p>服务报告费用 {entry.cost.basis === "processor_reported" ? `${entry.cost.amountUsd} USD · 尚未核对渠道账单` : entry.cost.basis === "unknown" ? "未知 不能按零处理" : entry.cost.basis === "not_submitted" ? "尚未提交渠道" : "本步骤无外部调用"}</p>
    {entry.cost.budgetAmountUsd !== null && <p className="atb-muted">原预算账本 {entry.cost.budgetAmountUsd} USD · {entry.cost.budgetState === null ? "账本状态未保留" : { reserved: "已预留", committed: "已记账", released: "已释放" }[entry.cost.budgetState]} 不与已报告费用相加</p>}
    <dl className="atb-pairs"><Pair label="原执行 ID"><code>{entry.id}</code></Pair><Pair label="原步骤"><code>{entry.stepKey}</code></Pair><Pair label="登记时间">{entry.createdAt}</Pair>
      <Pair label="响应保留状态">{{ missing: "未保存", retained: "仍在保留期", expired: "已过保留期", purged: "原件已清理" }[entry.responseState]}</Pair>
      {entry.errorCode && <Pair label="原失败代码"><code>{entry.errorCode}</code></Pair>}
    </dl><MethodEvidence selection={entry.method} />
    <details><summary>原请求 固定产物与已返回事件</summary><dl className="atb-pairs">
      <Pair label="原父执行"><code>{entry.parentId ?? "无父执行"}</code></Pair><Pair label="原输入校验值"><code>{entry.inputFingerprint}</code></Pair><Pair label="原执行依据"><code>{entry.fingerprint}</code></Pair>
      <Pair label="本地处理 / 派发">{entry.processingAttempts} / {entry.dispatches}</Pair><Pair label="渠道提交时间">{entry.submittedAt ?? "尚未记录"}</Pair><Pair label="原响应时间">{entry.receivedAt ?? "尚未记录"}</Pair>
      <Pair label="原渠道请求"><code>{entry.providerRequestId ?? "未提供"}</code></Pair><Pair label="原响应校验"><code>{entry.responseChecksum ?? "未提供"}</code></Pair><Pair label="技术交接校验"><code>{entry.completionChecksum ?? "未提供"}</code></Pair>
    </dl>{entry.artifacts.length ? <ul>{entry.artifacts.map(file => <li key={file.assetId}><code>{file.assetId}</code> · v{file.version}<p><code>{file.checksumSha256}</code></p></li>)}</ul> : <p>本次未返回可读取的固定产物</p>}
      {entry.unavailableArtifacts > 0 && <p>有 {entry.unavailableArtifacts} 份原产物当前不可读取 不用当前资产替代</p>}
      <p>已返回人工事件 {entry.events.length} 条{entry.hasMoreEvents ? " · 仍有更早事件 未称完整" : ""}</p>
      <ul>{entry.events.map(event => <li key={event.id}>{event.action === "request_recovery" ? "请求原任务续做" : "人工记录核对"} · {event.recordedAt}<p><code>{event.id}</code> · {event.finding ?? "无核对结论"}</p>{event.proofChecksum && <code>{event.proofChecksum}</code>}<p className="atb-muted">人工登记依据 尚非渠道验真</p></li>)}</ul>
    </details>
  </li>;
}
export function FactoryToolResult({ data }: { data: FactoryCapacityWorkspace }) {
  const [poolId, setPoolId] = useState(data.pools[0]?.id ?? ""), [index, setIndex] = useState(0);
  const pool = data.pools.find(value => value.id === poolId), days = data.calendar.filter(day => day.poolId === poolId), pages = Math.max(1, Math.ceil(days.length / 7));
  return <section aria-label="工厂产能窗口"><dl className="atb-pairs"><Pair label="原工厂 ID"><code>{data.factoryId}</code></Pair><Pair label="原窗口">{data.from} 起 {data.days} 天</Pair><Pair label="原登记时间">{data.recordedAt}</Pair></dl>
    <p className="atb-muted">按各资源池固定工厂时区显示 不是浏览器时区 此次读取不预留或释放产能</p>
    {data.pools.length ? <><label>查看原资源池<select aria-label="查看原资源池" value={poolId} onChange={event => { setPoolId(event.target.value); setIndex(0); }}>{data.pools.map(value => <option key={value.id} value={value.id}>{value.profile.name} · {value.code} · {value.timeZone}</option>)}</select></label>
      {pool && <><h4>{pool.profile.name} <span className="atb-badge">{poolStatuses[pool.profile.status]}</span></h4><p>原单位 {capacityUnitName(pool.unit)} · 每日额度 {pool.profile.dailyCapacityUnits === null ? "未知" : pool.profile.dailyCapacityUnits} · 固定版本 {pool.versionNumber}</p>
        <details><summary>原资源池版本与完整日历规则</summary><dl className="atb-pairs"><Pair label="原池 ID"><code>{pool.id}</code></Pair><Pair label="原池版本"><code>{pool.versionId}</code></Pair><Pair label="原工厂版本"><code>{pool.factoryVersionId}</code></Pair><Pair label="工厂时区">{pool.timeZone}</Pair><Pair label="实际依据">{pool.profile.evidenceReference || "未确认"}</Pair><Pair label="原截单时间">{pool.profile.cutoffTime ?? "未设置"}</Pair></dl>
          <ul>{pool.profile.weekly.map(day => <li key={day.weekday}>周{["一", "二", "三", "四", "五", "六", "日"][day.weekday - 1]} · {day.intervals.length ? day.intervals.map(interval => `${interval.start}–${interval.end}`).join(" / ") : "不安排工作"}</li>)}</ul>
          <ul>{pool.profile.exceptions.map(day => <li key={day.localDate}>{day.localDate} · 例外额度 {day.capacityUnits} · {day.intervals.length ? day.intervals.map(interval => `${interval.start}–${interval.end}`).join(" / ") : "闭厂"}</li>)}</ul>
          <ul>{pool.profile.bindings.map(binding => <li key={binding.capabilityVersionId}>原能力版本 <code>{binding.capabilityVersionId}</code> · 每件用量 {binding.unitsPerItem} {capacityUnitName(pool.unit)}</li>)}</ul><p className="atb-prose">{pool.profile.notes || "无补充备注"}</p></details>
      </>}
      <div className="atb-pagination" aria-label="已读取产能窗口分页"><span>本池窗口 {days.length} 个当地日 · 第 {index + 1} / {pages} 页</span><button type="button" disabled={index === 0} onClick={() => setIndex(value => value - 1)}><ChevronLeft size={14} />前七天</button><button type="button" disabled={index + 1 >= pages} onClick={() => setIndex(value => value + 1)}>后七天<ChevronRight size={14} /></button></div>
      <ol className="atb-rows">{days.slice(index * 7, index * 7 + 7).map(day => <li key={day.poolId + ":" + day.localDate}><h4>{day.localDate} · {day.timeZone}</h4><dl className="atb-pairs">
        <Pair label="当日额度">{day.capacityUnits === null ? "未知 不作为零额度" : `${day.capacityUnits} ${capacityUnitName(day.unit)}`}</Pair><Pair label="原总预留">{day.allocatedUnits} {capacityUnitName(day.unit)}</Pair>
        <Pair label="已承诺 / 已释放">{day.committedUnits} / {day.releasedUnits} {capacityUnitName(day.unit)}</Pair><Pair label="净占用">{day.allocatedUnits - day.releasedUnits} {capacityUnitName(day.unit)}</Pair>
        <Pair label="当前可用">{day.capacityUnits === null ? "未确认 不可推断为可预约" : `${day.availableUnits} ${capacityUnitName(day.unit)}`}</Pair>
        <Pair label="工厂当地工作区间">{day.intervals.length ? day.intervals.map(interval => `${capacityLocalInstant(interval.start, day.timeZone)}–${capacityLocalInstant(interval.end, day.timeZone)}`).join(" / ") : "该日无工作区间"}</Pair>
        <Pair label="工厂当地截单">{day.cutoffAt ? capacityLocalInstant(day.cutoffAt, day.timeZone) : "未设置"}</Pair></dl>
        {!!day.blockers.length && <ul className="atb-diagnostics">{day.blockers.map(reason => <li key={reason}>{capacityReason(reason)} <code>{reason}</code></li>)}</ul>}
      </li>)}</ol>{!days.length && <p>该资源池在本次窗口未返回日历 不补成空闲额度</p>}
    </> : <p>当前工厂没有返回资源池 产能依据尚未建立 不代表没有占用</p>}
    <Link href="/suppliers">进入供应商与工厂目录核对</Link>
  </section>;
}
