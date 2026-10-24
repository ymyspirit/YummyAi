"use client";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { flushSync } from "react-dom";
import { ChevronDown, Layers, Plus, RefreshCw } from "lucide-react";
import { Permission } from "@yummyai/authz/permissions";
import { QualityGroupsWorkspaceSchema, QualityPhysicalGroupInputSchema, RecordQualityGroupsInputSchema,
  evaluateQualityGroups, type QualityGroupsWorkspace } from "@yummyai/contracts/order/quality-groups";
import { CreateProductionRecoveryInputSchema } from "@yummyai/contracts/order/production";
import { centerRequest, dateTime, label, OrderCenterRequestError } from "./order-center-model";
import { formFingerprint } from "../navigation/use-form-edits";
import { cancelViewTransitions, observeViewTransition } from "../navigation/view-transition";
import { blankQualityGroup, QualityGroupFields, readQualityGroupDrafts, type GroupStandard, type QualityGroupDraft } from "./quality-group-fields";
import { ProductionManufacturingFields, readProductionManufacturingSelection } from "./production-manufacturing-fields";
import type { FactoryProductionPin } from "@yummyai/contracts/suppliers/factory-directory";
import { ProductionCapacityPicker, readProductionCapacitySelection } from "./production-capacity-picker";
import { useErpAccess } from "../identity/erp-access";
import { QualityScrapWorkspace } from "./quality-scrap-workspace";
import { FulfillmentCommandPrepareButton, useFulfillmentCommandScope } from "./fulfillment-command-recovery";
import { fulfillmentCommandForOperation } from "./fulfillment-command-intent";
import { useAgentFulfillmentProposalHandoff, useAgentFulfillmentProposalInput, agentFulfillmentProposalLocalTime } from "../ai-tasks/agent-fulfillment-proposal-handoff";

type Mode = { kind: "inspect"; parentGroupId: string | null } | { kind: "remake"; groupId: string };
type Intent = { scope: string; path: string; payload: Record<string, unknown>; key: string; kind: Mode["kind"]; form: HTMLFormElement; fingerprint: string };
const pin = (value: QualityGroupsWorkspace) => JSON.stringify({ version: value.productionVersionId, projection: value.projectionVersion, root: value.rootInspectionId,
  quantity: value.quantity, authority: value.contextAuthority, access: value.access,
  groups: value.groups.map(group => [group.id, group.active, group.shippedQuantity, group.remakeQuantity, group.scrappedQuantity, group.reinspectableQuantity,
    group.remakeEligible, group.remainingRemakeQuantity, group.remainingScrapRemakeQuantity, group.scrapBasisFingerprint, group.quantityBlockers]), blockers: value.blockers });
const deniedRequest = (cause: unknown) => cause instanceof OrderCenterRequestError && ([401, 403, 404].includes(cause.status) || cause.code === "authority_changed");
const transition = (update: () => void) => {
  if (document.startViewTransition && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    cancelViewTransitions(); observeViewTransition(document.startViewTransition(() => flushSync(update)));
  } else update();
};

