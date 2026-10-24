"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { ChevronDown, FileCheck2, History, RefreshCw } from "lucide-react";
import {
  CreativeExecutionHistorySchema, type CreativeExecutionHistory, type CreativeExecutionView,
  type CreativeHistoryScope, type CreativeOperatorCommand,
} from "@yummyai/contracts/harness/creative-operator";
import { MethodEvidence } from "../ai-assist/method-evidence";
import "./creative-execution-history.css";

const phases: Record<CreativeExecutionView["phase"], string> = {
  pending: "等待派发", preparing: "处理中", submitted: "已记录提交", response_staging: "保存原响应",
  response_ready: "原响应可恢复", completed: "技术处理完成", failed: "执行未完成", uncertain: "原提交待核对",
};
const kinds = { creative_candidate: "候选生成", creative_adaptation: "画幅适配", template_compile: "模板编译", mockup_render: "场景套图", studio_generation: "工作台生成" };
const findings = { provider_pending: "渠道仍在处理", provider_failed: "渠道报告失败", response_located: "已找到原响应", needs_owner_review: "交由业务负责人核对" };

export function CreativeExecutionHistoryPanel({ scope, ownerId, active = true, label }: { scope: CreativeHistoryScope; ownerId: string; active?: boolean; label?: string }) {
  const [open, setOpen] = useState(false), [result, setResult] = useState<{ key: string; value: CreativeExecutionHistory }>(),
    [loading, setLoading] = useState(false), [error, setError] = useState(""), [denied, setDenied] = useState(false);
  const key = `${scope}:${ownerId}`, epoch = useRef(0), controller = useRef<AbortController | null>(null), collapseId = useId();
  const history = active && result?.key === key ? result.value : undefined;
  const reload = useCallback(async (after?: string) => {
    controller.current?.abort();
    const request = new AbortController(); controller.current = request;
    const generation = ++epoch.current;
    setLoading(true); setError("");
    try {
      const response = await fetch(`/api/creative-executions/history/${scope}/${encodeURIComponent(ownerId)}${after ? `?after=${encodeURIComponent(after)}` : ""}`, { cache: "no-store", signal: request.signal });
      if (generation !== epoch.current) return;
      if (!response.ok) {
        if ([401, 403, 404].includes(response.status)) { setDenied(true); setResult(undefined); throw new Error("当前执行资料已不可读取"); }
        throw new Error("执行记录暂时无法核对 请重试");
      }
      const value = CreativeExecutionHistorySchema.parse(await response.json());
      if (generation !== epoch.current) return;
      if (value.scope !== scope || value.ownerId !== ownerId) throw new Error("执行记录归属不匹配 请重试");
      setDenied(false);
      setResult(previous => ({ key, value: { ...value, entries: after && previous?.key === key ? [...previous.value.entries, ...value.entries.filter(row => !previous.value.entries.some(old => old.id === row.id))] : value.entries } }));
    } catch (cause) {
      if (generation === epoch.current && !request.signal.aborted) {
        setResult(undefined); setError(cause instanceof Error ? cause.message : "执行记录暂时无法读取");
      }
    } finally { if (generation === epoch.current) setLoading(false); }
  }, [key, scope, ownerId]);

  useEffect(() => {
    epoch.current++; controller.current?.abort(); setResult(undefined); setDenied(false); setError("");
    if (!active || !open) return;
    void reload();
    const refresh = () => { if (document.visibilityState === "visible") void reload(); };
    const timer = setInterval(refresh, 30_000);
    window.addEventListener("focus", refresh); document.addEventListener("visibilitychange", refresh);
    return () => { epoch.current++; controller.current?.abort(); clearInterval(timer); window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, [active, open, reload]);

  if (!active) return null;
  return <section className="creative-execution-history" aria-label="创作执行依据与恢复">
    <button type="button" className="creative-history-toggle" aria-expanded={open} aria-controls={collapseId} onClick={() => setOpen(value => !value)}><History size={14} /><span>{label ? label + " · " : ""}执行依据与恢复</span><ChevronDown size={14} /></button>
    <div id={collapseId} className="creative-history-collapse" data-open={open} inert={!open} aria-hidden={!open}><div>
      <div className="creative-history-toolbar"><span>原方法、费用与产物按本次执行保留</span><button type="button" disabled={loading} onClick={() => void reload()}><RefreshCw size={13} />刷新</button></div>
      {loading && <p role="status">正在核对执行记录</p>}
      {error && <p role="alert">{error}</p>}
      {!loading && !error && history && !history.entries.length && <p>尚无持久执行记录 历史任务不能补造今天的方法或费用</p>}
      {!denied && !error && history?.entries.map(row => <ExecutionRow key={`${key}:${row.id}`} row={row} refresh={() => reload()} />)}
      {!denied && !error && history?.nextCursor && <button type="button" disabled={loading} onClick={() => void reload(history.nextCursor!)}>读取更早记录</button>}
    </div></div>
  </section>;
}

function ExecutionRow({ row, refresh }: { row: CreativeExecutionView; refresh: () => Promise<void> }) {
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState(""), [proof, setProof] = useState(""),
    [finding, setFinding] = useState<Extract<CreativeOperatorCommand, { action: "record_check" }>["finding"]>("needs_owner_review"), [checkedBasis, setCheckedBasis] = useState<string | null>(null);
  const checked = row.canRecordCheck && checkedBasis === row.fingerprint;
  const pending = useRef<CreativeOperatorCommand | null>(null), live = useRef(true), proofEpoch = useRef(0), proofInput = useRef<HTMLInputElement | null>(null);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  useEffect(() => {
    if (!row.canRecordCheck) {
      proofEpoch.current++; setProof(""); setCheckedBasis(null); pending.current = null;
      if (proofInput.current) proofInput.current.value = "";
    }
  }, [row.canRecordCheck]);
  async function chooseProof(file?: File) {
    const generation = ++proofEpoch.current;
    setProof(""); setCheckedBasis(null); setNotice("");
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) { setNotice("核对凭据不能超过 10 MiB"); return; }
    try {
      const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
      if (live.current && generation === proofEpoch.current)
        setProof(Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join(""));
    } catch { if (live.current && generation === proofEpoch.current) setNotice("凭据无法读取 请重新选择"); }
  }
  async function act(action: CreativeOperatorCommand["action"]) {
    const candidate = { action, expectedFingerprint: row.fingerprint, ...(action === "record_check" ? { finding, proofChecksum: proof.trim(), matchesOriginalRequest: true as const } : {}) };
    const old = pending.current;
    const command = old && JSON.stringify({ ...old, commandId: undefined }) === JSON.stringify(candidate) ? old : { ...candidate, commandId: crypto.randomUUID() } as CreativeOperatorCommand;
    pending.current = command; setBusy(true); setNotice("");
    try {
      const response = await fetch(`/api/creative-executions/${row.id}/actions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(command) });
      if (!live.current) return;
      if (!response.ok) {
        if ([401, 403, 404].includes(response.status)) { await refresh(); return; }
        const body = await response.json().catch(() => null);
        throw new Error(typeof body?.message === "string" ? body.message : "操作尚未确认 可重试同一请求");
      }
      pending.current = null; proofEpoch.current++; setProof(""); setCheckedBasis(null);
      if (proofInput.current) proofInput.current.value = "";
      setNotice(action === "request_recovery" ? "已请求原任务续做 等待 Worker 派发" : "已记录人工核对 原执行状态和费用保持原依据");
      await refresh();
    } catch (cause) { if (live.current) setNotice(cause instanceof Error ? cause.message : "操作暂不可用"); }
    finally { if (live.current) setBusy(false); }
  }
  return <article className="creative-execution-row" aria-label={`${kinds[row.kind]}执行记录`}>
    <header><strong>{kinds[row.kind]}</strong><span>{phases[row.phase]}</span><time>{new Date(row.createdAt).toLocaleString("zh-CN")}</time></header>
    <MethodEvidence selection={row.method} />
    <dl>
      <dt>执行编号</dt><dd><code>{row.id}</code></dd>
      <dt>原步骤</dt><dd><code>{row.stepKey}</code></dd>
      {row.parentId && <><dt>原父执行</dt><dd><code>{row.parentId}</code></dd></>}
      <dt>原输入校验</dt><dd><code>{row.inputFingerprint}</code></dd>
      <dt>本地处理 / 派发</dt><dd>{row.processingAttempts} / {row.dispatches}</dd>
      <dt>服务报告费用</dt><dd>{row.cost.basis === "processor_reported" ? `${row.cost.amountUsd} USD · 尚未核对渠道账单` : row.cost.basis === "unknown" ? "费用未知 不能按零处理" : row.cost.basis === "not_submitted" ? "尚未提交渠道" : "本步骤无外部调用"}</dd>
      {row.cost.budgetAmountUsd && <><dt>原预算账本</dt><dd>{row.cost.budgetAmountUsd} USD · {row.cost.budgetState === "reserved" ? "已预留" : row.cost.budgetState === "committed" ? "已记账" : "已释放"}</dd></>}
      {row.providerRequestId && <><dt>原渠道请求</dt><dd><code>{row.providerRequestId}</code></dd></>}
      <dt>原响应</dt><dd>{{ missing: "未保存", retained: "在保留期内", expired: "已过保留期", purged: "已清理原件" }[row.responseState]}</dd>
      {row.responseChecksum && <><dt>响应校验</dt><dd><code>{row.responseChecksum}</code></dd></>}
      {row.errorCode && <><dt>失败代码</dt><dd><code>{row.errorCode}</code></dd></>}
      {row.completionChecksum && <><dt>技术交接校验</dt><dd><code>{row.completionChecksum}</code></dd></>}
    </dl>
    {!!row.artifacts.length && <ul aria-label="本次固定产物">{row.artifacts.map(file => <li key={file.assetId}><code>{file.assetId}</code> · v{file.version}<small>{file.checksumSha256}</small></li>)}</ul>}
    {row.unavailableArtifacts > 0 && <p>有 {row.unavailableArtifacts} 份原产物当前不可读取 请核对原任务</p>}
    <div className="creative-history-actions"><button type="button" disabled={busy || !row.canRequestRecovery} onClick={() => void act("request_recovery")}><RefreshCw size={13} />申请原任务续做</button><span>{row.recoveryBlockers.join("；") || "提交时会再次核对原来源、权限和方法"}</span></div>
    {row.canRecordCheck && <form onSubmit={event => { event.preventDefault(); void act("record_check"); }}>
      <label>核对结论<select value={finding} disabled={busy} onChange={event => setFinding(event.target.value as typeof finding)}>{Object.entries(findings).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
      <label>核对凭据<input ref={proofInput} type="file" disabled={busy} onChange={event => void chooseProof(event.target.files?.[0])} required /></label>
      {proof && <small className="creative-history-proof">凭据校验 {proof}</small>}
      <label className="creative-history-attestation"><input type="checkbox" checked={checked} disabled={busy} onChange={event => setCheckedBasis(event.target.checked ? row.fingerprint : null)} required />已核对凭据对应本次原请求</label>
      <button type="submit" disabled={busy || !checked || !/^[a-f0-9]{64}$/.test(proof.trim())}><FileCheck2 size={13} />记录人工核对</button>
      <p>仅记录凭据文件的校验值 原件保留在本机 人工核对不会重放请求、确认账单或批准生产</p>
    </form>}
    {notice && <p role="status">{notice}</p>}
    {!!row.events.length && <ol aria-label="人工处理记录">{row.events.map(event => <li key={event.id}>{event.action === "request_recovery" ? "已申请原任务续做" : findings[event.finding!]} · {new Date(event.recordedAt).toLocaleString("zh-CN")}{event.proofChecksum && <small>凭据校验 {event.proofChecksum}</small>}</li>)}</ol>}
    {row.hasMoreEvents && <p>显示最近 10 条人工记录 原审计历史继续保留</p>}
  </article>;
}
