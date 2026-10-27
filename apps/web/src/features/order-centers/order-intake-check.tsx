"use client";
import { useEffect, useRef, useState } from "react";
import { CircleAlert, CircleCheck, RefreshCw } from "lucide-react";
import {
  CheckOrderIntakeInputSchema, OrderIntakeCheckViewSchema, orderDesignExecutor,
  type OrderIntakeCheck, type OrderWorkDetail, type OrderWorkDraft,
} from "@yummyai/contracts/order/workspace";
import { centerRequest, dateTime } from "./order-center-model";
import { orderImageSelectionProblem, orderIntakeReceiptMatches, orderIntakeResultCurrent,
  orderIntakeSnapshot, type OrderIntakeSnapshot } from "./order-work-input-model";
import { orderReviewIssueAction, orderReviewIssueTarget, orderReviewLineState, type OrderReviewCheckState, type OrderReviewTarget } from "./order-review-model";

const fieldStatus = { mapped: "已匹配", missing: "待补资料", conflict: "待确认", optional: "选填", inactive: "本单不适用" };
type Result = { check: OrderIntakeCheck; snapshot: OrderIntakeSnapshot; projectionVersion: number; lineState: string };

export function OrderIntakeCheckPanel({ detail, draft, disabled, editable, onChange, onStateChange, onLocate }: {
  detail: OrderWorkDetail;
  draft: OrderWorkDraft;
  disabled: boolean;
  editable: boolean;
  onChange: (draft: OrderWorkDraft) => void;
  onStateChange?: (state: OrderReviewCheckState) => void;
  onLocate?: (target: OrderReviewTarget, fieldKey?: string | null) => void;
}) {
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ snapshot: OrderIntakeSnapshot; message: string } | null>(null);
  const [refresh, setRefresh] = useState(0);
  const snapshot = orderIntakeSnapshot(detail, draft);
  const lineState = orderReviewLineState(detail);
  const confirmed = detail.line.preparation === "ready_to_push" && !detail.line.held && !detail.line.sourceChanged &&
    !detail.line.archivedAt && detail.line.sideState !== "cancelled" && JSON.stringify(draft) === JSON.stringify(detail.draft);
  const imageFields = detail.catalog?.artworks.find(art => art.id === draft.artworkVersionId)?.customization.fields ?? [];
  const localImageProblem = editable ? orderImageSelectionProblem(imageFields, draft.images) : null;
  const live = useRef({ snapshot, disabled, editable, detail, draft });
  live.current = { snapshot, disabled, editable, detail, draft };
  const pending = useRef<AbortController | null>(null);
  const consumedRefresh = useRef(0);

  useEffect(() => {
    pending.current?.abort();
    pending.current = null;
    if (disabled) { setBusy(false); return; }
    if (localImageProblem) { setBusy(false); setResult(null); setError(null); return; }
    const explicitRefresh = consumedRefresh.current !== refresh;
    if ((!editable || confirmed) && !explicitRefresh) { setBusy(false); return; }
    consumedRefresh.current = refresh;
    const checked = live.current.snapshot;
    const checkedProjection = live.current.detail.line.projectionVersion;
    const checkedLineState = orderReviewLineState(live.current.detail);
    const abort = new AbortController();
    pending.current = abort;
    setBusy(true);
    setResult(null);
    setError(null);
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const input = CheckOrderIntakeInputSchema.safeParse(JSON.parse(checked.input));
          if (!input.success) throw new Error("当前填写有无效或重复内容，请核对顾客要求与图片后重试");
          const response = await centerRequest(`lines/${checked.orderLineId}/intake-check`, input.data, abort.signal);
          if (abort.signal.aborted || pending.current !== abort || checked.input !== live.current.snapshot.input ||
            checked.orderLineId !== live.current.snapshot.orderLineId || checkedLineState !== orderReviewLineState(live.current.detail)) return;
          const check = OrderIntakeCheckViewSchema.parse(response);
          if (!orderIntakeReceiptMatches(check, checked)) throw new Error("订单或来源版本已变化，请重新核对，当前填写仍保留");
          const value = live.current;
          const fields = value.detail.catalog?.artworks.find(art => art.id === value.draft.artworkVersionId)?.customization.fields ?? [];
          const imageProblem = orderImageSelectionProblem(fields, value.draft.images);
          if (imageProblem && !check.issues.some(issue => /image|photo/.test(issue.code) ||
            check.fields.some(field => field.type === "image" && field.key === issue.fieldKey))) {
            check.issues.push({ code: "image_selection_invalid", fieldKey: null, message: imageProblem,
              action: "在顾客原图中选择对应图片字段，或取消暂不使用的图片" });
            check.ready = false;
          }
          setResult({ check, snapshot: checked, projectionVersion: checkedProjection, lineState: checkedLineState });
        } catch (cause) {
          if (!abort.signal.aborted && pending.current === abort && checked.input === live.current.snapshot.input &&
            checked.orderLineId === live.current.snapshot.orderLineId && checkedLineState === orderReviewLineState(live.current.detail))
            setError({ snapshot: checked, message: cause instanceof Error ? cause.message : "暂时无法核对审单条件，请重试" });
        } finally {
          if (pending.current === abort) { pending.current = null; if (!abort.signal.aborted) setBusy(false); }
        }
      })();
    }, 350);
    return () => {
      window.clearTimeout(timer);
      abort.abort();
      if (pending.current === abort) pending.current = null;
    };
  }, [snapshot.orderLineId, snapshot.input, lineState, disabled, editable, confirmed, refresh, localImageProblem]);

  const current = result && orderIntakeResultCurrent(result, snapshot) && result.lineState === lineState ? result.check : null;
  const visibleError = error && error.snapshot.orderLineId === snapshot.orderLineId && error.snapshot.input === snapshot.input ? error.message : null;
  const readOnlyMessage = !editable && !confirmed && !current && !busy ? detail.line.held
    ? "订单已暂停，请查看暂停原因并恢复后再审单"
    : "当前阶段只读，可查看已保存要求或手动核对资料" : null;
  const status: OrderReviewCheckState["status"] = localImageProblem ? "blocked" : visibleError ? "failed" : readOnlyMessage ? "blocked" : confirmed && !busy ? "ready" :
    busy || !current ? "checking" : current.ready ? "ready" : "blocked";
  const stateError = localImageProblem ?? visibleError ?? readOnlyMessage;
  useEffect(() => {
    onStateChange?.({ orderLineId: snapshot.orderLineId, input: snapshot.input, projectionVersion: detail.line.projectionVersion, lineState, status, check: current, error: stateError });
  }, [snapshot.orderLineId, snapshot.input, detail.line.projectionVersion, lineState, status, current, stateError, onStateChange]);

  const automatic = current?.issues.some(issue => issue.code === "automatic_artwork_not_ready") && orderDesignExecutor(draft) === "agent";
  function manual() {
    const value = live.current;
    if (!current || value.disabled || !value.editable || !orderIntakeReceiptMatches(current, value.snapshot) ||
      !result || !orderIntakeResultCurrent(result, value.snapshot) || result.lineState !== orderReviewLineState(value.detail)) return;
    onChange({ ...value.draft, designExecutor: "human" });
  }
  const title = localImageProblem ? "还有 1 项需要处理" : stateError ? editable ? "暂时无法完成审单检查" : "当前暂不能审单" : confirmed && !busy ? "审单已确认" : status === "checking" ? "正在检查审单条件" :
    status === "ready" ? "可以确认审单" : `还有 ${current?.issues.length || 1} 项需要处理`;
  return <section className={`oc-section oc-intake oc-review-check is-${status}`} aria-label="定制订单承接核对" aria-busy={busy}>
    <div className="oc-section-heading oc-review-check-heading">
      <strong role="status" aria-live="polite">{status === "ready" ? <CircleCheck size={17} aria-hidden="true" /> : <CircleAlert size={17} aria-hidden="true" />}{title}</strong>
      <button type="button" className="oc-button" disabled={disabled || busy} onClick={() => setRefresh(value => value + 1)}>
        <RefreshCw size={14} aria-hidden="true" />{busy ? "正在核对…" : "核对当前需求"}
      </button>
    </div>
    {status === "checking" && <p className="oc-hint">正在检查本单顾客要求、原图和制图方式 修改后会自动重新检查</p>}
    {confirmed && !busy && !stateError && <p className="oc-hint">本件审单已保存 可继续推送制图</p>}
    {stateError && <p role="alert" className="oc-error">{stateError}</p>}
    {localImageProblem && onLocate && <button type="button" className="oc-button" disabled={disabled} onClick={() => onLocate("images")}>补齐顾客原图</button>}
    {current && <>
      {current.ready && !confirmed && <p className="oc-hint">必填内容与制图方式已核对 点击确认审单即可保存匹配结果</p>}
      {!!current.issues.length && <ul className="oc-intake-issues oc-review-check-issues" aria-label="承接待办">
        {current.issues.map((issue, index) => {
          const target = orderReviewIssueTarget(issue, current);
          return <li key={`${issue.code}:${issue.fieldKey}:${index}`}>
            <div><strong>{issue.message}</strong><span>{issue.action}</span></div>
            {onLocate && <button type="button" className="oc-button" disabled={disabled} onClick={() => onLocate(target, issue.fieldKey)}>{orderReviewIssueAction(target)}</button>}
          </li>;
        })}
      </ul>}
      {automatic && editable && <div className="oc-review-check-actions">
        <button type="button" className="oc-button primary" disabled={disabled || busy} onClick={manual}>改由美工制作</button>
        <span className="oc-hint">保留顾客全部要求 选择后继续审单 由美工核对并制作</span>
      </div>}
      <details className="oc-review-check-details">
        <summary>查看自动匹配与核对详情</summary>
        <p className="oc-hint">{current.basis === "sealed" ? `封存资料 V${current.package?.version} · 核对时间 ${dateTime(current.package?.reviewedAt ?? "")}` :
          current.basis === "legacy_package" ? "本单使用已固定的历史制作资料" : current.basis === "manual" ? "本单采用直接匹配的制作依据" : "请先匹配制作依据"}</p>
        <div className="oc-intake-fields" aria-label="定制字段匹配">{current.fields.map(field => <div className="oc-intake-row" key={field.key}>
          <span><strong>{field.label}</strong><small>{field.required ? "本单必填" : "选填"}{field.type === "image" ? ` · 已绑定 ${field.imageCount} 张原图` : ""}</small></span>
          <span className={`oc-badge ${field.status === "missing" || field.status === "conflict" ? "warning" : ""}`}>{fieldStatus[field.status]}</span>
        </div>)}</div>
        <ul className="oc-intake-notes">{current.notes.map((note, index) => <li key={index}>{note}</li>)}</ul>
        {current.package && <dl className="oc-template-versions"><dt>资料包</dt><dd>{current.package.id}</dd><dt>交付核对</dt><dd>{current.package.reviewId ?? "历史记录缺失"}</dd></dl>}
      </details>
    </>}
  </section>;
}
