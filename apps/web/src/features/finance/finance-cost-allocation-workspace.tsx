"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, Calculator, Check, CircleAlert, FileSearch, GitBranch, History, Plus, RefreshCw, Scale, Trash2 } from "lucide-react";
import { Permission } from "@yummyai/authz/permissions";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import { formatFinanceMinorAmount } from "@yummyai/contracts/finance/monetary";
import {
  CalculateFinanceAllocatedProfitInputSchema, FinanceAllocatedProfitRunPageSchema,
  FinanceAllocatedProfitRunViewSchema, FinanceAllocatedProfitSlicePageSchema,
  FinanceCostAllocationBaseViewSchema, FinanceCostAllocationDimensionSchema,
  FinanceCostAllocationPreviewInputSchema, FinanceCostAllocationPreviewViewSchema,
  FinanceCostAllocationSourcePageSchema, FinanceCostAllocationTargetListInputSchema,
  FinanceCostAllocationTargetPageSchema, FinanceCostAllocationVersionInputSchema,
  FinanceCostAllocationVersionPageSchema, FinanceCostAllocationVersionViewSchema,
  FinanceCostAllocationWeightSchema,
  type FinanceAllocatedProfitRun,
  type FinanceAllocatedProfitSlice, type FinanceCostAllocationDimension,
  type FinanceCostAllocationPreview, type FinanceCostAllocationPreviewInput,
  type FinanceCostAllocationTarget, type FinanceCostAllocationVersion,
  type FinanceCostSourceOption,
} from "@yummyai/contracts/finance/cost-allocation";
import type { z } from "zod";
import { useErpAccess } from "../identity/erp-access";
import { Field, RecordDialog } from "../manual-operations/record-form";
import { useLeaveGuard } from "../navigation/use-leave-guard";
import { useOwnedViewTransition } from "../navigation/use-owned-view-transition";
import { PrepareFinanceCommandSchema, type FinanceCommandDetail, type FinanceCommandScope } from "@yummyai/contracts/finance/finance-command";
import { FinanceCommandReview, useFinanceCommandPreparation } from "./finance-command-workbench";
import "../manual-operations/manual-operations.css";
import "./finance-cost-allocation-workspace.css";

type Base = z.infer<typeof FinanceCostAllocationBaseViewSchema>;
type PageMeta = Omit<z.infer<typeof FinanceCostAllocationVersionPageSchema>, "items">;
type Page<T> = PageMeta & { items: T[] };
type Security = {
  authority: string | null;
  canReview: boolean;
  isAuthorized(authority: string | null, write?: boolean): boolean;
  onDenied(message: string): void;
};
type DraftSource = { rootFactId: string; label: string; targets: Array<{ target: FinanceCostAllocationTarget; weight: string }> };
type Seed = { mode: "append" | "calculate"; version: FinanceCostAllocationVersion };
type DetailTarget = { kind: "version" | "run"; id: string };
const dimensions: Record<FinanceCostAllocationDimension, string> = { order: "订单", order_line: "订单行", sku: "SKU", listing: "刊登", period: "UTC 自然月" };
const blockingNames = {
  base_incomplete: "原汇总利润尚未完整核对", base_not_aggregate: "原计算不是汇总覆盖维度",
  not_cost: "不是可分摊费用", already_attributed: "已归属本次维度 不再重复分摊",
  correction_chain_changed: "原费用纠错链已变化", source_unavailable: "原来源暂不可核对",
};
const basisNames = { source_changed: "原费用来源已变化", target_changed: "目标业务依据已变化", rule_superseded: "规则已有后续版本", base_unavailable: "原汇总计算暂不可核对" };

export function FinanceCostAllocationWorkspace() {
  const access = useErpAccess(), canRead = access.can(Permission.FinanceRead), canReview = access.can(Permission.FinanceReview);
  const [denied, setDenied] = useState<{ authority: string | null; message: string } | null>(null);
  const current = useRef({ authority: access.authority, canRead, canReview, denied: false });
  current.current = { authority: access.authority, canRead, canReview, denied: denied?.authority === access.authority };
  const isAuthorized = useCallback((authority: string | null, write = false) => current.current.authority === authority && current.current.canRead && !current.current.denied && (!write || current.current.canReview), []);
  const onDenied = useCallback((message: string) => {
    current.current.denied = true;
    setDenied({ authority: current.current.authority, message });
  }, []);
  return <section className="finance-cost-workspace" aria-label="费用分摊与归属利润">
    <header className="finance-cost-heading"><div><Scale size={19} /><h2>费用分摊与归属利润</h2></div><a href="/finance/ledger">查找原财务台账</a></header>
    <Notice>从原完整汇总利润中读取已折算的费用 以明确人工依据分摊并固定批准版本<br />原账面金额、汇率和单据保留 这里不进行付款核销或转账</Notice>
    {!canRead || denied?.authority === access.authority ? <Notice error>{denied?.authority === access.authority ? denied.message : "当前没有财务读取权限"} 私有记录、原请求与填写已清除</Notice> : <AllocationSession key={access.authority ?? "no-session"} security={{ authority: access.authority, canReview, isAuthorized, onDenied }} />}
  </section>;
}

function AllocationSession({ security }: { security: Security }) {
  const [baseDraft, setBaseDraft] = useState(""), [baseId, setBaseId] = useState<string | null>(null), [inputError, setInputError] = useState("");
  const [seed, setSeed] = useState<Seed | null>(null), [editorKey, setEditorKey] = useState(0), [historyKey, setHistoryKey] = useState(0);
  const [detail, setDetail] = useState<DetailTarget | null>(null), [locks, setLocks] = useState<Record<string, boolean>>({});
  const locked = Object.values(locks).some(Boolean), transition = useOwnedViewTransition();
  useLayoutEffect(() => () => transition.cancel(), [transition]);
  const base = useAllocationRead(baseId ? `bases/${baseId}` : null, FinanceCostAllocationBaseViewSchema, security);
  const currentBase = base.data?.id === baseId ? base.data : null;
  const retain = useCallback((slot: string, value: boolean) => setLocks(previous => previous[slot] === value ? previous : { ...previous, [slot]: value }), []);
  const changed = useCallback(() => setHistoryKey(value => value + 1), []);
  const useVersion = (version: FinanceCostAllocationVersion, mode: Seed["mode"]) => {
    if (locked || version.basisProblems.length) return;
    transition.change(() => { if (security.isAuthorized(security.authority)) { setBaseDraft(version.preview.baseRunId); setBaseId(version.preview.baseRunId); setSeed({ version, mode }); setEditorKey(value => value + 1); } });
  };
  const finish = (next?: Seed) => {
    if (!security.isAuthorized(security.authority)) return;
    setLocks({}); setSeed(next ?? null); setEditorKey(value => value + 1);
  };
  return <>
    <form className="finance-cost-toolbar" aria-label="读取原汇总利润" onSubmit={event => {
      event.preventDefault(); if (locked) return;
      const parsed = EntityIdSchema.safeParse(baseDraft.trim());
      if (!parsed.success) { setInputError("请填写真实的原利润计算 ID"); return; }
      setInputError(""); transition.change(() => { if (security.isAuthorized(security.authority)) { setSeed(null); setBaseId(parsed.data.toLowerCase()); setEditorKey(value => value + 1); } });
      if (parsed.data.toLowerCase() === baseId) void base.reload();
    }}><Field label="原汇总利润计算 ID" help="在财务台账的利润计算记录中查找 只接受完整汇总计算"><input value={baseDraft} disabled={locked} onChange={event => setBaseDraft(event.target.value)} required maxLength={36} autoComplete="off" /></Field><button className="primary" type="submit" disabled={locked || base.reading}><FileSearch size={14} />读取原利润计算</button></form>
    {inputError && <Notice error>{inputError}</Notice>}
    {locked && <Notice>请先核对此操作的本人原提交 准备响应未知时只重试保存原正文与键 执行结果未知时只读取原命令 关页后可到本人财务原提交恢复</Notice>}
    <ReadState state={base} />
    {base.data && !currentBase && <Notice error>返回原计算与所查 ID 不一致 未用于分摊</Notice>}
    {currentBase && <>
      <BaseSummary base={currentBase} />
      {currentBase.status !== "complete" || currentBase.diagnostics.coverage?.dimension !== "aggregate" ? <Notice error>此原计算尚不满足完整汇总依据 请先在原财务流程核对 未将缺失费用或来源当作零</Notice> : !base.error && !base.reading && <AllocationEditor key={`${currentBase.id}:${editorKey}`} base={currentBase} seed={seed} security={security} retain={retain} onRecorded={changed} onFinish={finish} onOpen={setDetail} />}
    </>}
    <AllocationHistory key={historyKey} security={security} currentBaseId={baseId} onOpen={setDetail} />
    {detail && <AllocationDetailDialog key={`${detail.kind}:${detail.id}`} target={detail} security={security} locked={locked} onClose={() => setDetail(null)} onUse={useVersion} onOpen={setDetail} />}
  </>;
}

