"use client";
import { useEffect, useRef, useState } from "react";
import { requiredAssistPermissions } from "@yummyai/authz/assist-policy";
import { useErpAccess } from "../identity/erp-access";
import {
  AssistBasisViewSchema,
  type AssistBasisView,
  type AssistBusinessSelection,
} from "@yummyai/contracts/ai/assist";
import type { FinanceWorkspaceView } from "@yummyai/contracts/finance";
import type { ProcurementWorkspaceView } from "@yummyai/contracts/procurement";
import { AssistPanel } from "./assist-panel";
import { assistApi, assistReadDenied } from "./assist-client";
import "./assist.css";

export function BusinessAssist(props: Parameters<typeof BusinessAssistContent>[0]) {
  const access = useErpAccess();
  if (!access.authority || props.selection && !requiredAssistPermissions(props.selection.kind, "read").every(bit => access.can(bit)))
    return <p role="status">当前业务分析读取权限尚未核对 原依据与填写已隐藏</p>;
  return <BusinessAssistContent key={access.authority + ":" + props.scope} {...props} />;
}
function BusinessAssistContent({
  selection,
  scope,
  title,
  disabledReason,
  onRestore,
}: {
  selection: AssistBusinessSelection | null;
  scope: string;
  title: string;
  disabledReason?: string;
  onRestore?: (selection: AssistBusinessSelection) => void;
}) {
  const access = useErpAccess(), alive = useRef(true), sequence = useRef(0), controller = useRef<AbortController | null>(null);
  const [denied, setDenied] = useState(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; sequence.current++; controller.current?.abort(); }; }, []);
  const [state, setState] = useState<{ key: string; basis: AssistBasisView } | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const key = JSON.stringify(selection),
    currentKey = useRef(key);
  currentKey.current = key;
  const basis = state?.key === key ? state.basis : null;
  async function read() {
    if (!selection || denied || busy) return;
    const token = ++sequence.current, abort = new AbortController(); controller.current?.abort(); controller.current = abort;
    setBusy(true);
    setError("");
    setState(null);
    try {
      const result = AssistBasisViewSchema.parse(await assistApi("basis", selection, abort.signal, access.authority ?? undefined));
      if (alive.current && !abort.signal.aborted && token === sequence.current && currentKey.current === key) setState({ key, basis: result });
    } catch (cause) {
      if (alive.current && !abort.signal.aborted && token === sequence.current && currentKey.current === key) {
        if (assistReadDenied(cause)) { setState(null); setDenied(true); window.dispatchEvent(new Event("focus")); }
        else setError("当前依据暂不可读取 请重读 不替换原请求");
      }
    } finally {
      if (alive.current && token === sequence.current) setBusy(false);
    }
  }
  if (denied) return <p role="status">当前分析读取权限已变化 原依据和填写已隐藏</p>;
  return (
    <div className="ai-business" aria-label={title}>
      <div className="ai-business-toolbar">
        <strong>分析依据</strong>
        <button
          type="button"
          disabled={!selection || busy || !!disabledReason}
          onClick={() => void read()}
        >
          {busy ? "正在读取…" : basis ? "刷新分析依据" : "读取分析依据"}
        </button>
      </div>
      <p className="ai-assist-muted">先核对系统数据，再开始 AI 分析。读取依据不调用模型。</p>
      {error && (
        <p className="ai-assist-error" role="alert">
          {error}
        </p>
      )}
      {basis && (
        <div className="ai-business-basis">
          <dl>
            {basis.rows.map((r, i) => (
              <div key={i}>
                <dt>{r.label}</dt>
                <dd>{r.value}</dd>
              </div>
            ))}
          </dl>
          {!!basis.checks.length && (
            <ul className="ai-assist-warning">
              {basis.checks.map((c) => (
                <li key={c.code}>{c.message}</li>
              ))}
            </ul>
          )}
          {!!basis.diagnostics.length && (
            <details>
              <summary>数据范围与限制</summary>
              <ul>
                {basis.diagnostics.map((d, i) => (
                  <li key={i}>{d}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
      {selection ? (
        <AssistPanel
          kind={selection.kind}
          scope={scope}
          input={basis ? { ...selection, expectedFingerprint: basis.fingerprint } : null}
          onRestoreBusiness={onRestore}
          disabledReason={
            disabledReason ||
            (basis ? undefined : "请先读取当前分析依据；更换选项或问题说明后需要重新读取。")
          }
        />
      ) : (
        <p className="ai-assist-empty">{disabledReason ?? "请选择需要分析的记录。"}</p>
      )}
    </div>
  );
}

export function FinanceAssist(props: { data: FinanceWorkspaceView }) {
  const access = useErpAccess();
  if (!access.authority || !requiredAssistPermissions("business_review", "read").every(bit => access.can(bit))) return <p role="status">当前经营分析权限尚未核对 原私有选项已隐藏</p>;
  return <FinanceAssistContent key={access.authority} {...props} />;
}
function FinanceAssistContent({ data }: { data: FinanceWorkspaceView }) {
  const [runId, setRunId] = useState(data.runs[0]?.id ?? ""),
    [comparisonRunId, setComparisonRunId] = useState("");
  const label = (id: string) => {
    const r = data.runs.find((run) => run.id === id)!;
    return `${new Date(r.calculatedAt).toLocaleString("zh-CN")} · V${r.metricVersion} · ${r.reportingCurrency} · ${r.status === "complete" ? "完整" : "缺证据"}`;
  };
  return (
    <section className="ai-business-entry" aria-label="经营分析">
      <h2>经营 AI 分析</h2>
      <p>解释利润、成本与关联订单的生产、售后情况，形成待核对的行动清单。</p>
      {data.runs.length ? (
        <div className="ai-business-selectors">
          <label>
            当前利润计算
            <select
              value={runId}
              onChange={(e) => {
                setRunId(e.target.value);
                if (comparisonRunId === e.target.value) setComparisonRunId("");
              }}
            >
              {data.runs.map((r) => (
                <option key={r.id} value={r.id}>
                  {label(r.id)}
                </option>
              ))}
            </select>
          </label>
          <label>
            比较计算（可选）
            <select value={comparisonRunId} onChange={(e) => setComparisonRunId(e.target.value)}>
              <option value="">只分析当前计算</option>
              {data.runs
                .filter((r) => r.id !== runId)
                .map((r) => (
                  <option key={r.id} value={r.id}>
                    {label(r.id)}
                  </option>
                ))}
            </select>
          </label>
        </div>
      ) : null}
      <BusinessAssist
        title="经营分析依据"
        selection={
          runId
            ? { kind: "business_review", runId, comparisonRunId: comparisonRunId || null }
            : null
        }
        scope={`finance:${runId}`}
        onRestore={(s) => {
          if (s.kind === "business_review" && data.runs.some((r) => r.id === s.runId)) {
            setRunId(s.runId);
            setComparisonRunId(
              data.runs.some((r) => r.id === s.comparisonRunId) ? s.comparisonRunId! : "",
            );
          }
        }}
        disabledReason={
          !runId ? "先登记结算与费用、建立利润口径并完成一次计算，再进行经营分析。" : undefined
        }
      />
    </section>
  );
}

export function ProcurementAssist(props: { data: ProcurementWorkspaceView }) {
  const access = useErpAccess();
  if (!access.authority || !requiredAssistPermissions("procurement_review", "read").every(bit => access.can(bit))) return <p role="status">当前采购分析权限尚未核对 原私有选项已隐藏</p>;
  return <ProcurementAssistContent key={access.authority} {...props} />;
}
function ProcurementAssistContent({ data }: { data: ProcurementWorkspaceView }) {
  const [stockItemId, setStockItemId] = useState(
    data.stockItems.find((s) => s.status !== "inactive")?.id ?? "",
  );
  const [locationId, setLocationId] = useState(
    data.locations.find((s) => s.status !== "inactive")?.id ?? "",
  );
  return (
    <section className="ai-business-entry" aria-label="采购分析">
      <h2>采购 AI 分析</h2>
      <p>核对指定货品和库位的补货条件、未收采购、逾期与报价；建议进入现有申请和审批流程。</p>
      <div className="ai-business-selectors">
        <label>
          库存货品
          <select value={stockItemId} onChange={(e) => setStockItemId(e.target.value)}>
            <option value="">选择货品</option>
            {data.stockItems
              .filter((s) => s.status !== "inactive")
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.code} · {s.name}
                </option>
              ))}
          </select>
        </label>
        <label>
          目标库位
          <select value={locationId} onChange={(e) => setLocationId(e.target.value)}>
            <option value="">选择库位</option>
            {data.locations
              .filter((s) => s.status !== "inactive")
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.code} · {s.name}
                </option>
              ))}
          </select>
        </label>
      </div>
      <BusinessAssist
        title="采购分析依据"
        selection={
          stockItemId && locationId ? { kind: "procurement_review", stockItemId, locationId } : null
        }
        scope={`procurement:${stockItemId}:${locationId}`}
        disabledReason={
          !stockItemId || !locationId ? "先在库存工作区登记货品和库位，再选择分析范围。" : undefined
        }
      />
    </section>
  );
}

