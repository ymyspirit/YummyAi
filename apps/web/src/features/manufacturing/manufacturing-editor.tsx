"use client";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { flushSync } from "react-dom";
import { Check, RefreshCw, Save, X } from "lucide-react";
import { z } from "zod";
import { Permission } from "@yummyai/authz/permissions";
import {
  CreateManufacturingRecipeSchema, ReviseManufacturingRecipeSchema, ReviewManufacturingRecipeSchema,
  ManufacturingDemandResultSchema, ManufacturingRecipeVersionViewSchema,
  type ManufacturingRecipeVersionView, type ManufacturingRecipeWorkspace, type ManufacturingReferences,
} from "@yummyai/contracts/catalog/manufacturing";
import { useErpAccess } from "../identity/erp-access";
import { clearTaskDrafts, useTaskDraft } from "../navigation/task-draft";
import { cancelViewTransitions } from "../navigation/view-transition";
import { manufacturingTransition } from "./manufacturing-transition";
import { ManufacturingField, ManufacturingLines } from "./manufacturing-fields";
import { ManufacturingHistory, ManufacturingVersionSummary } from "./manufacturing-history";
import { ManufacturingContextChanged, ManufacturingRequestError, manufacturingRequest } from "./manufacturing-api";
import { blankManufacturingDraft, contentFromDraft, draftContentKey, draftFromVersion, intentPath, ManufacturingDraftSchema, quantityText, responsibilityLabels, unitLabels,
  type ManufacturingDraft, type ManufacturingIntent } from "./manufacturing-model";