export function BaseSummary({ base }: { base: Base }) {
  return <section className="finance-cost-panel" aria-labelledby="finance-cost-base-title"><PanelHeading id="finance-cost-base-title" title="原汇总计算依据" icon={<FileSearch size={16} />} /><div className="finance-cost-content"><dl className="finance-cost-pairs"><Pair label="原计算 ID"><Code>{base.id}</Code></Pair><Pair label="核对状态">{base.status === "complete" ? "原计算完整" : "原计算待核对"} · {base.diagnostics.coverage?.dimension === "aggregate" ? "汇总维度" : "非汇总维度"}</Pair><Pair label="原利润口径版本"><Code>{base.metricVersionId}</Code>v{base.metricVersion}</Pair><Pair label="原计算时间">{timeLabel(base.calculatedAt)}</Pair><Pair label="原报告币种">{base.reportingCurrency}</Pair><Pair label="原费用"><Money value={base.costMinor} currency={base.reportingCurrency} /></Pair><Pair label="原输入校验值"><Code>{base.inputChecksum}</Code></Pair><Pair label="原来源与汇率">固定单据 {base.statementIds.length} 笔 · 固定汇率 {base.fxRateIds.length} 笔</Pair></dl><p className="finance-cost-help">原计算已完成币种折算 分摊只拆分原报告币种的最小单位 不逐份重新折算</p></div></section>;
}

function AllocationEditor({ base, seed, security, retain, onRecorded, onFinish, onOpen }: {
  base: Base; seed: Seed | null; security: Security; retain(slot: string, value: boolean): void; onRecorded(): void;
  onFinish(next?: Seed): void; onOpen(target: DetailTarget): void;
}) {
  const [dimension, setDimension] = useState<FinanceCostAllocationDimension>(seed?.version.preview.dimension ?? "order");
  const [localLocks, setLocalLocks] = useState<Record<string, boolean>>({});
  const locked = Object.values(localLocks).some(Boolean), transition = useOwnedViewTransition();
  useLayoutEffect(() => () => transition.cancel(), [transition]);
  const retainLocal = useCallback((slot: string, value: boolean) => {
    setLocalLocks(previous => previous[slot] === value ? previous : { ...previous, [slot]: value }); retain(slot, value);
  }, [retain]);
  return <>
    <section className="finance-cost-dimension" aria-label="选择归属维度"><Field label="归属维度" help="切换维度会清空当前费用、目标、权重及预览 原批准版本不变"><select value={dimension} disabled={locked} onChange={event => { const parsed = FinanceCostAllocationDimensionSchema.safeParse(event.target.value); if (parsed.success) transition.change(() => { if (security.isAuthorized(security.authority)) setDimension(parsed.data); }); }}>{Object.entries(dimensions).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field><p className="finance-cost-help">选择实际业务维度 未合理归属的费用仍是缺口 不将整单费用自动分给 SKU{!security.canReview && <><br />当前可读取和预览 不具备批准登记及计算权限</>}</p></section>
    <AllocationDecision key={dimension} base={base} dimension={dimension} seed={seed?.version.preview.dimension === dimension ? seed : null} security={security} otherLocked={Boolean(localLocks.calculation)} retain={retainLocal} onRecorded={onRecorded} onFinish={onFinish} onOpen={onOpen} />
    <AllocationCalculation key={`calculation:${dimension}`} base={base} dimension={dimension} initialVersion={seed?.mode === "calculate" && seed.version.preview.dimension === dimension ? seed.version : null} security={security} otherLocked={Boolean(localLocks.approval)} retain={retainLocal} onRecorded={onRecorded} onFinish={() => onFinish()} onOpen={onOpen} />
  </>;
}

function AllocationDecision({ base, dimension, seed, security, otherLocked, retain, onRecorded, onFinish }: {
  base: Base; dimension: FinanceCostAllocationDimension; seed: Seed | null; security: Security; otherLocked: boolean;
  retain(slot: string, value: boolean): void; onRecorded(): void; onFinish(next?: Seed): void; onOpen(target: DetailTarget): void;
}) {
  const append = seed?.mode === "append" ? seed.version : null;
  const [sources, setSources] = useState<DraftSource[]>(() => append ? draftFromVersion(append) : []);
  const [activeRoot, setActiveRoot] = useState<string | null>(() => sources[0]?.rootFactId ?? null);
  const [method, setMethod] = useState<FinanceCostAllocationPreviewInput["method"]>(append?.preview.method ?? "equal");
  const [reason, setReason] = useState(append?.preview.reasonCode ?? "MANUAL_ALLOCATION"), [basis, setBasis] = useState(append?.preview.basisDescription ?? "");
  const [preview, setPreview] = useState<{ input: FinanceCostAllocationPreviewInput; view: FinanceCostAllocationPreview } | null>(null);
  const [previewing, setPreviewing] = useState(false), [error, setError] = useState(""), [confirmed, setConfirmed] = useState(false);
  const previewSequence = useRef(0), previewAbort = useRef<AbortController | null>(null), mounted = useRef(true), transition = useOwnedViewTransition();
  const approval = useOriginalWrite("versions", { kind: "cost_version_approve", targetId: append?.allocationId ?? null }, security, () => onRecorded(), () => onFinish());
  const retained = approval.locked, locked = retained || otherLocked, active = sources.find(source => source.rootFactId === activeRoot);
  useEffect(() => { retain("approval", retained); return () => retain("approval", false); }, [retained, retain]);
  useLeaveGuard(Boolean(approval.original && !approval.commandId || sources.length || basis), approval.pending);
  useLayoutEffect(() => () => { previewSequence.current++; previewAbort.current?.abort(); transition.cancel(); }, [transition]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; previewSequence.current++; previewAbort.current?.abort(); transition.cancel(); }; }, [transition]);
  const invalidate = () => { previewSequence.current++; previewAbort.current?.abort(); transition.cancel(); setPreview(null); setConfirmed(false); setError(""); setPreviewing(false); };
  const edit = (update: () => void, animated = true) => { if (locked) return; invalidate(); if (animated) transition.change(() => { if (mounted.current && security.isAuthorized(security.authority)) update(); }); else update(); };
  const addSource = (source: FinanceCostSourceOption) => edit(() => {
    if (source.blockingReasons.length || sources.some(item => item.rootFactId === source.rootFactId)) return;
    if (sources.length >= 100) { setError("每个决定最多选择100个原费用家族 请明确缩小本次范围"); return; }
    setSources(items => [...items, { rootFactId: source.rootFactId, label: source.label || `原费用 ${source.rootFactId}`, targets: [] }]); setActiveRoot(source.rootFactId);
  });
  const addTarget = (target: FinanceCostAllocationTarget) => edit(() => {
    if (!active || active.targets.some(row => row.target.key === target.key)) return;
    if (sources.reduce((count, source) => count + source.targets.length, 0) >= 1000) { setError("每个决定最多明确1000个费用目标 请缩小本次范围"); return; }
    setSources(items => items.map(source => source.rootFactId === activeRoot ? { ...source, targets: [...source.targets, { target, weight: "1" }] } : source));
  });
  const preparePreview = async () => {
    if (locked || previewing || !security.isAuthorized(security.authority)) return;
    const input = FinanceCostAllocationPreviewInputSchema.safeParse({ baseRunId: base.id, baseInputChecksum: base.inputChecksum, allocationId: append?.allocationId ?? null, expectedVersion: append?.versionNumber ?? null, dimension, method, sources: sources.map(source => ({ rootFactId: source.rootFactId, targets: source.targets.map(row => ({ key: row.target.key, weight: method === "equal" ? "1" : row.weight })) })), reasonCode: reason, basisDescription: basis });
    if (!input.success) { setError("请核对真实费用和目标 每笔费用至少选一个目标 权重须为正的规范十进制且最多9位小数 依据说明及大写原因代码必填"); return; }
    const token = ++previewSequence.current, abort = new AbortController(); previewAbort.current?.abort(); previewAbort.current = abort;
    const valid = () => mounted.current && previewSequence.current === token && security.isAuthorized(security.authority);
    setPreviewing(true); setError(""); setPreview(null); setConfirmed(false);
    try {
      const result = await allocationRequest("preview", FinanceCostAllocationPreviewViewSchema, { body: JSON.stringify(input.data), signal: abort.signal });
      if (!previewMatches(input.data, result)) throw new AllocationError(502, "预览与原填写依据不一致 请重新读取原费用");
      if (valid()) transition.change(() => { if (valid()) setPreview({ input: input.data, view: result }); });
    } catch (failure) { if (!abort.signal.aborted && valid()) { if (isDenied(failure)) security.onDenied(failure.message); else setError(publicError(failure)); } }
    finally { if (valid()) setPreviewing(false); }
  };
  const approve = () => {
    if (!preview || !confirmed || !security.canReview || locked) return;
    const parsed = FinanceCostAllocationVersionInputSchema.safeParse({ ...preview.input, previewChecksum: preview.view.previewChecksum, idempotencyKey: `cost-version-${crypto.randomUUID()}` });
    if (!parsed.success) { setError("批准原文无法核对 请重新生成预览"); return; }
    void approval.submit(parsed.data);
  };
  return <section className="finance-cost-panel" aria-labelledby="finance-cost-decision-title"><PanelHeading id="finance-cost-decision-title" title="选择费用并核对分摊" icon={<GitBranch size={16} />} /><div className="finance-cost-content">
    {append && <Notice>建立原分摊的下一版 <Code>{append.allocationId}</Code>固定前版 v{append.versionNumber} · <Code>{append.id}</Code>后续版本不会覆盖原批准记录</Notice>}
    <div className="finance-cost-pickers" inert={locked}>
      <SourcePicker baseId={base.id} dimension={dimension} security={security} selected={sources.map(source => source.rootFactId)} onAdd={addSource} />
      <TargetPicker dimension={dimension} security={security} activeLabel={active?.label ?? null} selected={active?.targets.map(row => row.target.key) ?? []} onAdd={addTarget} />
    </div>
    <div className="finance-cost-draft" inert={locked}>
      <h4>本次费用与目标</h4><p className="finance-cost-help">先切换一笔费用 再向这笔费用添加真实目标 每笔费用的权重独立核对</p>
      {!sources.length && <Empty>尚未选择原费用 不使用当前列表推断其他费用</Empty>}
      <div className="finance-cost-source-tabs" role="group" aria-label="切换本次费用">{sources.map(source => <button type="button" key={source.rootFactId} aria-pressed={activeRoot === source.rootFactId} onClick={() => setActiveRoot(source.rootFactId)}>{source.label || "原费用"}<small>{source.rootFactId}</small></button>)}</div>
      {sources.map(source => <section key={source.rootFactId} className={`finance-cost-source-draft${activeRoot === source.rootFactId ? " is-active" : ""}`} aria-label={`本次费用 ${source.rootFactId}`}><header><strong>{source.label || "原费用"}</strong><button type="button" onClick={() => edit(() => { setSources(items => items.filter(item => item.rootFactId !== source.rootFactId)); if (activeRoot === source.rootFactId) setActiveRoot(sources.find(item => item.rootFactId !== source.rootFactId)?.rootFactId ?? null); })}><Trash2 size={13} />移除费用</button></header><Code>{source.rootFactId}</Code>
        {!source.targets.length && <p className="finance-cost-help">尚未添加目标 请选择此费用后在目标区添加</p>}
        {source.targets.map(row => <div className="finance-cost-target-row" key={row.target.key}><div><strong>{row.target.label}</strong><Code>{row.target.key}</Code><small>{dimensions[row.target.dimension]}</small></div><Field label={`权重 ${source.rootFactId} ${row.target.key}`} help={method === "equal" ? "等额固定记录 1" : "正数 最多9位小数 不留前零或尾零"}><input inputMode="decimal" maxLength={31} autoComplete="off" value={method === "equal" ? "1" : row.weight} readOnly={method === "equal"} aria-invalid={method !== "equal" && !FinanceCostAllocationWeightSchema.safeParse(row.weight).success} onChange={event => edit(() => setSources(items => items.map(item => item.rootFactId === source.rootFactId ? { ...item, targets: item.targets.map(target => target.target.key === row.target.key ? { ...target, weight: event.target.value } : target) } : item)), false)} /></Field><button type="button" aria-label={`移除目标 ${row.target.key}`} onClick={() => edit(() => setSources(items => items.map(item => item.rootFactId === source.rootFactId ? { ...item, targets: item.targets.filter(target => target.target.key !== row.target.key) } : item)))}><Trash2 size={14} /></button></div>)}
      </section>)}
      <div className="finance-cost-rule-fields"><Field label="分摊方法"><select value={method} onChange={event => edit(() => { const next = event.target.value === "equal" ? "equal" : "manual_weights"; setMethod(next); if (next === "equal") setSources(items => items.map(item => ({ ...item, targets: item.targets.map(row => ({ ...row, weight: "1" })) }))); })}><option value="equal">等额分摊</option><option value="manual_weights">人工精确权重</option></select></Field><Field label="分摊原因代码" help="大写字母 数字 点 下划线或连字符"><input value={reason} maxLength={100} onChange={event => edit(() => setReason(event.target.value), false)} autoComplete="off" /></Field><Field label="人工分摊依据" help="写明实际选择范围及权重理由 此处未自动按收入或数量生成权重"><textarea value={basis} maxLength={1000} rows={3} onChange={event => edit(() => setBasis(event.target.value), false)} /></Field></div>
    </div>
    {error && <Notice error>{error}</Notice>}
    {!approval.commandId && <div className="finance-cost-actions"><button type="button" disabled={locked || previewing || !sources.length} onClick={() => void preparePreview()}><Scale size={14} />{previewing ? "正在核对精确分摊" : "预览精确分摊"}</button><span className="finance-cost-help">预览仅核对原文 不登记账面记录</span></div>}
    {preview && <><AllocationPreviewSummary preview={preview.view} />{security.canReview && !approval.commandId && <div className="finance-cost-approval"><label><input type="checkbox" checked={confirmed} disabled={locked} onChange={event => setConfirmed(event.target.checked)} />我已核对原费用、全部目标、权重、人工依据及尾差 准备此版本原提交</label><button type="button" className="primary" disabled={locked || !confirmed || previewing} onClick={approve}><Check size={14} />保存分摊批准原填写并核对</button></div>}</>}
    <OriginalWriteState write={approval} noun="分摊批准" />
  </div></section>;
}