export function AfterSalesAssist(props: Parameters<typeof AfterSalesAssistContent>[0]) {
  const access = useErpAccess();
  if (!access.authority || !requiredAssistPermissions("after_sales_review", "read").every(bit => access.can(bit))) return <p role="status">当前售后分析权限尚未核对 原说明和填写已隐藏</p>;
  return <AfterSalesAssistContent key={access.authority + ":" + props.caseId} {...props} />;
}
function AfterSalesAssistContent({
  caseId,
  revision,
  disabled,
}: {
  caseId: string;
  revision: string;
  disabled: boolean;
}) {
  const [contextNotes, setNotes] = useState(""),
    [locale, setLocale] = useState<"en-US" | "zh-CN">("en-US");
  const [open, setOpen] = useState(false);
  return (
    <details className="ai-business-entry" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>售后 AI 分析与回复草稿</summary>
      {open && (
        <>
          <div className="ai-business-selectors">
            <label>
              回复语言
              <select value={locale} onChange={(e) => setLocale(e.target.value as typeof locale)}>
                <option value="en-US">英语</option>
                <option value="zh-CN">中文</option>
              </select>
            </label>
            <label className="ai-business-wide">
              给 AI 的问题说明（可选）
              <textarea
                value={contextNotes}
                maxLength={4000}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="简要说明商品问题、客户诉求和已核实的情况；去除姓名、地址与联系方式。"
              />
            </label>
          </div>
          <p className="ai-assist-muted">
            仅发送这里填写的说明及售后状态记录。客户消息正文、原始摘要和附件不自动发送。
          </p>
          <BusinessAssist
            key={`${caseId}:${revision}`}
            title="售后分析依据"
            selection={{ kind: "after_sales_review", caseId, locale, contextNotes }}
            scope={`case:${caseId}`}
            onRestore={(s) => {
              if (s.kind === "after_sales_review" && s.caseId === caseId) {
                setNotes(s.contextNotes);
                setLocale(s.locale);
              }
            }}
            disabledReason={disabled ? "请等待当前业务操作完成。" : undefined}
          />
        </>
      )}
    </details>
  );
}