type Proposal = z.infer<typeof ManufacturingDemandResultSchema>;
export function ManufacturingEditor({ references, workspace, recipeId, initialSpecId, ready, scope, authority, localDevelopment, refresh,
  onSaved, onAccessChanged, onRefresh }: {
  references: ManufacturingReferences; workspace: ManufacturingRecipeWorkspace | null; recipeId: string | null; initialSpecId: string | null;
  ready: boolean; scope: string; authority: string; localDevelopment: boolean; refresh: number;
  onSaved: (version: ManufacturingRecipeVersionView) => void; onAccessChanged: () => void; onRefresh: () => void;
}) {
  const { can } = useErpAccess(), resource = { ownerId: references.spu.ownerId, teamId: references.spu.teamId };
  const canSubmit = can(Permission.ProductWrite, resource), canWrite = canSubmit && references.canReadMaterials, canReview = can(Permission.ManufacturingReview, resource);
  const selectedSpec = references.specifications.find(item => item.id === initialSpecId);
  const [draft, setDraft, recoveryError] = useTaskDraft<ManufacturingDraft>(scope, "form", () => workspace ? draftFromVersion(workspace.currentVersion)
    : blankManufacturingDraft(selectedSpec?.id, selectedSpec?.versionId), { session: true, validate: (value): value is ManufacturingDraft => {
      const result = ManufacturingDraftSchema.safeParse(value); if (!result.success) return false;
      const pending = result.data.pending;
      return !pending || (pending.kind === "create" ? !recipeId && pending.body.spuId === references.spu.id : pending.recipeId === recipeId);
    } });
  const [saving, setSaving] = useState(false), [error, setError] = useState(""), [message, setMessage] = useState("");
  const [planned, setPlanned] = useState(""), [proposal, setProposal] = useState<Proposal | null>(null), [calculating, setCalculating] = useState(false);
  const live = useRef(true), requestActive = useRef(false), calculation = useRef<AbortController | null>(null);
  useEffect(() => { live.current = true; return () => { live.current = false; calculation.current?.abort(); }; }, []);
  const accessChanged = useCallback(() => { cancelViewTransitions(); onAccessChanged(); }, [onAccessChanged]);
  const stale = !!workspace && draft.basisVersion !== workspace.currentVersion.versionNumber;
  const dirty = workspace ? draftContentKey(draft) !== draftContentKey(draftFromVersion(workspace.currentVersion)) : !!draft.name || !!draft.code || draft.materials.length > 0 || draft.operations.length > 0;
  const unavailable = !ready || !references.spu.active || !!workspace?.archived || !!recoveryError;
  const disabled = unavailable || !canWrite || saving || !!draft.pending;
  const current = workspace?.currentVersion, originalSpec = references.specifications.find(row => row.id === draft.specificationId);
  const specCurrent = !!current && references.specifications.some(row => row.versionId === current.content.specificationVersionId);
  const reviewerBlocked = unavailable || !canReview || saving || !!draft.pending || !current || !!current.review || stale || dirty || !specCurrent;

  function structural(change: () => void) {
    manufacturingTransition(change);
  }
  async function perform(intent: ManufacturingIntent) {
    if (requestActive.current || !ready || !(intent.kind === "review" ? canReview : canSubmit)) return;
    requestActive.current = true;
    flushSync(() => { setDraft(value => ({ ...value, pending: intent })); setSaving(true); setError(""); setMessage(""); });
    try {
      const result = await manufacturingRequest(intentPath(intent), ManufacturingRecipeVersionViewSchema, authority, localDevelopment,
        { body: intent.body, signal: AbortSignal.timeout(45000) });
      if (!live.current) return;
      if (result.spuId !== references.spu.id || intent.kind !== "create" && result.recipeId !== recipeId) throw new ManufacturingContextChanged();
      if (intent.kind === "create") {
        flushSync(() => setDraft(blankManufacturingDraft(selectedSpec?.id, selectedSpec?.versionId)));
        clearTaskDrafts(scope);
      } else if (intent.kind === "review") setDraft(value => ({ ...value, pending: null, reviewNote: "" }));
      else setDraft(value => ({ ...draftFromVersion(result), reviewNote: value.reviewNote }));
      setMessage("已核对本次提交结果 原版本与回执已保留"); onSaved(result);
    } catch (cause) {
      if (!live.current) return;
      if (cause instanceof ManufacturingContextChanged) { accessChanged(); return; }
      setError(cause instanceof Error ? cause.message : "提交结果尚未确认 请恢复本次提交结果");
      if (cause instanceof ManufacturingRequestError && !cause.uncertain && cause.status !== null) {
        if ([401, 403, 404].includes(cause.status)) onRefresh();
        else { setDraft(value => ({ ...value, pending: null })); if ([400, 409, 422].includes(cause.status)) onRefresh(); }
      }
    } finally { requestActive.current = false; if (live.current) setSaving(false); }
  }
  function save(event: FormEvent) {
    event.preventDefault(); if (disabled || stale || draft.pending) return;
    try {
      const content = contentFromDraft(draft), idempotencyKey = crypto.randomUUID();
      if (!draft.code.trim()) throw new Error("请填写制造模板编号");
      const intent: ManufacturingIntent = recipeId ? { kind: "revise", recipeId, body: ReviseManufacturingRecipeSchema.parse({ expectedVersion: draft.basisVersion, content, idempotencyKey }) }
        : { kind: "create", body: CreateManufacturingRecipeSchema.parse({ spuId: references.spu.id, specificationId: draft.specificationId, code: draft.code, content, idempotencyKey }) };
      void perform(intent);
    } catch (cause) { setError(cause instanceof Error && !(cause instanceof z.ZodError) ? cause.message : "请核对编号、规格及数量后保存"); }
  }
  function review(decision: "approved" | "rejected") {
    if (reviewerBlocked || !recipeId || !current) return;
    if (!draft.reviewNote.trim()) { setError("请填写本次审核说明"); return; }
    try {
      const body = ReviewManufacturingRecipeSchema.parse({ expectedVersion: current.versionNumber, versionId: current.versionId, decision, note: draft.reviewNote, idempotencyKey: crypto.randomUUID() });
      void perform({ kind: "review", recipeId, body });
    } catch { setError("审核说明不可为空且不超过2000字 请核对后重试"); }
  }
  async function estimate() {
    if (!ready || !workspace?.releasedVersion || workspace.releaseProblems.length || !references.canReadMaterials || calculating) return;
    if (!/^\d+$/.test(planned) || Number(planned) < 1 || Number(planned) > 1000000) { setError("计划产出数量须为1至1000000的整数"); return; }
    calculation.current?.abort(); const abort = new AbortController(); calculation.current = abort;
    const versionId = workspace.releasedVersion.versionId;
    setCalculating(true); setProposal(null); setError("");
    try {
      const result = await manufacturingRequest(`/${recipeId}/material-demands`, ManufacturingDemandResultSchema, authority, localDevelopment,
        { body: { versionId, outputQuantity: Number(planned) }, readOnly: true, signal: abort.signal });
      if (!live.current || abort.signal.aborted) return;
      if (result.versionId !== versionId || result.recipeId !== recipeId) throw new ManufacturingContextChanged();
      setProposal(result);
    } catch (cause) {
      if (!live.current || abort.signal.aborted) return;
      if (cause instanceof ManufacturingContextChanged) accessChanged();
      else setError(cause instanceof Error ? cause.message : "备料建议暂时无法读取");
    } finally { if (live.current && !abort.signal.aborted) setCalculating(false); }
  }
  useEffect(() => { calculation.current?.abort(); setProposal(null); setCalculating(false); }, [workspace?.releasedVersion?.versionId, planned]);
  const proposalCurrent = proposal?.versionId === workspace?.releasedVersion?.versionId && proposal?.outputQuantity === Number(planned);
  return <div className="mf-editor" style={{ viewTransitionName: "manufacturing-editor" }}>
    {workspace && <div className="mf-version-strip" role="group" aria-label="制造版本状态"><div><small>当前保存版本</small><strong>V{current!.versionNumber} · {current!.review ? current!.review.decision === "approved" ? "已批准" : "已驳回" : "未审核"}</strong></div>
      <div><small>已批准版本</small><strong>{workspace.releasedVersion ? `V${workspace.releasedVersion.versionNumber}` : "尚无已批准版本"}</strong></div></div>}
    {recoveryError && <p className="mf-error" role="alert">{recoveryError} 请重新读取服务器版本后核对</p>}
    {!canWrite && <p className="mf-notice">当前账户只读制造内容 维护需要产品写入及物料读取权限</p>}
    {stale && <div className="mf-notice" role="alert"><p>填写基于V{draft.basisVersion} 服务器当前为V{current?.versionNumber} 本次填写已保留 请核对后继续</p>
      <details><summary>查看服务器当前版本</summary>{current && <ManufacturingVersionSummary version={current} />}</details>
      <button type="button" className="oc-button" disabled={!ready || !!draft.pending || saving || !canWrite} onClick={() => setDraft(value => ({ ...value, basisVersion: current!.versionNumber }))}>以当前版本继续核对</button></div>}
    {draft.pending && <div className="mf-notice" role="status"><p>上次提交结果待核对 原内容和请求编号已保留</p><button type="button" className="oc-button" disabled={saving || !ready || !(draft.pending.kind === "review" ? canReview : canSubmit)} onClick={() => void perform(draft.pending!)}><RefreshCw size={14} />恢复本次提交结果</button></div>}
    {error && <p className="mf-error" role="alert">{error}</p>}{message && <p className="mf-notice" role="status">{message}</p>}
    <form onSubmit={save} aria-label="制造模板编辑" noValidate>
      <fieldset className="mf-base" disabled={disabled}><legend>{recipeId ? "制造版本草稿" : "新建制造模板"}</legend><div className="mf-grid">
        <ManufacturingField id="mf-code" label="制造模板编号"><input id="mf-code" value={draft.code} maxLength={64} readOnly={!!recipeId} onChange={e => setDraft(value => ({ ...value, code: e.target.value }))} /></ManufacturingField>
        <ManufacturingField id="mf-name" label="制造名称"><input id="mf-name" value={draft.name} maxLength={200} onChange={e => setDraft(value => ({ ...value, name: e.target.value }))} /></ManufacturingField>
        <ManufacturingField id="mf-specification" label="所用产品规格"><select id="mf-specification" value={draft.specificationVersionId} onChange={e => {
          const spec = references.specifications.find(item => item.versionId === e.target.value);
          if (spec) setDraft(value => ({ ...value, specificationId: spec.id, specificationVersionId: spec.versionId }));
        }}><option value="">请选择规格</option>
          {draft.specificationVersionId && !references.specifications.some(row => row.versionId === draft.specificationVersionId) && <option value={draft.specificationVersionId}>原固定规格 · 历史版本</option>}
          {references.specifications.filter(row => !recipeId || row.id === workspace?.specificationId).map(row => <option key={row.id} value={row.versionId}>{row.code} · {row.name} · V{row.versionNumber}{row.factsReady ? "" : " · 事实待核实"}</option>)}
        </select>{originalSpec && draft.specificationVersionId !== originalSpec.versionId && <small className="mf-error">原规格已更新 请明确选择当前版本后核对</small>}</ManufacturingField>
        <ManufacturingField id="mf-output" label="下列用量对应产出数量"><input id="mf-output" inputMode="numeric" value={draft.outputQuantity} onChange={e => setDraft(value => ({ ...value, outputQuantity: e.target.value }))} /></ManufacturingField>
        <ManufacturingField id="mf-unit" label="产出单位"><select id="mf-unit" value={draft.outputUnit} onChange={e => setDraft(value => ({ ...value, outputUnit: e.target.value as ManufacturingDraft["outputUnit"] }))}>
          <option value="">待确认</option><option value="each">件</option><option value="pair">双</option><option value="set">套</option></select></ManufacturingField>
        <ManufacturingField id="mf-notes" label="制造说明"><textarea id="mf-notes" rows={2} maxLength={2000} value={draft.notes} onChange={e => setDraft(value => ({ ...value, notes: e.target.value }))} /></ManufacturingField>
      </div></fieldset>
      <ManufacturingLines draft={draft} update={setDraft} structural={structural} disabled={disabled} spuId={references.spu.id} authority={authority} localDevelopment={localDevelopment}
        canReadMaterials={references.canReadMaterials} onAccessChanged={accessChanged} onError={setError} />
      <div className="mf-actions"><small>{dirty ? "有未保存填写 本标签页暂存2小时" : "与当前保存版本一致"}</small>
        {workspace && <button type="button" className="oc-button" disabled={!ready || saving || !!draft.pending} onClick={() => setDraft(draftFromVersion(workspace.currentVersion))}>放弃填写并载入当前版本</button>}
        <button type="submit" className="oc-button primary" disabled={disabled || stale}><Save size={14} />{saving ? "正在核对提交" : recipeId ? "保存为新版本" : "保存制造模板"}</button></div>
    </form>
    {workspace && <>
      <section className="mf-section" aria-label="制造审核"><h2>审核当前保存版本</h2>
        {current?.review ? <p>{current.review.decision === "approved" ? "已批准" : "已驳回"} · {current.review.note}</p> : <>
          {dirty && <p className="mf-notice">当前有未保存更改 请先保存新版本再审核</p>}
          {!!workspace.approvalProblems.length && <ul className="mf-problems">{workspace.approvalProblems.map((reason, index) => <li key={index}>{reason}</li>)}</ul>}
          {!canReview && <p className="mf-notice">当前账户没有制造审核权限</p>}
          <ManufacturingField id="mf-review-note" label="本次审核说明"><textarea id="mf-review-note" maxLength={2000} rows={2} disabled={reviewerBlocked} value={draft.reviewNote} onChange={e => setDraft(value => ({ ...value, reviewNote: e.target.value }))} /></ManufacturingField>
          <div className="mf-actions"><button type="button" className="oc-button" disabled={reviewerBlocked} onClick={() => review("rejected")}><X size={14} />驳回当前版本</button>
            <button type="button" className="oc-button primary" disabled={reviewerBlocked || !!workspace.approvalProblems.length} onClick={() => review("approved")}><Check size={14} />批准当前版本</button></div>
        </>}
      </section>
      <section className="mf-section" aria-label="备料建议"><h2>备料建议</h2><p>仅使用已批准版本 这是备料提案 不会扣减库存或登记实际耗用</p>
        {!!workspace.releaseProblems.length && <ul className="mf-problems">{workspace.releaseProblems.map((reason, index) => <li key={index}>{reason}</li>)}</ul>}
        <div className="mf-proposal-controls"><ManufacturingField id="mf-planned" label="计划产出数量"><input id="mf-planned" inputMode="numeric" value={planned} onChange={e => setPlanned(e.target.value)} disabled={!ready || !references.canReadMaterials} /></ManufacturingField>
          <button type="button" className="oc-button" disabled={!ready || calculating || !references.canReadMaterials || !workspace.releasedVersion || !!workspace.releaseProblems.length} onClick={() => void estimate()}>{calculating ? "正在核对建议" : "生成备料建议"}</button></div>
        {ready && proposal && proposalCurrent && <div className="mf-proposal" role="region" aria-label="精确备料汇总"><p>使用已批准版本 V{workspace.releasedVersion!.versionNumber} · 计划产出 {proposal.outputQuantity} {unitLabels[proposal.outputUnit]}</p>
          <ul>{proposal.totals.map(row => <li key={`${row.stockItemId}:${row.unit}:${row.responsibility}`}><strong>{proposal.lines.filter(line => line.stockItemId === row.stockItemId && line.responsibility === row.responsibility).map(line => line.name).join(" / ")}</strong>
            <span>精确需求 {quantityText(row.exactNumerator, row.exactDenominator)} {unitLabels[row.unit]} · {responsibilityLabels[row.responsibility]}供料</span><small>整基本单位参考 {row.wholeBaseUnitCeiling} {unitLabels[row.unit]} 不能作为实际耗用直接扣账</small></li>)}</ul>
        </div>}
      </section>
      <ManufacturingHistory recipeId={workspace.recipeId} authority={authority} localDevelopment={localDevelopment} refresh={refresh} onAccessChanged={accessChanged} />
    </>}
  </div>;
}
