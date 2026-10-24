"use client";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { AssistTaskTargetsSchema, type AssistTaskBasis } from "@yummyai/contracts/ai/task-workspace";
import { BusinessBenchmarkCaseSchema, type BusinessBenchmarkCase } from "@yummyai/contracts/knowledge/benchmark";
import { knowledgeReadDenied } from "./knowledge-api";
import { benchmarkError, benchmarkTaskTarget, readBenchmarkTaskBasis, useBenchmarkRead,
  type BenchmarkScope, type BusinessBenchmarkRole, type BusinessBenchmarkTask } from "./knowledge-benchmark-client";
import { BenchmarkBusinessTaskView, benchmarkRoleNames } from "./knowledge-benchmark-role-result";

const roleNotes: Record<BusinessBenchmarkRole, { target: string; scope: string; boundary: string }> = {
  procurement_review: { target: "选择真实库存品与库位组合 缺失库存数据保持未知", scope: "采购与库存读取须为租户范围", boundary: "依据读取不登记请购或采购 不证明采购最优性" },
  business_review: { target: "选择真实利润计算 未选择比较计算 旧费用或未知值不补为零", scope: "财务与订单读取须为租户范围", boundary: "依据读取不计算新的业务利润 不付款或调账" },
  creative: { target: "选择已保存需求和研究来源的创意项目 不以临时提示词替代原项目", scope: "需设计与研究读取 设计写入和原项目 研究资源的实际授权", boundary: "原研究素材只作研究输入 不提升为可发布资产 本题不生成图片或采用方向" },
  order_review: { target: "选择真实订单行 固定实际订单修订和原来源版本", scope: "订单与隐私读取须为租户范围 另需订单写入", boundary: "匹配建议不写回订单草稿 不构成生产审批" },
  artwork_preflight: { target: "选择已有保存生产稿的真实订单行 固定原编辑版本", scope: "订单与隐私读取须为租户范围 另需设计读取与写入 原材料仍须资产授权", boundary: "仅一般制图预检 不执行严格生产自动审核 不替代原制造版本与规则快照" },
  template_config: { target: "选择已实际完成解析的模板记录 固定原解析与图层结构", scope: "需设计读取与写入 原模板资产按当前本人或团队授权核验", boundary: "PSD 结构不等于像素检查 不确认模板或写入图层" },
  sku_package: { target: "选择真实 Listing 固定原版本 已审配方与可用媒体按实际依据读取", scope: "需 Listing 商品与设计读取 以及 Listing 写入 原素材仍须资产授权", boundary: "只核对原素材包与文案 不保存 审批 导出或发布 Listing" },
  after_sales_review: { target: "选择当前可处理的真实售后单 已关闭历史未出现在本目录时不手填绕过", scope: "订单与隐私读取须为租户范围 原售后私有来源须仍可读取", boundary: "原任务回复语言为 en-US 不自动翻译为中文 不发送消息 退款或补发" },
};
export function BenchmarkRoleInput({ scope, role, task, onChange }: {
  scope: BenchmarkScope; role: BusinessBenchmarkRole; task: BusinessBenchmarkCase["task"] | null;
  onChange(task: BusinessBenchmarkTask | null): void;
}) {
  const [queryDraft, setQueryDraft] = useState(""), [query, setQuery] = useState("");
  const [targetId, setTargetId] = useState(() => task ? benchmarkTaskTarget(task) ?? "" : "");
  const [goal, setGoal] = useState(task?.taskGoal ?? ""), [reading, setReading] = useState(false), [error, setError] = useState("");
  const [snapshot, setSnapshot] = useState<{ stamp: string; value: AssistTaskBasis } | null>(null);
  const allowed = scope.businessRoles?.includes(role) === true;
  const canFix = allowed && scope.canManage && scope.canRun;
  const legacy = role === "procurement_review" || role === "business_review", notes = roleNotes[role];
  const targets = useBenchmarkRead(allowed ? "task-targets?" + new URLSearchParams({ kind: role, q: query }) : null, AssistTaskTargetsSchema, scope);
  const stamp = JSON.stringify({ role, targetId, taskGoal: goal.trim() }), currentStamp = useRef(stamp), sequence = useRef(0), controller = useRef<AbortController | null>(null);
  currentStamp.current = stamp;
  useEffect(() => () => { sequence.current++; controller.current?.abort(); }, []);
  const invalidate = () => { sequence.current++; controller.current?.abort(); setSnapshot(null); setReading(false); setError(""); onChange(null); };
  const basis = snapshot?.stamp === stamp ? snapshot.value : null;
  async function read() {
    if (!canFix || reading || !scope.current()) return;
    const parts = role === "procurement_review" ? targetId.trim().split(":") : [targetId.trim()];
    if (parts.length !== (role === "procurement_review" ? 2 : 1) || parts.some(value => !z.uuidv7().safeParse(value).success)) {
      setError(role === "procurement_review" ? "请选择真实库存品与库位组合 或核对两个完整原 ID" : "请先从实际业务对象目录选择本题的真实记录"); return;
    }
    if (!legacy && targetId !== (task ? benchmarkTaskTarget(task) : null) && !targets.data?.items.some(item => item.id === targetId)) {
      setError("所选对象尚未出现在本次受权目录 请重新查找并选择真实记录"); return;
    }
    const token = ++sequence.current, abort = new AbortController(); controller.current?.abort(); controller.current = abort;
    setReading(true); setError(""); setSnapshot(null); onChange(null);
    try {
      const value = await readBenchmarkTaskBasis({ kind: role, targetId: targetId.trim().toLowerCase(), taskGoal: goal.trim() }, scope, abort.signal);
      if (!value || abort.signal.aborted || sequence.current !== token || currentStamp.current !== stamp || !scope.current()) return;
      if (value.input.kind !== role) return;
      const fixed = BusinessBenchmarkCaseSchema.shape.task.parse(value.input);
      setSnapshot({ stamp, value }); onChange(fixed);
    } catch (failure) {
      if (!abort.signal.aborted && sequence.current === token && currentStamp.current === stamp && scope.current()) {
        if (knowledgeReadDenied(failure)) scope.deny(); else setError(benchmarkError(failure));
      }
    } finally { if (!abort.signal.aborted && sequence.current === token && currentStamp.current === stamp && scope.current()) setReading(false); }
  }
  return <section className="kb-benchmark-role-input" aria-label={benchmarkRoleNames[role] + "真实业务依据"}>
    <p className="kb-meta">先选择真实业务对象并读取依据 读取不调用模型 仍须具备此角色的当前运行及资料权限 不以填写 ID 代替真实核验</p>
    <p className="kb-meta">{notes.scope}</p><p className="kb-warning">{notes.boundary}</p>
    {!allowed && <p className="kb-warning">当前缺少本角色的资料或运行权限 不查询对象或读取新依据 本人或团队对象仍由服务器逐项授权</p>}
    {allowed && !canFix && <p className="kb-warning">读取并固定新的业务依据还需当前评测管理和运行权限 原已保存任务不会自动替换</p>}
    <div className="kb-benchmark-inline"><label>查找真实业务对象<input maxLength={200} value={queryDraft} disabled={!allowed || reading} onChange={event => setQueryDraft(event.target.value)} /></label>
      <button type="button" className="oc-button" disabled={!allowed || targets.reading || reading} onClick={() => { invalidate(); setTargetId(""); setQuery(queryDraft.trim()); targets.reload(); }}>查找业务对象</button></div>
    <label>实际业务对象<select aria-label="实际业务对象" value={targetId} disabled={!allowed || reading || targets.reading} onChange={event => { invalidate(); setTargetId(event.target.value); }}>
      <option value="">选择本次固定的真实记录</option>
      {targetId && !targets.data?.items.some(item => item.id === targetId) && <option value={targetId}>原 ID {targetId} · 须由服务器核对</option>}
      {targets.data?.items.map(item => <option value={item.id} key={item.id}>{item.label}</option>)}
    </select></label>
    {targets.reading && <p role="status">正在读取当前受权业务对象</p>}{targets.error && <p className="kb-error" role="alert">{targets.error}</p>}
    {targets.data && <p className="kb-meta">本次搜索 {targets.data.items.length} 项{targets.data.hasMore ? " · 仅显示前 40 项 请缩小搜索 未视为全量目录" : " · 当前查询已读完 不代表没有其他历史对象"}</p>}
    {targets.data?.items.length === 0 && <p className="kb-meta">当前查询没有可选记录 请到原业务页面核对已保存对象和当前权限 未生成虚构对象</p>}
    {targets.data?.items.find(item => item.id === targetId)?.detail && <p>{targets.data.items.find(item => item.id === targetId)!.detail}</p>}
    <label>原业务对象 ID<input value={targetId} readOnly={!legacy} disabled={!allowed || reading} maxLength={80} onChange={event => { if (legacy) { invalidate(); setTargetId(event.target.value); } }} /></label>
    <p className="kb-meta">{notes.target}</p>
    <label>固定分析重点<textarea aria-label="固定分析重点" maxLength={2000} value={goal} disabled={!allowed || reading} onChange={event => { invalidate(); setGoal(event.target.value); }} /></label>
    <button type="button" className="oc-button" disabled={!canFix || reading || !targetId.trim()} onClick={() => void read()}>{reading ? "正在读取业务依据" : "读取并固定本题业务依据"}</button>
    {reading && <button type="button" className="oc-button" onClick={() => { sequence.current++; controller.current?.abort(); setReading(false); }}>取消本次依据读取</button>}
    {error && <p className="kb-error" role="alert">{error}</p>}
    {basis && <section className="kb-benchmark-notice" aria-label="本题实际业务依据"><h4>本题实际业务依据</h4>
      <dl className="kb-benchmark-pairs">{basis.rows.map((row, index) => <div key={index}><dt>{row.label}</dt><dd>{row.value}</dd></div>)}</dl>
      {basis.checks.length > 0 && <ul className="kb-warning">{basis.checks.map((check, index) => <li key={index}>{check.message}</li>)}</ul>}
      {basis.diagnostics.length > 0 && <ul>{basis.diagnostics.map((item, index) => <li key={index}>{item}</li>)}</ul>}
      <details className="kb-benchmark-details"><summary>本次真实来源与任务指纹</summary><code>{basis.fingerprint}</code><ul>{basis.sources.map((source, index) => <li key={index}>{source.label}<br /><code>{source.id}</code></li>)}</ul></details>
    </section>}
    {task ? <BenchmarkBusinessTaskView task={task} /> : <p className="kb-warning">本题尚未固定真实业务依据 不能保存为可发布样本</p>}
  </section>;
}