function SourcePicker({ baseId, dimension, security, selected, onAdd }: { baseId: string; dimension: FinanceCostAllocationDimension; security: Security; selected: string[]; onAdd(source: FinanceCostSourceOption): void }) {
  const path = `bases/${baseId}/sources?dimension=${dimension}`;
  const page = useAllocationPage(path, FinanceCostAllocationSourcePageSchema, security);
  return <section className="finance-cost-picker" aria-label="原费用来源"><h4>原费用来源</h4><p className="finance-cost-help">按原贡献及真实费用纠错家族读取 显式阻断的费用不可加入</p><ReadState state={page} />
    {page.data && !page.data.items.length && <Empty>本页没有费用来源 不代表其他原计算或维度没有费用</Empty>}
    <ul className="finance-cost-option-list">{page.data?.items.map(source => <li key={source.rootFactId}><strong>{source.label || "原费用事实"}</strong><Code>{source.rootFactId}</Code><p>原金额 <Money value={source.sourceAmountMinor} currency={source.sourceCurrency} /><br />原报告金额 <Money value={source.reportingAmountMinor} currency={source.reportingCurrency} /></p><small>原贡献 {source.contributionIds.length} 笔 · 来源类型 {factName(source.factType)}</small>{source.blockingReasons.length > 0 && <p className="finance-cost-warning">{source.blockingReasons.map(code => blockingNames[code]).join(" · ")}</p>}<details><summary>读取来源校验依据</summary><dl className="finance-cost-pairs"><Pair label="原单据 ID"><Code>{source.statementId}</Code></Pair><Pair label="原单据校验值"><Code>{source.statementChecksum}</Code></Pair><Pair label="费用链校验值"><Code>{source.sourceChainChecksum}</Code></Pair><Pair label="原贡献 ID">{source.contributionIds.map(id => <Code key={id}>{id}</Code>)}</Pair></dl></details><button type="button" disabled={page.reading || Boolean(page.error) || selected.includes(source.rootFactId) || Boolean(source.blockingReasons.length)} onClick={() => onAdd(source)}><Plus size={13} />{selected.includes(source.rootFactId) ? "已选择此费用" : "添加费用"}</button></li>)}</ul><PageControls page={page} />
  </section>;
}