export function QualityGroupsPanel({ productionOrderId, lineId, standards, refresh, disabled, onEditsChanged, onSaved, factoryPin }: {
  productionOrderId: string; lineId: string; standards: GroupStandard[]; refresh: string; disabled: boolean; onEditsChanged(): void;
  factoryPin?: FactoryProductionPin | null;
  onSaved(form: HTMLFormElement, fingerprint: string, message: string): void;
}) {
  const fulfillment = useFulfillmentCommandScope(), savedNotRefreshed = useRef(false);
  const proposalHandoff = useAgentFulfillmentProposalHandoff(), inspectionSuggestion = useAgentFulfillmentProposalInput("quality_group_inspection", productionOrderId),
    recoverySuggestion = useAgentFulfillmentProposalInput("production_recovery", productionOrderId);
  const access = useErpAccess(), canRead = access.canTenant(Permission.OrderRead), canWrite = access.canTenant(Permission.OrderWrite);
  const scope = JSON.stringify([access.preferenceScope, access.authority, productionOrderId, lineId, canRead, canWrite]);
  const [deniedScope, setDeniedScope] = useState("");
  const [ready, setReady] = useState(false), [open, setOpen] = useState(false), [snapshot, setSnapshot] = useState<{ scope: string; value: QualityGroupsWorkspace } | null>(null),
    [editing, setEditing] = useState<{ scope: string; value: QualityGroupsWorkspace } | null>(null), [reading, setReading] = useState(false), [readFailed, setReadFailed] = useState(false),
    [reload, setReload] = useState(0), [error, setError] = useState(""), [saving, setSaving] = useState(false), [pending, setPending] = useState<Intent | null>(null),
    [mode, setMode] = useState<Mode | null>(null), [groups, setGroups] = useState<QualityGroupDraft[]>([blankQualityGroup()]), [standardId, setStandardId] = useState(""),
    [inspectedAt, setInspectedAt] = useState(""), [confirmed, setConfirmed] = useState(false),
    [remakeQuantity, setRemakeQuantity] = useState(""), [defectId, setDefectId] = useState(""), [reason, setReason] = useState(""), [completionAt, setCompletionAt] = useState("");
  const nextGroup = useRef(1), alive = useRef(true), requestActive = useRef<{ scope: string; epoch: number } | null>(null);
  const readSequence = useRef(0), writeEpoch = useRef(0), activeRead = useRef<AbortController | null>(null), live = useRef({ scope, canRead, canWrite });
  live.current = { scope, canRead, canWrite };
  const permitted = canRead && deniedScope !== scope, current = permitted && snapshot?.scope === scope ? snapshot.value : null;
  const basis = permitted && editing?.scope === scope ? editing.value : null;
  const writable = canWrite && !!current && (current.access?.canWrite === true || access.localDevelopment && !current.access);
  const [manufacturingReady, setManufacturingReady] = useState(false), [draftRevision, setDraftRevision] = useState(0);
  const [capacityReady, setCapacityReady] = useState(false);
  useEffect(() => { alive.current = true; setReady(true); return () => { alive.current = false; readSequence.current++; writeEpoch.current++; activeRead.current?.abort(); }; }, []);
  useLayoutEffect(() => { onEditsChanged(); }, [groups, confirmed, standardId, inspectedAt, remakeQuantity, defectId, reason, completionAt, onEditsChanged]);
  const clearDraft = useCallback(() => { setMode(null); setEditing(null); setGroups([blankQualityGroup()]); nextGroup.current = 1; setStandardId(""); setInspectedAt(""); setConfirmed(false);
    setRemakeQuantity(""); setDefectId(""); setReason(""); setCompletionAt(""); setManufacturingReady(false); setCapacityReady(false); setDraftRevision(value => value + 1); }, []);
  useLayoutEffect(() => {
    readSequence.current++; writeEpoch.current++; activeRead.current?.abort(); requestActive.current = null;
    setSnapshot(null); setPending(null); clearDraft(); setOpen(false); setSaving(false); setReading(false); setReadFailed(false); setError(""); setDeniedScope("");
  }, [scope, clearDraft]);
  const deny = useCallback(() => {
    readSequence.current++; writeEpoch.current++; activeRead.current?.abort(); requestActive.current = null;
    setDeniedScope(scope); setSnapshot(null); setPending(null); clearDraft(); setReading(false); setSaving(false); setReadFailed(true); setError("");
    window.dispatchEvent(new Event("focus"));
  }, [scope, clearDraft]);
  function transitionDraft(update: () => void) {
    const epoch = writeEpoch.current;
    transition(() => { if (alive.current && live.current.scope === scope && live.current.canRead && writeEpoch.current === epoch) update(); });
  }
  useEffect(() => {
    if (!open || !permitted) return;
    const abort = new AbortController(); activeRead.current?.abort(); activeRead.current = abort; const token = ++readSequence.current;
    const valid = () => !abort.signal.aborted && live.current.scope === scope && live.current.canRead && token === readSequence.current;
    setReading(true); setReadFailed(false);
    void centerRequest(`production/${productionOrderId}/quality-groups`, undefined, AbortSignal.any([abort.signal, AbortSignal.timeout(20_000)])).then(raw => {
      if (!valid()) return;
      const value = QualityGroupsWorkspaceSchema.parse(raw);
      if (value.productionOrderId !== productionOrderId) throw new OrderCenterRequestError(502, "实物组与本次原生产不一致 请重新读取");
      if (!access.localDevelopment && (!access.authority || value.contextAuthority !== access.authority || !value.access?.canRead))
        throw new OrderCenterRequestError(409, "当前身份或权限范围已变化 旧实物组与填写已清除", "authority_changed");
      setSnapshot({ scope, value }); savedNotRefreshed.current = false; setError("");
    }).catch(cause => {
      if (!valid()) return;
      setReadFailed(true); setError(savedNotRefreshed.current ? "本次原检验或补做已保存 当前实物组暂时无法刷新 请重新读取 不重复提交"
        : cause instanceof OrderCenterRequestError ? cause.message : "分组记录暂时无法核对 请保留填写后重新读取");
      if (deniedRequest(cause)) deny();
    }).finally(() => { if (valid()) setReading(false); });
    return () => abort.abort();
  }, [open, productionOrderId, refresh, reload, scope, permitted, access.authority, access.localDevelopment, deny]);
  const stale = !!basis && !!current && pin(basis) !== pin(current), standard = standards.find(item => item.id === standardId);
  const parent = mode?.kind === "inspect" && mode.parentGroupId ? basis?.groups.find(group => group.id === mode.parentGroupId) : null;
  const target = mode?.kind === "remake" ? basis?.groups.find(group => group.id === mode.groupId) : null;
  const requiredQuantity = parent ? parent.reinspectableQuantity ?? (access.localDevelopment ? parent.quantity : null) : basis?.quantity ?? null;
  const selectedDefect = target?.defects.find(defect => defect.id === defectId);
  const remakeMaximum = target ? selectedDefect?.disposition === "scrap" ? target.remainingScrapRemakeQuantity ?? 0 : target.remainingRemakeQuantity : 0;
  const validRemakeQuantity = !!target && !!selectedDefect && /^[1-9][0-9]*$/.test(remakeQuantity) && Number.isSafeInteger(Number(remakeQuantity)) && Number(remakeQuantity) <= remakeMaximum;
  const parsedGroups = standard ? QualityPhysicalGroupInputSchema.array().min(1).safeParse(readQualityGroupDrafts(groups, standard)) : null;
  const evaluation = standard && parsedGroups?.success && requiredQuantity !== null ? evaluateQualityGroups(standard, parsedGroups.data, requiredQuantity) : null;
  const blocked = disabled || !writable || reading || readFailed || saving || stale || !current || !!current.blockers.length
    || !fulfillment || fulfillment.blocked || fulfillment.busy;
  const changed = !!standardId || !!inspectedAt || !!reason || !!completionAt || !!remakeQuantity || groups.some(group => !!group.label || !!group.quantity || Object.keys(group.ratings).length > 0 || group.defects.length > 0);
  function begin(next: Mode) {
    if (!current || blocked || pending) return;
    const selected = next.kind === "inspect" ? next.parentGroupId ? current.groups.find(group => group.id === next.parentGroupId) : null
      : current.groups.find(group => group.id === next.groupId);
    if (next.kind === "inspect" && next.parentGroupId && (!selected?.active || (selected.reinspectableQuantity ?? (access.localDevelopment ? selected.quantity : 0)) < 1)) return;
    if (next.kind === "remake" && (!selected || selected.result !== "failed" || !(selected.remakeEligible ?? (access.localDevelopment && selected.active)))) return;
    if (mode && changed && !window.confirm("切换检验范围或补做会清空本次未保存填写 是否继续")) return;
    transitionDraft(() => {
      clearDraft(); setEditing({ scope, value: current }); setMode(next); setError("");
      if (next.kind === "inspect" && inspectionSuggestion) {
        if (standards.some(value => value.id === inspectionSuggestion.qualityStandardVersionId)) setStandardId(inspectionSuggestion.qualityStandardVersionId!);
        setInspectedAt(agentFulfillmentProposalLocalTime(inspectionSuggestion.inspectedAt));
        if (inspectionSuggestion.groups?.length) setGroups(inspectionSuggestion.groups.map((group, index) => ({ key: group.key ?? "group-" + (index + 1), label: group.label ?? "",
          quantity: group.quantity === undefined ? "" : String(group.quantity), ratings: Object.fromEntries((group.criterionResults ?? []).flatMap(value => value.code ? [[value.code,
            { score: typeof value.scoreBps === "number" ? String(value.scoreBps / 100) : "", outcome: typeof value.passed === "boolean" ? value.passed ? "passed" : "failed" : "" }]] : [])),
          defects: (group.defects ?? []).map((defect, number) => ({ key: "suggested-" + index + ":" + number, code: defect.code ?? "", severity: defect.severity ?? "",
            responsibility: defect.responsibility ?? "", disposition: defect.disposition ?? "", note: defect.note ?? "" })) })));
      } else if (next.kind === "remake" && recoverySuggestion && recoverySuggestion.qualityGroupId === next.groupId) {
        setRemakeQuantity(recoverySuggestion.remakeQuantity == null ? "" : String(recoverySuggestion.remakeQuantity)); setDefectId(recoverySuggestion.defectId ?? "");
        setReason(recoverySuggestion.reason ?? ""); setCompletionAt(factoryPin?.factoryProfile.timeZone ? agentFulfillmentProposalLocalTime(recoverySuggestion.expectedCompletionAt, factoryPin.factoryProfile.timeZone) : "");
      }
      setConfirmed(false);
    });
  }
  async function perform(intent: Intent, prepareOnly = false) {
    if (proposalHandoff && !prepareOnly) { setError("当前是模型提案补项 请只保存原准备 不直接登记实物质检或补做"); return; }
    if (requestActive.current || disabled || !writable || intent.scope !== live.current.scope || !fulfillment || fulfillment.blocked || fulfillment.busy) return;
    const epoch = writeEpoch.current, ticket = { scope: intent.scope, epoch }; requestActive.current = ticket;
    const valid = () => alive.current && live.current.scope === intent.scope && live.current.canRead && live.current.canWrite && writeEpoch.current === epoch;
    setSaving(true); setPending(intent); setError("");
    try {
      const command = fulfillmentCommandForOperation(intent.path, { ...intent.payload, idempotencyKey: intent.key }, { orderId: fulfillment.orderId });
      if (!command) throw new Error("这项原实物操作尚未注册履约恢复 未发送业务写入");
      if (prepareOnly) {
        await fulfillment.prepareAgent(command);
        if (!valid()) return;
        onSaved(intent.form, intent.fingerprint, "本次只保存实物组原填写 尚未登记质检或补做 请到 AI 工作台核对后逐笔明确执行");
        setPending(null); clearDraft(); return;
      }
      const saved = await fulfillment.submit(command);
      if (!valid()) return;
      let message: string;
      if (intent.kind === "inspect") {
        if (saved.receipt?.kind !== "quality_group_inspection" || saved.receipt.productionOrderId !== productionOrderId) throw new Error("原分组质检回执不属于本次生产 请只读核对原提交");
        message = "实物分组检验已保存 合格与待处理数量分别保留 原检验 " + saved.receipt.inspectionId;
      } else {
        if (saved.receipt?.kind !== "production_recovery" || !saved.receipt.replacementProductionOrderId) throw new Error("补做回执缺少关联生产单");
        message = "已建立本组补做任务 原缺陷与实物余额保留";
      }
      savedNotRefreshed.current = true;
      onSaved(intent.form, intent.fingerprint, message); setPending(null); clearDraft(); setReload(value => value + 1);
    } catch (cause) {
      if (!valid()) return;
      setPending(null);
      setError((cause instanceof OrderCenterRequestError ? cause.message : "提交结果尚未确认") + " 请在本单原履约提交恢复区只读核对 不重复提交");
      if (deniedRequest(cause)) deny();
    } finally { if (requestActive.current === ticket) requestActive.current = null; if (valid()) setSaving(false); }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (blocked || pending || !basis || !mode) return;
    const prepareOnly = (event.nativeEvent as SubmitEvent).submitter?.getAttribute("data-agent-fulfillment-prepare") === "true";
    if (prepareOnly && !fulfillment?.canPrepareAgent) return;
    if (mode.kind === "inspect" && (requiredQuantity === null || requiredQuantity < 1 || !evaluation || evaluation.problems.length)) return;
    if (mode.kind === "remake" && (!validRemakeQuantity || !(target?.remakeEligible ?? (access.localDevelopment && target?.active)))) return;
    if (mode.kind === "remake" && (!manufacturingReady || !capacityReady || !factoryPin)) { setError("请先核对本组补做的原工厂 固定制造版本 数量单位与共享产能"); return; }
    try {
      const key = proposalHandoff?.slotId || crypto.randomUUID();
      const payload = mode.kind === "inspect" ? RecordQualityGroupsInputSchema.parse({ formatVersion: 3, productionVersionId: basis.productionVersionId,
        expectedProductionProjectionVersion: basis.projectionVersion, expectedRootInspectionId: basis.rootInspectionId, parentGroupId: mode.parentGroupId,
        qualityStandardVersionId: standardId, inspectedAt: new Date(inspectedAt).toISOString(), groups: standard ? readQualityGroupDrafts(groups, standard) : [],
        segregationConfirmed: confirmed, evidenceAssetIds: [], idempotencyKey: key }) : CreateProductionRecoveryInputSchema.parse({ type: "remake",
        originalProductionOrderId: productionOrderId, qualityGroupId: mode.groupId, defectId, remakeQuantity: Number(remakeQuantity),
        expectedProductionProjectionVersion: basis.projectionVersion, physicalSelectionConfirmed: confirmed,
        reason, ...readProductionCapacitySelection(new FormData(event.currentTarget), mode.groupId, { factoryVersionId: factoryPin!.factoryVersionId, capabilityVersionId: factoryPin!.capabilityVersionId, quantity: Number(remakeQuantity) }), idempotencyKey: key,
        manufacturing: readProductionManufacturingSelection(new FormData(event.currentTarget)) });
      await perform({ scope, path: mode.kind === "inspect" ? `production/${productionOrderId}/quality-groups` : "recoveries", payload, key, kind: mode.kind,
        form: event.currentTarget, fingerprint: formFingerprint(event.currentTarget) }, prepareOnly);
    } catch { setError("请完整填写实际检查结果 缺陷处理 数量和发生时间"); }
  }
  const active = current?.groups.filter(group => group.active) ?? [], defectTotals = new Map<string, { standardId: string; code: string; quantity: number }>();
  const activeQuantity = (result: "passed" | "failed") => {
    const rows = active.filter(group => group.result === result);
    return rows.some(group => group.reinspectableQuantity === undefined) && !access.localDevelopment ? "尚未核对"
      : rows.reduce((sum, group) => sum + (group.reinspectableQuantity ?? group.quantity), 0);
  };
  for (const group of active) for (const defect of group.defects) {
    const key = group.qualityStandardVersionId + ":" + defect.code, previous = defectTotals.get(key);
    defectTotals.set(key, { standardId: group.qualityStandardVersionId, code: defect.code, quantity: (previous?.quantity ?? 0) + defect.affectedQuantity });
  }
  return <details className="oc-quality-groups-panel" open={open} inert={!ready} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary><Layers size={15} aria-hidden="true" />实物分组 复检与补做<ChevronDown size={14} className="oc-group-chevron" aria-hidden="true" /></summary>
    {!permitted && <div className="oc-quality-groups-body"><p className="oc-error" role="status">当前租户生产读取权限尚未核对 旧实物组与填写已隐藏</p>
      {canRead && <button type="button" className="oc-text-button" onClick={() => { setDeniedScope(""); setReload(value => value + 1); window.dispatchEvent(new Event("focus")); }}>重新核对实物组读取权限</button>}</div>}
    {permitted && (open || current || basis) && <div className="oc-quality-groups-body">
      <p className="oc-hint">按实际隔离的实物组记录结果 同件多缺陷分别统计 补做共享原组数量</p>
      <button className="oc-text-button" type="button" disabled={disabled || reading || saving} onClick={() => { setError(""); setReload(value => value + 1); }}><RefreshCw size={14} aria-hidden="true" />重新读取实物组</button>
      {reading && <p role="status">正在核对实物组与数量</p>}{error && <p className="oc-error" role="alert">{error}</p>}
      {current?.blockers.map(problem => <p className="oc-error" key={problem}>{problem}</p>)}
      {current && <>
        {!writable && <p className="oc-hint" role="status">当前仅可读取本生产实物依据 没有租户范围的质检与补做写入权限</p>}
        {!!active.length && <p className="oc-group-quantity-summary">已记录实物组 合格 {activeQuantity("passed")} 件 · 待处理 {activeQuantity("failed")} 件</p>}
        {!current.groups.length && <p className="oc-hint">尚未记录实物分组 旧检验不会自动补成隔离组</p>}
        {!!defectTotals.size && <dl className="oc-group-defect-totals" aria-label="各缺陷独立影响数量">{[...defectTotals].map(([key, total]) => {
          const definition = standards.find(item => item.id === total.standardId);
          return <div key={key}><dt>{definition?.name ?? "原标准"} V{definition?.versionNumber ?? "未读取"} · {definition?.criteria.find(item => item.code === total.code)?.label ?? total.code}</dt><dd>{total.quantity} 件</dd></div>;
        })}</dl>}
        <ul className="oc-group-records">{current.groups.map(group => <li key={group.id} data-quality-group={group.id}>
          <header><strong>{group.label}</strong><span>原组 {group.quantity} 件 · {group.active ? group.result === "passed" ? "检验通过" : "待处理" : "已复检替代"}</span></header>
          <p className="oc-hint">已交运 {group.shippedQuantity} 件 · 已安排补做 {group.remakeQuantity} 件 · 剩余可补做 {group.result === "failed" ? group.remainingRemakeQuantity : 0} 件</p>
          <p className="oc-hint">已归属实际报废 {group.scrappedQuantity ?? "尚未核对"} · 可复检实物 {group.reinspectableQuantity ?? "尚未核对"} · 报废份额剩余可补做 {group.remainingScrapRemakeQuantity ?? "尚未核对"}</p>
          {!group.active && group.remakeEligible && <p className="oc-hint">原组已由剩余实物复检替代 明确归属的报废份额仍可另行安排补做 不重复复检原报废实物</p>}
          <p className="oc-hint">原检验 {group.inspectionId.slice(-8)} · {dateTime(group.inspectedAt)}{group.parentGroupId ? " · 来自原组 " + group.parentGroupId.slice(-8) : ""}</p>
          {group.quantityBlockers?.map(reason => <p key={reason} className="oc-error" role="status">{reason}</p>)}
          {group.replacements.map(replacement => <p key={replacement.recoveryId} className="oc-hint"><a href={"#production-" + replacement.productionOrderId}>补做单 {replacement.productionOrderId.slice(-8)}</a> · {replacement.quantity} 件 · {label(replacement.status)} · {replacement.reserved ? "计入本组补做数量" : "已确认停单不再占用"}{replacement.caseStatus === "cancelled" && replacement.reserved ? " · 案例取消仍须核对工厂停单" : ""}</p>)}
          {group.defects.map(defect => <p key={defect.id}>{standards.find(item => item.id === group.qualityStandardVersionId)?.criteria.find(item => item.code === defect.code)?.label ?? defect.code} · 影响 {defect.affectedQuantity} 件 · {label(defect.severity)} · {label(defect.responsibility)} · {label(defect.disposition)}</p>)}
          {writable && (group.active || group.remakeEligible) && <div className="oc-group-actions">
            {group.active && <button type="button" className="oc-text-button" disabled={blocked || !!pending || !!group.quantityBlockers?.length || group.shippedQuantity > 0 || group.remakeQuantity > 0 || (group.reinspectableQuantity ?? (access.localDevelopment ? group.quantity : 0)) < 1} onClick={() => begin({ kind: "inspect", parentGroupId: group.id })}>按本组复检</button>}
            {group.result === "failed" && (group.remakeEligible ?? (access.localDevelopment && group.active)) && <button type="button" className="oc-text-button" disabled={blocked || !!pending || !!group.quantityBlockers?.length || group.shippedQuantity > 0 || group.remainingRemakeQuantity === 0 && (group.remainingScrapRemakeQuantity ?? 0) === 0} onClick={() => begin({ kind: "remake", groupId: group.id })}>按本组补做</button>}</div>}
        </li>)}</ul>
        {current.groups.some(group => (group.scrappedQuantity ?? 0) > 0) && <p className="oc-hint">原根检验已有实际报废归属 请保留原组并逐组复检剩余实物 不重新划分整批覆盖原凭证</p>}
        {writable && <button type="button" className="oc-button" disabled={blocked || !!pending || current.quantity === 0 || current.groups.some(group => group.shippedQuantity > 0 || group.remakeQuantity > 0 || (group.scrappedQuantity ?? 0) > 0 || !!group.quantityBlockers?.length)} onClick={() => begin({ kind: "inspect", parentGroupId: null })}>按整批实物建立分组检验</button>}
      </>}
      <QualityScrapWorkspace productionOrderId={productionOrderId} refresh={refresh + ":" + reload} active={open} disabled={disabled || saving || !!pending} onDenied={deny}
        onSaved={(form, fingerprint, message) => { setReload(value => value + 1); onSaved(form, fingerprint, message); }} />
      {writable && basis && mode && <form className="oc-quality-group-form" aria-label={mode.kind === "inspect" ? "实物分组检验" : "按组安排补做"} data-order-action={"quality-groups-" + mode.kind} onSubmit={event => void submit(event)}>
        <input type="hidden" name="qualityGroupDraft" value={JSON.stringify({ mode, groups, standardId, inspectedAt, confirmed, remakeQuantity, defectId, reason, completionAt, source: pin(basis) })} readOnly />
        {stale && <div className="oc-notice" role="alert"><p>原生产依据或实物数量已变化 当前填写已保留 请重新核对后再操作</p>
          <button type="button" className="oc-button" disabled={disabled || reading || saving || !!pending} onClick={() => {
            if (!current || !window.confirm("重新核对会清空本次检查和数量填写 是否继续")) return;
            transitionDraft(() => { clearDraft(); setEditing({ scope, value: current }); setMode(mode); setError(""); });
          }}>核对新依据并清空本次填写</button></div>}
        {pending && !saving && <p className="oc-notice" role="alert">本次原提交待核对 请到本单原履约提交恢复区只读核对 不重新发送表单</p>}
        <fieldset disabled={blocked || !!pending} className="oc-quality-group-editor">
          <legend>{mode.kind === "inspect" ? parent ? "复检原实物组 " + parent.label : "整批实物分组检验" : "按实物组补做 " + target?.label}</legend>
          {mode.kind === "inspect" ? <>
            <p className="oc-hint">本次需完整覆盖 {requiredQuantity === null ? "数量待核对" : requiredQuantity + " 件"} 不同缺陷组合分开隔离{parent ? " 已明确归属报废的实物不重复进入复检" : ""}</p>
            <label>检验标准<select aria-label="检验标准" required value={standardId} onChange={event => { const id = event.target.value; transitionDraft(() => { setStandardId(id);
              setGroups(values => values.map(group => ({ ...group, ratings: {}, defects: group.defects.map(defect => ({ ...defect, code: "" })) }))); setConfirmed(false); }); }}>
              <option value="">选择适用标准</option>{standards.map(item => <option key={item.id} value={item.id}>{item.name} V{item.versionNumber}</option>)}
            </select></label>
            {standard && groups.map((group, index) => <QualityGroupFields key={group.key} group={group} index={index} standard={standard} removable={groups.length > 1}
              onChange={(change, animate) => { const update = () => { setGroups(values => values.map(item => item.key === group.key ? change(item) : item)); setConfirmed(false); };
                if (animate) transitionDraft(update); else update(); }}
              onRemove={() => transitionDraft(() => { setGroups(values => values.filter(item => item.key !== group.key)); setConfirmed(false); })} />)}
            {standard && <button type="button" className="oc-text-button" disabled={groups.length >= 100} onClick={() => transitionDraft(() => { nextGroup.current += 1;
              setGroups(values => [...values, blankQualityGroup("group-" + nextGroup.current)]); setConfirmed(false); })}><Plus size={14} aria-hidden="true" />增加实物组</button>}
            <p role="status" className="oc-group-quantity-summary">已分组 {groups.reduce((sum, group) => sum + (Number(group.quantity) || 0), 0)} / {requiredQuantity === null ? "待核对" : requiredQuantity} 件{evaluation && !evaluation.problems.length ? " · 合格 " + evaluation.passedQuantity + " 件 · 待处理 " + evaluation.heldQuantity + " 件" : " · 请完成各组实际检查与缺陷处理"}</p>
            {evaluation?.problems.map(problem => <p className="oc-error" key={problem}>{problem}</p>)}
            <label>实际检验时间<input required type="datetime-local" step="0.001" value={inspectedAt} onChange={event => setInspectedAt(event.target.value)} /></label>
            <label className="oc-check"><input type="checkbox" required checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />已按实物隔离各组并逐项检查 组间没有重复 数量覆盖本次范围</label>
            <button className="oc-button primary" disabled={!!proposalHandoff || !confirmed || !evaluation || !!evaluation.problems.length}>保存实物分组检验</button>
            <FulfillmentCommandPrepareButton disabled={!confirmed || !evaluation || !!evaluation.problems.length} />
          </> : target && <>
            <ProductionManufacturingFields key={`${mode.groupId}:${draftRevision}`} lineId={lineId} originalProductionOrderId={productionOrderId} disabled={blocked || !!pending} onReadinessChange={setManufacturingReady} />
            <p className="oc-hint">原组 {target.quantity} 件 · 已安排 {target.remakeQuantity} 件 · 当前所选缺陷最多补做 {selectedDefect ? remakeMaximum : "待明确选择"} 件 多个缺陷共享原组额度</p>
            <p className="oc-hint">已归属报废 {target.scrappedQuantity ?? "尚未核对"} · 报废份额剩余可补做 {target.remainingScrapRemakeQuantity ?? "尚未核对"} · 仅报废处理缺陷取用此份额</p>
            <label>关联原缺陷<select aria-label="关联原缺陷" required value={defectId} onChange={event => { setDefectId(event.target.value); setConfirmed(false); setCapacityReady(false); }}><option value="">选择需要处理的缺陷</option>{target.defects.filter(defect => ["remake", "rework", "scrap"].includes(defect.disposition)).map(defect => <option key={defect.id} value={defect.id}
              disabled={defect.disposition === "scrap" ? (target.remainingScrapRemakeQuantity ?? 0) < 1 : target.remainingRemakeQuantity < 1}>{standards.find(item => item.id === target.qualityStandardVersionId)?.criteria.find(item => item.code === defect.code)?.label ?? defect.code} · {label(defect.disposition)}</option>)}</select></label>
            <label>本次补做数量<input required type="number" min={1} max={remakeMaximum} step={1} value={remakeQuantity} onChange={event => { setRemakeQuantity(event.target.value); setConfirmed(false); setCapacityReady(false); }} /></label>
            {remakeQuantity && !validRemakeQuantity && <p className="oc-error" role="alert">本次补做数量须为正整数 且不能超过原组剩余数量</p>}
            <label>补做原因<textarea required maxLength={2000} value={reason} onChange={event => setReason(event.target.value)} /></label>
            <label>补做工厂当地预计完成时间<input required type="datetime-local" value={completionAt} onChange={event => setCompletionAt(event.target.value)} /></label>
            {factoryPin ? <ProductionCapacityPicker factoryId={factoryPin.factoryId} items={[{ reference: mode.groupId, factoryVersionId: factoryPin.factoryVersionId, capabilityVersionId: factoryPin.capabilityVersionId, quantity: Number(remakeQuantity), dueLocal: completionAt }]}
              basisKey={`${pin(basis)}:${draftRevision}:${manufacturingReady}:${defectId}`} disabled={blocked || !!pending} onReady={setCapacityReady} onDenied={deny} />
              : <p className="oc-error" role="status">原生产未保留可读取的固定工厂与能力 当前不能安排补做 不以当前工厂猜补原来源</p>}
            <label className="oc-check"><input required type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />已核对本次取用的原组实物和补做数量</label>
            <button className="oc-button primary" disabled={!!proposalHandoff || !confirmed || !validRemakeQuantity || !manufacturingReady || !capacityReady || !factoryPin}>创建本组补做任务</button>
            <FulfillmentCommandPrepareButton disabled={!confirmed || !validRemakeQuantity || !manufacturingReady || !capacityReady || !factoryPin} />
          </>}
        </fieldset>
        {saving && <p role="status">正在保存本次记录</p>}
      </form>}
    </div>}
  </details>;
}