function TargetPicker({ dimension, security, activeLabel, selected, onAdd }: { dimension: FinanceCostAllocationDimension; security: Security; activeLabel: string | null; selected: string[]; onAdd(target: FinanceCostAllocationTarget): void }) {
  const [draft, setDraft] = useState(""), [key, setKey] = useState<string | undefined>(undefined), [error, setError] = useState("");
  const query = useMemo(() => FinanceCostAllocationTargetListInputSchema.safeParse({ dimension, ...(key ? { key } : {}), limit: 25 }), [dimension, key]);
  const path = query.success ? `targets?dimension=${dimension}${key ? `&key=${encodeURIComponent(key)}` : ""}` : null;
  const page = useAllocationPage(path, FinanceCostAllocationTargetPageSchema, security);
  return <section className="finance-cost-picker" aria-label="真实归属目标"><h4>真实归属目标</h4><p className="finance-cost-help">{activeLabel ? `将目标加入已选费用 ${activeLabel}` : "先选择一笔费用 才能添加目标"}</p>
    <form className="finance-cost-target-search" aria-label="查找真实归属目标" onSubmit={event => { event.preventDefault(); const parsed = FinanceCostAllocationTargetListInputSchema.safeParse({ dimension, key: draft.trim(), limit: 25 }); if (!parsed.success) { setError(dimension === "period" ? "请明确选择可表示的 UTC 自然月 YYYY-MM" : "请填写与此维度一致的真实业务 ID"); return; } setError(""); setKey(parsed.data.key); if (parsed.data.key === key) void page.reload(); }}><Field label={dimension === "period" ? "UTC 归属月份" : "真实目标 ID"} help={dimension === "period" ? "明确 YYYY-MM 起止为该月 UTC 起点至下月 UTC 起点" : "可按真实 ID 精确查找 或逐页读取实际目标"}><input type={dimension === "period" ? "month" : "text"} required maxLength={36} value={draft} onChange={event => setDraft(event.target.value)} autoComplete="off" /></Field><div className="finance-cost-actions"><button type="submit"><FileSearch size={13} />查找目标</button>{dimension !== "period" && key && <button type="button" onClick={() => { setDraft(""); setKey(undefined); setError(""); }}>返回目标首页</button>}</div></form>
    {error && <Notice error>{error}</Notice>}
    {dimension === "period" && !query.success && <p className="finance-cost-help">选择明确月份后才读取期间目标 不自动采用当前月</p>}
    <ReadState state={page} />{page.data && !page.data.items.length && <Empty>本页没有可访问的实际目标 请核对维度及 ID</Empty>}
    <ul className="finance-cost-option-list">{page.data?.items.map(target => <li key={target.key}><TargetSummary target={target} /><button type="button" disabled={!activeLabel || page.reading || Boolean(page.error) || selected.includes(target.key)} onClick={() => onAdd(target)}><Plus size={13} />{selected.includes(target.key) ? "已添加此目标" : "添加目标"}</button></li>)}</ul><PageControls page={page} />
  </section>;
}

function AllocationCalculation({ base, dimension, initialVersion, security, otherLocked, retain, onRecorded, onFinish, onOpen }: {
  base: Base; dimension: FinanceCostAllocationDimension; initialVersion: FinanceCostAllocationVersion | null; security: Security; otherLocked: boolean;
  retain(slot: string, value: boolean): void; onRecorded(): void; onFinish(): void; onOpen(target: DetailTarget): void;
}) {
  const [versions, setVersions] = useState<FinanceCostAllocationVersion[]>(() => initialVersion && !initialVersion.basisProblems.length ? [initialVersion] : []);
  const [versionDraft, setVersionDraft] = useState(""), [error, setError] = useState(""), [reading, setReading] = useState(false), [confirmed, setConfirmed] = useState(false);
  const live = useRef(true), sequence = useRef(0), abort = useRef<AbortController | null>(null);
  const transition = useOwnedViewTransition();
  useLayoutEffect(() => () => { sequence.current++; abort.current?.abort(); transition.cancel(); }, [transition]);
  const calculation = useOriginalWrite("runs", { kind: "allocated_profit_calculate", targetId: base.id }, security, () => onRecorded(), onFinish);
  const retained = calculation.locked, locked = retained || otherLocked;
  useEffect(() => { retain("calculation", retained); return () => retain("calculation", false); }, [retained, retain]);
  useLeaveGuard(Boolean(calculation.original && !calculation.commandId), calculation.pending);
  useEffect(() => { live.current = true; return () => { live.current = false; sequence.current++; abort.current?.abort(); }; }, []);
  const addVersion = async () => {
    if (locked || reading || !security.isAuthorized(security.authority)) return;
    const parsed = EntityIdSchema.safeParse(versionDraft.trim());
    if (!parsed.success) { setError("请填写真实已批准分摊版本 ID 不是分摊规则 ID"); return; }
    const token = ++sequence.current, controller = new AbortController(); abort.current?.abort(); abort.current = controller; setReading(true); setError("");
    const valid = () => live.current && sequence.current === token && security.isAuthorized(security.authority);
    try {
      const version = await allocationRequest(`versions/${parsed.data}`, FinanceCostAllocationVersionViewSchema, { signal: controller.signal });
      if (version.id !== parsed.data.toLowerCase()) throw new AllocationError(502, "返回版本与所查 ID 不一致");
      if (!valid()) return;
      if (version.preview.baseRunId !== base.id || version.preview.baseInputChecksum !== base.inputChecksum || version.preview.dimension !== dimension) { setError("此版本不属于当前原计算及归属维度 请核对原依据"); return; }
      if (version.basisProblems.length) { setError(`该版本依据待核对 ${version.basisProblems.map(code => basisNames[code]).join(" · ")}`); return; }
      if (versions.some(item => item.allocationId === version.allocationId)) { setError("同一分摊规则只能明确选用一个版本 请先移除原选择再核对"); return; }
      if (versions.length >= 500) { setError("每次归属计算最多固定500个批准版本"); return; }
      transition.change(() => { if (valid()) { setVersions(items => [...items, version]); setVersionDraft(""); setConfirmed(false); } });
    } catch (failure) { if (!controller.signal.aborted && valid()) { if (isDenied(failure)) security.onDenied(failure.message); else setError(publicError(failure)); } }
    finally { if (valid()) setReading(false); }
  };
  const calculate = () => {
    if (locked || !confirmed || reading || !security.isAuthorized(security.authority, true)) return;
    const parsed = CalculateFinanceAllocatedProfitInputSchema.safeParse({ baseRunId: base.id, baseInputChecksum: base.inputChecksum, dimension, versionIds: versions.map(version => version.id), idempotencyKey: `allocated-profit-${crypto.randomUUID()}` });
    if (!parsed.success) { setError("当前计算选择无法核对 请重新读取批准版本"); return; }
    void calculation.submit(parsed.data);
  };
  return <section className="finance-cost-panel" aria-labelledby="finance-cost-calculation-title"><PanelHeading id="finance-cost-calculation-title" title="固定版本计算归属利润" icon={<Calculator size={16} />} /><div className="finance-cost-content"><p className="finance-cost-help">使用原计算 <Code>{base.id}</Code>及明确选择的{dimensions[dimension]}分摊版本 未选版本不会自动采用最新值 缺少归属仍显示不完整</p>
    <div inert={locked}><form className="finance-cost-inline-form" aria-label="读取并选择批准版本" onSubmit={event => { event.preventDefault(); void addVersion(); }}><Field label="批准分摊版本 ID"><input required maxLength={36} value={versionDraft} onChange={event => setVersionDraft(event.target.value)} autoComplete="off" /></Field><button type="submit" disabled={reading}><FileSearch size={14} />读取并选择批准版本</button></form>
      <ul className="finance-cost-selected-versions" aria-label="本次固定分摊版本">{versions.map(version => <li key={version.id}><div><strong>v{version.versionNumber} · {dimensions[version.preview.dimension]}</strong><Code>{version.id}</Code><small>规则 ID <Code>{version.allocationId}</Code>固定校验值 <Code>{version.checksum}</Code></small></div><div className="finance-cost-actions"><button type="button" onClick={() => onOpen({ kind: "version", id: version.id })}>核对原版本</button><button type="button" aria-label={`移除版本 ${version.id}`} onClick={() => transition.change(() => { if (security.isAuthorized(security.authority)) { setVersions(items => items.filter(item => item.id !== version.id)); setConfirmed(false); } })}><Trash2 size={14} /></button></div></li>)}</ul>
      {!versions.length && <p className="finance-cost-help">尚未固定分摊版本 仅在原事实已有此维度完整归属时才能直接形成完整结果 服务端不会把缺口补为零</p>}
    </div>
    {error && <Notice error>{error}</Notice>}
    {security.canReview && !calculation.commandId && <div className="finance-cost-approval"><label><input type="checkbox" disabled={locked || reading} checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />我已核对原计算、归属维度及以上固定版本 准备一次归属利润计算</label><button type="button" className="primary" disabled={locked || reading || !confirmed} onClick={calculate}><Calculator size={14} />保存归属计算原填写并核对</button></div>}
    <OriginalWriteState write={calculation} noun="归属计算" />
  </div></section>;
}

function AllocationHistory({ security, currentBaseId, onOpen }: { security: Security; currentBaseId: string | null; onOpen(target: DetailTarget): void }) {
  const [kind, setKind] = useState<DetailTarget["kind"]>("version"), [baseDraft, setBaseDraft] = useState(""), [allocationDraft, setAllocationDraft] = useState("");
  const [filters, setFilters] = useState<{ baseRunId?: string; allocationId?: string }>({}), [idDraft, setIdDraft] = useState(""), [error, setError] = useState("");
  const transition = useOwnedViewTransition();
  return <section className="finance-cost-panel" aria-labelledby="finance-cost-history-title"><PanelHeading id="finance-cost-history-title" title="批准版本与归属计算历史" icon={<History size={16} />} /><div className="finance-cost-content">
    <div className="finance-cost-history-tabs" role="group" aria-label="历史记录类型">{(["version", "run"] as const).map(value => <button type="button" key={value} aria-pressed={kind === value} onClick={() => transition.change(() => { if (security.isAuthorized(security.authority)) { setKind(value); setError(""); } })}>{value === "version" ? "批准版本" : "归属计算"}</button>)}</div>
    <form className="finance-cost-history-filters" aria-label="筛选分摊历史" onSubmit={event => { event.preventDefault(); const base = baseDraft.trim(), allocation = allocationDraft.trim(); if (base && !EntityIdSchema.safeParse(base).success || kind === "version" && allocation && !EntityIdSchema.safeParse(allocation).success) { setError("历史筛选必须填写真实的原计算或分摊规则 ID"); return; } setError(""); setFilters({ ...(base ? { baseRunId: base.toLowerCase() } : {}), ...(kind === "version" && allocation ? { allocationId: allocation.toLowerCase() } : {}) }); }}><Field label="历史原计算 ID 筛选" help="留空读取有权限的历史记录"><input value={baseDraft} maxLength={36} onChange={event => setBaseDraft(event.target.value)} autoComplete="off" /></Field>{kind === "version" && <Field label="分摊规则 ID 筛选"><input value={allocationDraft} maxLength={36} onChange={event => setAllocationDraft(event.target.value)} autoComplete="off" /></Field>}<div className="finance-cost-actions"><button type="submit">应用历史筛选</button>{currentBaseId && <button type="button" onClick={() => { setBaseDraft(currentBaseId); setAllocationDraft(""); setFilters({ baseRunId: currentBaseId }); setError(""); }}>只读当前原计算历史</button>}<button type="button" onClick={() => { setBaseDraft(""); setAllocationDraft(""); setFilters({}); setError(""); }}>清除历史筛选</button></div></form>
    <form className="finance-cost-inline-form" aria-label="按 ID 读取历史详情" onSubmit={event => { event.preventDefault(); const parsed = EntityIdSchema.safeParse(idDraft.trim()); if (!parsed.success) { setError("请填写真实历史版本或归属计算 ID"); return; } setError(""); onOpen({ kind, id: parsed.data.toLowerCase() }); }}><Field label={kind === "version" ? "历史批准版本 ID" : "历史归属计算 ID"}><input value={idDraft} required maxLength={36} onChange={event => setIdDraft(event.target.value)} autoComplete="off" /></Field><button type="submit"><FileSearch size={14} />按 ID 读取历史详情</button></form>
    {error && <Notice error>{error}</Notice>}
    {kind === "version" ? <VersionHistoryPage key={JSON.stringify(filters)} filters={filters} security={security} onOpen={onOpen} /> : <RunHistoryPage key={filters.baseRunId ?? "all"} baseRunId={filters.baseRunId} security={security} onOpen={onOpen} />}
  </div></section>;
}

function VersionHistoryPage({ filters, security, onOpen }: { filters: { baseRunId?: string; allocationId?: string }; security: Security; onOpen(target: DetailTarget): void }) {
  const params = new URLSearchParams(); if (filters.baseRunId) params.set("baseRunId", filters.baseRunId); if (filters.allocationId) params.set("allocationId", filters.allocationId);
  const page = useAllocationPage(`versions${params.size ? `?${params}` : ""}`, FinanceCostAllocationVersionPageSchema, security);
  return <><ReadState state={page} />{page.data && !page.data.items.length && <Empty>本页没有符合筛选的批准版本</Empty>}<ul className="finance-cost-history-list">{page.data?.items.map(version => <li key={version.id}><div><strong>{dimensions[version.dimension]} · v{version.versionNumber}</strong><Code>{version.id}</Code><span>规则 <Code>{version.allocationId}</Code>原计算 <Code>{version.baseRunId}</Code></span><small>{timeLabel(version.createdAt)} · {version.reportingCurrency} · 原贡献 {version.sourceCount} 笔</small></div><button type="button" onClick={() => onOpen({ kind: "version", id: version.id })}><FileSearch size={14} />读取批准版本</button></li>)}</ul><PageControls page={page} /></>;
}

function RunHistoryPage({ baseRunId, security, onOpen }: { baseRunId?: string; security: Security; onOpen(target: DetailTarget): void }) {
  const page = useAllocationPage(`runs${baseRunId ? `?baseRunId=${baseRunId}` : ""}`, FinanceAllocatedProfitRunPageSchema, security);
  return <><ReadState state={page} />{page.data && !page.data.items.length && <Empty>本页没有符合筛选的归属计算</Empty>}<ul className="finance-cost-history-list">{page.data?.items.map(run => <li key={run.id}><div><strong>{dimensions[run.dimension]} · {run.status === "complete" && !run.basisProblems.length ? "归属完整" : "归属待核对"}</strong><Code>{run.id}</Code><span>原计算 <Code>{run.baseRunId}</Code></span><small>{timeLabel(run.createdAt)} · 固定版本 {run.versionPins.length} 笔</small><span>利润 <Money value={run.status === "complete" && !run.basisProblems.length ? run.profitMinor : null} currency={run.reportingCurrency} /></span><BasisProblems codes={run.basisProblems} /></div><button type="button" onClick={() => onOpen({ kind: "run", id: run.id })}><FileSearch size={14} />读取归属计算</button></li>)}</ul><PageControls page={page} /></>;
}

function AllocationDetailDialog({ target, security, locked, onClose, onUse, onOpen }: { target: DetailTarget; security: Security; locked: boolean; onClose(): void; onUse(version: FinanceCostAllocationVersion, mode: Seed["mode"]): void; onOpen(target: DetailTarget): void }) {
  const [closing, setClosing] = useState(false), timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const title = target.kind === "version" ? "批准分摊版本详情" : "归属利润计算详情";
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const close = (after?: () => void) => { if (closing) return; setClosing(true); timer.current = setTimeout(() => { onClose(); if (security.isAuthorized(security.authority)) after?.(); }, reducedMotion() ? 0 : 160); };
  return <RecordDialog title={title} onClose={() => close()}><div className={`finance-cost-dialog${closing ? " is-closing" : ""}`}>
    {target.kind === "version" ? <VersionDetail id={target.id} security={security} blocked={closing || locked} onUse={(version, mode) => close(() => onUse(version, mode))} /> : <RunDetail id={target.id} security={security} onOpen={onOpen} />}
    <footer className="finance-cost-actions"><button type="button" disabled={closing} onClick={() => close()}>关闭历史详情</button></footer>
  </div></RecordDialog>;
}

function VersionDetail({ id, security, blocked, onUse }: { id: string; security: Security; blocked: boolean; onUse(version: FinanceCostAllocationVersion, mode: Seed["mode"]): void }) {
  const detail = useAllocationRead(`versions/${id}`, FinanceCostAllocationVersionViewSchema, security);
  const version = detail.data?.id === id ? detail.data : null;
  return <><div className="finance-cost-actions"><button type="button" disabled={detail.reading} onClick={() => void detail.reload()}><RefreshCw size={14} />重新读取版本依据</button></div><ReadState state={detail} />{detail.data && !version && <Notice error>返回版本与原 ID 不一致 未显示为所查记录</Notice>}{version && <><VersionReceipt version={version} /><AllocationPreviewSummary preview={version.preview} /><BasisProblems codes={version.basisProblems} /><div className="finance-cost-actions"><button type="button" disabled={blocked || detail.reading || Boolean(detail.error) || Boolean(version.basisProblems.length)} onClick={() => onUse(version, "append")}><GitBranch size={14} />按此版本建立下一版</button><button type="button" disabled={blocked || detail.reading || Boolean(detail.error) || Boolean(version.basisProblems.length)} onClick={() => onUse(version, "calculate")}><Calculator size={14} />按此版本准备归属计算</button></div><p className="finance-cost-help">这些入口只将明确原版本带回本页 核准及计算仍需再次确认 当前页未知原请求结束前不切换填写</p></>}</>;
}

function RunDetail({ id, security, onOpen }: { id: string; security: Security; onOpen(target: DetailTarget): void }) {
  const detail = useAllocationRead(`runs/${id}`, FinanceAllocatedProfitRunViewSchema, security);
  const run = detail.data?.id === id ? detail.data : null;
  return <><div className="finance-cost-actions"><button type="button" disabled={detail.reading} onClick={() => void detail.reload()}><RefreshCw size={14} />重新读取计算依据</button></div><ReadState state={detail} />{detail.data && !run && <Notice error>返回归属计算与原 ID 不一致 未显示为所查记录</Notice>}{run && <><AllocatedProfitSummary run={run} /><section className="finance-cost-detail-section" aria-label="原计算固定版本"><h4>原计算固定版本</h4>{!run.versionPins.length && <p className="finance-cost-help">原计算没有选用分摊版本</p>}<ul className="finance-cost-history-list">{run.versionPins.map(pin => <li key={pin.id}><div><strong>v{pin.versionNumber}</strong><Code>{pin.id}</Code><small>原规则 <Code>{pin.allocationId}</Code>固定校验值 <Code>{pin.checksum}</Code></small></div><button type="button" onClick={() => onOpen({ kind: "version", id: pin.id })}>读取固定版本</button></li>)}</ul></section><SlicePage runId={run.id} currency={run.reportingCurrency} security={security} /></>}</>;
}

function SlicePage({ runId, currency, security }: { runId: string; currency: string; security: Security }) {
  const page = useAllocationPage(`runs/${runId}/slices`, FinanceAllocatedProfitSlicePageSchema, security);
  return <section className="finance-cost-detail-section" aria-label="原计算分配行"><h4>原计算分配行</h4><p className="finance-cost-help">每页独立读取原始分配记录 不用本页求和补出利润总额</p><ReadState state={page} />{page.data && !page.data.items.length && <Empty>本页没有分配行</Empty>}<ul className="finance-cost-slice-list">{page.data?.items.map(slice => <li key={slice.id}><SliceSummary slice={slice} currency={currency} /></li>)}</ul><PageControls page={page} /></section>;
}

export function AllocationPreviewSummary({ preview }: { preview: FinanceCostAllocationPreview }) {
  return <section className="finance-cost-preview" aria-label="精确分摊核对"><h4>精确分摊核对</h4><dl className="finance-cost-pairs"><Pair label="归属维度">{dimensions[preview.dimension]}</Pair><Pair label="分摊方法">{preview.method === "equal" ? "等额 权重固定为1" : "人工精确权重"}</Pair><Pair label="固定算法">最大余数法 v1 · 余数相同时按目标键升序</Pair><Pair label="报告币种">{preview.reportingCurrency}</Pair><Pair label="原因代码">{preview.reasonCode}</Pair><Pair label="人工依据">{preview.basisDescription}</Pair><Pair label="原计算 ID"><Code>{preview.baseRunId}</Code></Pair><Pair label="原输入校验值"><Code>{preview.baseInputChecksum}</Code></Pair><Pair label="本次预览校验值"><Code>{preview.previewChecksum}</Code></Pair></dl>
    <p className="finance-cost-help">每笔原贡献独立守恒 先取最小货币单位整数部分 再按余数排序分配尾差 不对每份金额重新换汇 冲回费用保留原作用方向</p>
    {preview.sources.map(source => <details className="finance-cost-preview-source" key={source.contributionId} open><summary>{factName(source.factType)} · {source.effectSign === -1 ? "冲回成本 −" : "成本 +"} <Money value={source.reportingAmountMinor} currency={source.reportingCurrency} /> · {source.shares.length} 个目标</summary><dl className="finance-cost-pairs"><Pair label="原费用根事实"><Code>{source.rootFactId}</Code></Pair><Pair label="实际原事实"><Code>{source.factId}</Code></Pair><Pair label="原贡献 ID"><Code>{source.contributionId}</Code></Pair><Pair label="原单据 ID"><Code>{source.statementId}</Code></Pair><Pair label="来源分录标识">{source.sourceEntryId ? <Code>{source.sourceEntryId}</Code> : "历史来源分录标识未知"}</Pair><Pair label="源币原金额"><Money value={source.sourceAmountMinor} currency={source.sourceCurrency} /></Pair><Pair label="固定原汇率">{source.fxRateId ? <Code>{source.fxRateId}</Code> : "原贡献未引用汇率"}</Pair><Pair label="固定费用链校验值"><Code>{source.sourceChainChecksum}</Code></Pair></dl><table className="finance-cost-table" aria-label={`精确分摊明细 ${source.contributionId}`}><thead><tr><th>真实目标</th><th>精确权重</th><th>整数部分与余数</th><th>尾差及最终金额</th></tr></thead><tbody>{source.shares.map(share => <tr key={share.target.key}><td data-label="真实目标"><TargetSummary target={share.target} /></td><td data-label="精确权重"><Code>{share.weight}</Code><small>权重整数 {share.weightUnits}</small></td><td data-label="整数部分与余数"><Money value={share.floorMinor} currency={source.reportingCurrency} /><small>余数 {share.remainderNumerator} / {share.remainderDenominator}</small></td><td data-label="尾差及最终金额"><strong><Money value={share.amountMinor} currency={source.reportingCurrency} /></strong><small>{share.receivesRemainder ? "获得1个最小单位尾差" : "未获得额外尾差"}</small><small>{source.effectSign === -1 ? "沿原贡献冲回成本" : "沿原贡献计入成本"}</small></td></tr>)}</tbody></table></details>)}
  </section>;
}

export function AllocatedProfitSummary({ run }: { run: FinanceAllocatedProfitRun }) {
  const verified = run.status === "complete" && run.basisProblems.length === 0;
  return <section className="finance-cost-run" aria-label="归属利润原计算结果"><dl className="finance-cost-pairs"><Pair label="归属计算 ID"><Code>{run.id}</Code></Pair><Pair label="该次归属状态">{verified ? "归属完整" : "归属待核对"}</Pair><Pair label="归属维度">{dimensions[run.dimension]}</Pair><Pair label="记录时间">{timeLabel(run.createdAt)}</Pair><Pair label="原汇总计算 ID"><Code>{run.baseRunId}</Code></Pair><Pair label="原输入校验值"><Code>{run.baseInputChecksum}</Code></Pair><Pair label="本次归属输入校验值"><Code>{run.inputChecksum}</Code></Pair><Pair label="固定算法">最大余数法 v1 原报告币种最小单位守恒</Pair><Pair label="归属收入"><Money value={verified ? run.revenueMinor : null} currency={run.reportingCurrency} /></Pair><Pair label="归属成本"><Money value={verified ? run.costMinor : null} currency={run.reportingCurrency} /></Pair><Pair label="归属利润"><Money value={verified ? run.profitMinor : null} currency={run.reportingCurrency} /></Pair><Pair label="实际核对目标数">{run.diagnostics.checkedTargetCount}</Pair></dl><BasisProblems codes={run.basisProblems} />
    {!verified && <Notice error>归属或当前依据尚未完整核对 不提供确定利润或补零总额 原记录与版本保留</Notice>}
    {run.diagnostics.unallocatedContributionIds.length > 0 && <details open><summary>未归属原贡献 {run.diagnostics.unallocatedContributionIds.length} 笔</summary><ul>{run.diagnostics.unallocatedContributionIds.map(id => <li key={id}><Code>{id}</Code></li>)}</ul></details>}
    {run.diagnostics.missingByTarget.length > 0 && <details open><summary>目标归属缺口 {run.diagnostics.missingByTarget.length} 项</summary><ul>{run.diagnostics.missingByTarget.map(item => <li key={item.key}><Code>{item.key}</Code>{item.missingFactTypes.map(factName).join(" · ")}</li>)}</ul></details>}
    {verified && run.breakdowns.length > 0 && <details open><summary>该次固定目标汇总 {run.breakdowns.length} 项</summary><table className="finance-cost-table" aria-label="归属利润目标汇总"><thead><tr><th>真实目标</th><th>收入</th><th>成本</th><th>利润</th></tr></thead><tbody>{run.breakdowns.map(row => <tr key={row.target.key}><td data-label="真实目标"><TargetSummary target={row.target} /><small>原事实 {row.factCount} 笔</small></td><td data-label="收入"><Money value={row.revenueMinor} currency={run.reportingCurrency} /></td><td data-label="成本"><Money value={row.costMinor} currency={run.reportingCurrency} /></td><td data-label="利润"><Money value={row.profitMinor} currency={run.reportingCurrency} /></td></tr>)}</tbody></table></details>}
    <p className="finance-cost-help">这是该次固定版本归属投影的受权读取 不把当前历史分页拼成总额 后续费用纠正或规则变化需重新明确核对</p>
  </section>;
}

export function SliceSummary({ slice, currency }: { slice: FinanceAllocatedProfitSlice; currency: string }) {
  return <><dl className="finance-cost-pairs"><Pair label="原分配行 ID"><Code>{slice.id}</Code></Pair><Pair label="分配金额"><Money value={slice.amountMinor} currency={currency} /> · {slice.effectSign === -1 ? "反向作用 −" : "原方向 +"} · {slice.bucket === "revenue" ? "收入" : slice.bucket === "cost" ? "成本" : "口径未分类"}</Pair><Pair label="原报告金额"><Money value={slice.originalReportingAmountMinor} currency={currency} /></Pair><Pair label="费用类别">{factName(slice.factType)}</Pair><Pair label="原贡献 ID"><Code>{slice.baseContributionId}</Code></Pair><Pair label="原事实 ID"><Code>{slice.sourceFactId}</Code></Pair><Pair label="根事实 ID"><Code>{slice.rootFactId}</Code></Pair><Pair label="固定分摊版本">{slice.allocationVersionId ? <Code>{slice.allocationVersionId}</Code> : slice.target ? "原事实直接归属 未使用分摊版本" : "尚未归属 未使用分摊版本"}</Pair><Pair label="固定权重">{slice.weight ?? "未使用分摊权重"}</Pair><Pair label="尾差">{slice.receivesRemainder ? "此份获得1个最小单位尾差" : "未获得额外尾差"}{slice.remainderNumerator !== null && <small>原余数 {slice.remainderNumerator} / {slice.remainderDenominator}</small>}</Pair></dl>{slice.target ? <TargetSummary target={slice.target} /> : <p className="finance-cost-warning">此原贡献尚未归属实际目标</p>}</>;
}

function VersionReceipt({ version }: { version: FinanceCostAllocationVersion }) {
  return <dl className="finance-cost-pairs"><Pair label="实际批准版本 ID"><Code>{version.id}</Code></Pair><Pair label="实际分摊规则 ID"><Code>{version.allocationId}</Code></Pair><Pair label="固定版本">v{version.versionNumber}</Pair><Pair label="原前版">{version.previousVersionId ? <Code>{version.previousVersionId}</Code> : "首个批准版本"}</Pair><Pair label="实际批准者 ID"><Code>{version.reviewedBy}</Code></Pair><Pair label="实际登记时间">{timeLabel(version.createdAt)}</Pair><Pair label="批准凭据校验值"><Code>{version.checksum}</Code></Pair></dl>;
}

function TargetSummary({ target }: { target: FinanceCostAllocationTarget }) {
  return <div className="finance-cost-target-summary"><strong>{target.label}</strong><Code>{target.key}</Code><small>{dimensions[target.dimension]}</small>{target.dimension === "order_line" && <small>所属订单 <Code>{target.orderId}</Code>{target.skuId && <>实际 SKU <Code>{target.skuId}</Code></>}{target.listingId && <>实际刊登 <Code>{target.listingId}</Code></>}</small>}{target.dimension === "period" && <small>UTC 范围 [{target.periodStart}, {target.periodEnd})</small>}<details><summary>目标依据校验值</summary><Code>{target.basisChecksum}</Code></details></div>;
}
function BasisProblems({ codes }: { codes: Array<keyof typeof basisNames> }) { return codes.length > 0 ? <p className="finance-cost-warning" role="status">本次读取依据待核对 {codes.map(code => basisNames[code]).join(" · ")}</p> : null; }

function useAllocationRead<T>(path: string | null, schema: z.ZodType<T>, { authority, isAuthorized, onDenied }: Security) {
  const [snapshot, setSnapshot] = useState<{ path: string; authority: string | null; value: T; readAt: string; token: number } | null>(null);
  const [reading, setReading] = useState(false), [error, setError] = useState("");
  const sequence = useRef(0), live = useRef(true), controller = useRef<AbortController | null>(null), latest = useRef({ path, authority });
  const transition = useOwnedViewTransition(); latest.current = { path, authority };
  const cancel = useCallback(() => { sequence.current++; controller.current?.abort(); transition.cancel(); if (live.current) setReading(false); }, [transition]);
  useLayoutEffect(() => { cancel(); setSnapshot(null); setError(""); }, [path, authority, cancel]);
  useLayoutEffect(() => () => { sequence.current++; controller.current?.abort(); transition.cancel(); }, [transition]);
  const reload = useCallback(async () => {
    if (!path || !isAuthorized(authority)) return;
    const token = ++sequence.current, abort = new AbortController(); controller.current?.abort(); controller.current = abort;
    const valid = () => live.current && token === sequence.current && latest.current.path === path && latest.current.authority === authority && isAuthorized(authority);
    setReading(true); setError("");
    try {
      const value = await allocationRequest(path, schema, { signal: abort.signal });
      const readAt = new Date().toISOString(); if (valid()) transition.change(() => { if (valid()) { setSnapshot({ path, authority, value, readAt, token }); setError(""); } });
    } catch (failure) {
      if (abort.signal.aborted || !valid()) return;
      if (isDenied(failure)) { setSnapshot(null); onDenied(failure.message); } else setError(publicError(failure));
    } finally { if (valid()) setReading(false); }
  }, [path, schema, authority, isAuthorized, onDenied, transition]);
  useEffect(() => { live.current = true; return () => { live.current = false; cancel(); }; }, [cancel]);
  useEffect(() => { void reload(); return cancel; }, [reload, cancel]);
  const current = path !== null && snapshot?.path === path && snapshot.authority === authority && snapshot.token === sequence.current ? snapshot : null;
  return { data: current?.value ?? null, readAt: current?.readAt ?? null, reading, error, reload, cancel };
}

function useAllocationPage<T>(path: string | null, schema: z.ZodType<Page<T>>, security: Security) {
  const [cursor, setCursor] = useState<string | null>(null), [previous, setPrevious] = useState<Array<string | null>>([]), [cursorScope, setCursorScope] = useState(path);
  const transition = useOwnedViewTransition(), scoped = cursorScope === path;
  const actualCursor = scoped ? cursor : null;
  const read = useAllocationRead(path ? `${path}${path.includes("?") ? "&" : "?"}limit=25${actualCursor ? `&cursor=${actualCursor}` : ""}` : null, schema, security);
  useLayoutEffect(() => { if (!scoped) { setCursorScope(path); setCursor(null); setPrevious([]); } }, [scoped, path]);
  const move = (next: string | null, backwards = false) => {
    if (read.reading || read.error || !security.isAuthorized(security.authority)) return;
    read.cancel(); transition.change(() => { if (security.isAuthorized(security.authority)) { setPrevious(items => backwards ? items.slice(0, -1) : [...items, actualCursor]); setCursor(next); } });
  };
  const first = () => { read.cancel(); transition.change(() => { if (security.isAuthorized(security.authority)) { setCursor(null); setPrevious([]); if (actualCursor === null) void read.reload(); } }); };
  return { ...read, hasPrevious: scoped && previous.length > 0, next: () => { if (read.data?.nextCursor) move(read.data.nextCursor); }, back: () => { if (previous.length) move(previous[previous.length - 1] ?? null, true); }, first };
}

type RetainedWrite = {
  original: { body: string; key: string } | null; commandId: string | null;
  pending: boolean; checking: boolean; locked: boolean; error: string; reviewOpen: boolean;
  retry(): Promise<void>; reload(): Promise<void>; closeReview(): void; openReview(): void;
  finish(detail: FinanceCommandDetail): void; denied(message: string): void;
};
function useOriginalWrite(path: "versions" | "runs", scope: FinanceCommandScope, security: Security, onRecorded: () => void, onFinish: () => void) {
  const preparation = useFinanceCommandPreparation(scope, security.canReview), [reviewOpen, setReviewOpen] = useState(true), [error, setError] = useState("");
  useEffect(() => { if (preparation.denied) security.onDenied(preparation.error); }, [preparation.denied, preparation.error, security]);
  const submit = async (input: { idempotencyKey: string }) => {
    if (!security.isAuthorized(security.authority, true)) return;
    try {
      if (scope.kind !== (path === "versions" ? "cost_version_approve" : "allocated_profit_calculate")) throw new Error("原提交类型与分摊入口不一致");
      setError(""); setReviewOpen(true); await preparation.prepare(PrepareFinanceCommandSchema.parse({ ...scope, input }));
    } catch { setError("原填写与固定分摊依据尚不可核对 未新建替代请求"); }
  };
  return {
    original: preparation.original ? { body: JSON.stringify(preparation.original), key: preparation.original.input.idempotencyKey } : null,
    commandId: preparation.commandId, pending: preparation.pending, checking: preparation.checking, locked: preparation.locked, error: error || preparation.error, reviewOpen,
    submit, retry: () => preparation.prepare(), reload: preparation.reload, closeReview: () => setReviewOpen(false), openReview: () => setReviewOpen(true),
    finish: (detail: FinanceCommandDetail) => { preparation.finish(); if (detail.result) onRecorded(); onFinish(); }, denied: security.onDenied,
  };
}

function OriginalWriteState({ write, noun }: { write: RetainedWrite; noun: string }) {
  if (write.commandId) return <div className="finance-cost-original" aria-label={`${noun}原请求`}>{write.reviewOpen ? <FinanceCommandReview commandId={write.commandId} onClose={write.closeReview} onFinished={write.finish} onDenied={write.denied} /> : <><Notice>核对已关闭 原提交与实际凭据仍由服务端保留 可在此处或本人财务原提交恢复</Notice><button type="button" onClick={write.openReview}>恢复这笔财务原提交</button></>}</div>;
  if (write.checking) return <p className="finance-cost-help" role="status">正在读取此操作的本人原提交</p>;
  if (!write.original && !write.error) return null;
  return <div className="finance-cost-original" aria-label={`${noun}原请求`}>
    {write.original && <p>固定原请求键 <Code>{write.original.key}</Code></p>}
    {write.pending ? <Notice>正在保存原{noun} 请等待真实准备凭据</Notice> : <>{write.error && <Notice error>{write.error}</Notice>}<div className="finance-cost-actions">{write.original && <button type="button" onClick={() => void write.retry()}><RefreshCw size={14} />重试保存同一笔原提交</button>}<button type="button" onClick={() => void write.reload()}>重新读取此操作的原提交</button></div></>}
    <p className="finance-cost-help">准备响应未知时只保存同一原文与键 执行响应未知时只读取命令 关页后可到本人财务原提交恢复 不自动换键、批准或计算</p>
  </div>;
}

class AllocationError extends Error {
  readonly uncertain: boolean;
  constructor(readonly status: number, message: string, code: string | null = null) { super(message); this.uncertain = status === 0 || status >= 500 || status === 408 || code === "authority_changed"; }
}
async function allocationRequest<T>(path: string, schema: z.ZodType<T>, options: { signal?: AbortSignal; body?: string } = {}): Promise<T> {
  let response: Response;
  try { response = await fetch(`/api/finance/cost-allocations/${path}`, { method: options.body === undefined ? "GET" : "POST", credentials: "same-origin", cache: "no-store", redirect: "error", headers: { accept: "application/json", ...(options.body === undefined ? {} : { "content-type": "application/json" }) }, body: options.body, signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(25_000)]) : AbortSignal.timeout(25_000) }); }
  catch { throw new AllocationError(0, options.body === undefined ? "读取连接中断 请重新读取原记录" : "提交连接中断 原操作结果待核对"); }
  if (!response.ok) {
    let code: string | null = null;
    try { const failure: unknown = await response.json(); if (failure && typeof failure === "object" && "code" in failure && typeof failure.code === "string") code = failure.code; } catch { /* Never display upstream bodies. */ }
    const messages: Record<number, string> = { 400: "编号、权重、期间或游标格式不符 请核对原文", 401: "本人 ERP 会话已失效 请重新核对登录", 403: "当前本人财务权限不足", 404: "原记录或业务依据不存在或当前不可访问", 409: "原计算、费用链、目标或分摊版本依据已变化 请重新读取实际历史并核对", 422: "分摊输入无法通过精确核对 未自动修改权重或金额", 429: "请求过于频繁 请稍后重试" };
    throw new AllocationError(response.status, messages[response.status] ?? "费用分摊暂未返回可核对的实际凭据", code);
  }
  try { const parsed = schema.safeParse(await response.json()); if (parsed.success) return parsed.data; } catch { /* Only shared-schema records reach the interface. */ }
  throw new AllocationError(502, "返回格式暂无法核对 请保留原请求或重新读取历史");
}
function isDenied(failure: unknown): failure is AllocationError { return failure instanceof AllocationError && (failure.status === 401 || failure.status === 403); }
function publicError(failure: unknown) { return failure instanceof AllocationError ? failure.message : "暂时无法核对真实分摊记录 请保留原请求并稍后重读"; }

function previewMatches(input: FinanceCostAllocationPreviewInput, preview: FinanceCostAllocationPreview) {
  if (preview.baseRunId !== input.baseRunId || preview.baseInputChecksum !== input.baseInputChecksum || preview.dimension !== input.dimension || preview.method !== input.method || preview.allocationId !== input.allocationId || preview.expectedVersion !== input.expectedVersion || preview.reasonCode !== input.reasonCode || preview.basisDescription !== input.basisDescription) return false;
  const keyOf = (rows: Array<{ key: string; weight: string }>) => JSON.stringify([...rows].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const wanted = new Map(input.sources.map(source => [source.rootFactId, keyOf(source.targets)])), seen = new Set<string>();
  for (const source of preview.sources) { if (wanted.get(source.rootFactId) !== keyOf(source.shares.map(share => ({ key: share.target.key, weight: share.weight })))) return false; seen.add(source.rootFactId); }
  return seen.size === wanted.size;
}
function draftFromVersion(version: FinanceCostAllocationVersion): DraftSource[] {
  const roots = new Map<string, DraftSource>();
  for (const source of version.preview.sources) if (!roots.has(source.rootFactId)) roots.set(source.rootFactId, { rootFactId: source.rootFactId, label: `原费用 ${source.rootFactId}`, targets: source.shares.map(share => ({ target: share.target, weight: share.weight })) });
  return [...roots.values()];
}
function PageControls({ page }: { page: { data: Page<unknown> | null; reading: boolean; error: string; hasPrevious: boolean; next(): void; back(): void; first(): void } }) {
  return <footer className="finance-cost-pagination"><div className="finance-cost-actions"><button type="button" disabled={page.reading || !page.hasPrevious || Boolean(page.error)} onClick={page.back}><ArrowLeft size={13} />返回已读前页</button><button type="button" disabled={page.reading || !page.data?.hasMore || Boolean(page.error)} onClick={page.next}>读取下一页<ArrowRight size={13} /></button><button type="button" disabled={page.reading} onClick={page.first}><RefreshCw size={13} />重新读取首页</button></div><p className="finance-cost-help">每页最多25笔 按登记键降序实时读取 非时间排序或一致性快照 不由当前页推断全量{page.data?.upperBoundKey && <><br />本轮登记键上界 <Code>{page.data.upperBoundKey}</Code></>}</p></footer>;
}
function ReadState({ state }: { state: { reading: boolean; error: string; data: unknown; readAt?: string | null } }) { return <>{state.reading && <p className="finance-cost-help" role="status">正在读取真实记录{state.data ? " 下方保留上次读取 需等待本次核对" : ""}</p>}{state.error && <Notice error>{state.error}{state.data ? " 下方为上次读取记录 请重新读取核对" : ""}</Notice>}{state.readAt && !state.reading && !state.error && <p className="finance-cost-read-at">本次读取 {timeLabel(state.readAt)}</p>}</>; }
function PanelHeading({ id, title, icon }: { id: string; title: string; icon: ReactNode }) { return <header className="finance-cost-panel-heading">{icon}<h3 id={id}>{title}</h3></header>; }
function Pair({ label, children }: { label: string; children: ReactNode }) { return <div><dt>{label}</dt><dd>{children}</dd></div>; }
function Code({ children }: { children: ReactNode }) { return <code className="finance-cost-code">{children}</code>; }
function Money({ value, currency }: { value: number | null; currency: string }) { return <span className={`finance-cost-money${value === null ? " is-unknown" : ""}`}>{value === null ? "金额待核对" : formatFinanceMinorAmount(value, currency)}</span>; }
function Notice({ error = false, children }: { error?: boolean; children: ReactNode }) { return <div className={`finance-cost-notice${error ? " is-error" : ""}`} role={error ? "alert" : "status"}>{error && <CircleAlert size={15} />}<div>{children}</div></div>; }
function Empty({ children }: { children: ReactNode }) { return <p className="finance-cost-empty" role="status">{children}</p>; }
function timeLabel(value: string) { return new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "medium", hour12: false }).format(new Date(value)); }
function reducedMotion() { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; }
function factName(value: string) { const names: Record<string, string> = { sale_revenue: "销售收入", shipping_revenue: "运费收入", marketplace_commission: "平台佣金", advertising_spend: "广告支出", fulfillment_fee: "履约费", storage_fee: "仓储费", refund: "退款", chargeback: "拒付", procurement_cost: "采购成本", production_cost: "生产成本", freight_cost: "运输成本", carrier_cost: "承运成本", tax: "税费", other_fee: "其他费用" }; return names[value] ?? value; }
