"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  OrderBulkPreviewSchema,
  OrderWorkDetailViewSchema,
  type OrderBulkPreview,
  type OrderBulkPreviewInput,
  type OrderWorkDetail,
  type OrderWorkListItem,
} from "@yummyai/contracts/order/workspace";
import {
  AssistModelSchema,
  type AssistModel,
  type AssistView,
} from "@yummyai/contracts/ai/assist";
import { requiredAssistPermissions } from "@yummyai/authz/assist-policy";
import { useErpAccess } from "../identity/erp-access";
import { assistApi, assistReadDenied, AssistRequestError } from "../ai-assist/assist-client";
import { AssistRequestRecovery } from "../ai-assist/assist-request-recovery";
import { ASSIST_INTENT_CLEAR_EVENT, assistIntentIdentity, prepareAssistIntent, readAssistIntents, saveAssistIntent, useAssistIntentMarkers } from "../ai-assist/assist-request-intent";
import { assertAssistEntryResponse, assistEntryVerification, recordAssistEntryRun } from "../ai-assist/assist-entry-recovery";
import { centerRequest, label, OrderCenterRequestError } from "./order-center-model";
import "../ai-assist/assist-entry-recovery.css";

export type BulkOperation = OrderBulkPreviewInput["operation"] | "ai";
const names: Record<BulkOperation, string> = {
  check: "批量检查",
  bind: "批量绑定印花 / 产品",
  assign: "批量设置设计安排",
  needs_information: "批量标记待补资料",
  ready_to_push: "批量确认审单",
  push: "批量推送设计",
  ai: "批量 AI 预审",
};
type Result = { id: string; text: string; ok: boolean };
const deniedAiRead = (cause: unknown) => assistReadDenied(cause) || cause instanceof OrderCenterRequestError &&
  ([401, 403, 404].includes(cause.status) || cause.status === 409 && cause.code === "authority_changed");
export function OrderBulkPanel(props: Parameters<typeof OrderBulkPanelContent>[0]) {
  const access = useErpAccess(), owner = useRef(access.authority);
  if (props.operation === "ai" && (!access.authority || owner.current !== access.authority ||
    !requiredAssistPermissions("order_review", "read").every(bit => access.can(bit))))
    return <section className="oc-bulk-panel" aria-label={names.ai}><p role="status">当前订单 AI 读取权限尚未核对 原所选商品和分析已隐藏</p></section>;
  const identityKey = props.operation === "ai" ? access.authority + ":" + props.selected.map(row => row.id + ":" + row.revision + ":" + row.projectionVersion).join(",") : props.operation;
  return <OrderBulkPanelContent key={identityKey} {...props} />;
}
function OrderBulkPanelContent({
  operation,
  selected,
  onClose,
  onBusy,
  onCompleted,
  onOpen,
}: {
  operation: BulkOperation;
  selected: OrderWorkListItem[];
  onClose: () => void;
  onBusy: (busy: boolean) => void;
  onCompleted: (ids: string[]) => void;
  onOpen: (id: string) => void;
}) {
  const access = useErpAccess(), authority = access.authority ?? undefined;
  const intents = useAssistIntentMarkers(operation === "ai" ? access.preferenceScope : null, "order_review");
  const canAnalyze = requiredAssistPermissions("order_review", "run").every(bit => access.can(bit));
  const currentAuthority = useRef(authority); currentAuthority.current = access.authority ?? undefined;
  const [catalog, setCatalog] = useState<OrderWorkDetail["catalog"]>();
  const [patch, setPatch] = useState<OrderBulkPreviewInput["patch"]>({});
  const [onlyEmpty, setOnlyEmpty] = useState(true),
    [reason, setReason] = useState("运营批量核对订单制作需求");
  const [preview, setPreview] = useState<OrderBulkPreview | null>(null),
    [results, setResults] = useState<Result[]>([]);
  const [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(false),
    [error, setError] = useState("");
  const [models, setModels] = useState<AssistModel[]>([]),
    [modelId, setModelId] = useState("");
  const [progress, setProgress] = useState("");
  const [aiDenied, setAiDenied] = useState(false);
  const cancellation = useRef(false), alive = useRef(true), submittingAi = useRef(false), aiEpoch = useRef(0), privateBlocked = useRef(false),
    aiRead = useRef<AbortController | null>(null), recoveryEpoch = useRef(0);
  const aiCurrent = useCallback((token: number) => alive.current && !privateBlocked.current && token === aiEpoch.current && currentAuthority.current === authority, [authority]);
  const denyAi = useCallback(() => {
    privateBlocked.current = true; cancellation.current = true; aiEpoch.current++; recoveryEpoch.current++; aiRead.current?.abort();
    setAiDenied(true); setBusy(false); setResults([]); setPreview(null); setCatalog(undefined); setModels([]); setModelId(""); setPatch({}); setReason(""); setProgress(""); setError("");
    window.dispatchEvent(new Event("focus"));
  }, []);
  const firstId = selected[0]?.id;
  useEffect(() => {
    if (operation !== "ai") return;
    window.addEventListener(ASSIST_INTENT_CLEAR_EVENT, denyAi);
    return () => window.removeEventListener(ASSIST_INTENT_CLEAR_EVENT, denyAi);
  }, [operation, denyAi]);
  useEffect(
    () => { alive.current = true; return () => {
      alive.current = false; cancellation.current = true; aiEpoch.current++; recoveryEpoch.current++; aiRead.current?.abort();
    }; },
    [],
  );
  useEffect(() => {
    onBusy(busy);
    return () => onBusy(false);
  }, [busy, onBusy]);
  useEffect(() => {
    const abort = new AbortController();
    if (operation !== "bind" && operation !== "ai") return;
    if (operation === "bind" && !firstId) return;
    setLoading(true);
    void (
      operation === "bind" && firstId
        ? centerRequest(`lines/${firstId}`, undefined, abort.signal).then((value) =>
            setCatalog(OrderWorkDetailViewSchema.parse(value).catalog),
          )
        : assistApi("models", undefined, abort.signal, authority).then((value) => {
            if (abort.signal.aborted || !alive.current || privateBlocked.current || currentAuthority.current !== authority) return;
            const options = AssistModelSchema.array().parse(value);
            setModels(options);
            setModelId(options[0]?.id ?? "");
          })
    )
      .catch((cause) => {
        if (!abort.signal.aborted && alive.current) {
          if (operation === "ai" && deniedAiRead(cause)) denyAi();
          else setError(cause instanceof Error ? cause.message : "选项读取失败");
        }
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [operation, firstId, authority, denyAi]);
  function change(next: OrderBulkPreviewInput["patch"]) {
    setPatch(next);
    setPreview(null);
    setResults([]);
  }
  async function check() {
    if (busy || operation === "ai") return;
    setBusy(true);
    setError("");
    setResults([]);
    setPreview(null);
    cancellation.current = false;
    setProgress("正在逐件核对制作需求…");
    try {
      const combined: OrderBulkPreview = { items: [], failures: [] };
      for (let offset = 0; offset < selected.length; offset += 10) {
        if (cancellation.current) throw new Error("已停止检查，请重新预览后再确认处理。");
        setProgress(
          `正在检查 ${offset + 1}–${Math.min(offset + 10, selected.length)} / ${selected.length} 件`,
        );
        const chunk = OrderBulkPreviewSchema.parse(
          await centerRequest("bulk/preview", {
            ids: selected.slice(offset, offset + 10).map((row) => row.id),
            operation,
            patch,
            onlyEmpty,
            reason,
          }),
        );
        combined.items.push(...chunk.items);
        combined.failures.push(...chunk.failures);
      }
      if (cancellation.current) throw new Error("已停止检查，请重新预览后再确认处理。");
      setPreview(combined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "预览失败");
    } finally {
      setBusy(false);
      setProgress("");
    }
  }
  async function execute() {
    if (!preview || busy) return;
    setBusy(true);
    setError("");
    cancellation.current = false;
    const completed: string[] = [],
      next: Result[] = [];
    const eligible = preview.items.filter(
      (row) => !row.blockers.length && (row.save || row.action),
    );
    for (const [index, row] of eligible.entries()) {
      if (cancellation.current) break;
      setProgress(`正在处理 ${index + 1} / ${eligible.length} 件`);
      try {
        await centerRequest(
          `lines/${row.line.id}/${row.save ? "draft" : "actions"}`,
          row.save ?? row.action,
        );
        completed.push(row.line.id);
        next.push({
          id: row.line.id,
          text: `${row.line.externalOrderId} / ${row.line.externalLineId}：已完成`,
          ok: true,
        });
      } catch (cause) {
        next.push({
          id: row.line.id,
          text: `${row.line.externalOrderId} / ${row.line.externalLineId}：${cause instanceof Error ? cause.message : "处理失败"}`,
          ok: false,
        });
      }
      setResults([...next]);
    }
    onCompleted(completed);
    // Retain exact request IDs and versions for safe retry after an uncertain response.
    setPreview(
      (current) =>
        current && {
          ...current,
          items: current.items.filter((item) => !completed.includes(item.line.id)),
        },
    );
    setBusy(false);
    setProgress(
      cancellation.current
        ? "已停止后续处理，未完成的商品保持选中。"
        : "本批处理结束；失败和受阻的商品保持选中。",
    );
  }
  async function analyze() {
    if (!modelId || busy || submittingAi.current || !canAnalyze || !authority || !access.preferenceScope || !intents.ready || intents.error || !selected.length) return;
    submittingAi.current = true;
    const token = ++aiEpoch.current, batch = [...selected], chosenModel = modelId, preferenceScope = access.preferenceScope;
    setBusy(true); setError(""); setResults([]); cancellation.current = false;
    const next: Result[] = [], submitted: string[] = [];
    const abort = new AbortController(); aiRead.current?.abort(); aiRead.current = abort;
    try {
      setProgress("正在核对全部所选商品的原请求标识 尚未提交任何新任务");
      const identities = await Promise.all(batch.map(row => assistIntentIdentity(preferenceScope, "order_review", "order:" + row.id)));
      if (!aiCurrent(token) || cancellation.current) return;
      const markers = readAssistIntents(identities[0]!.ownerScope).filter(item => item.kind === "order_review");
      if (markers.some(item => item.runId === null || identities.some(identity => identity.taskScope === item.taskScope)))
        throw new AssistRequestError(409, "所选商品已有原 AI 请求 或本人仍有未知订单请求 本批尚未提交任何新任务 请先读取原回执 不重新编号");
      for (const [index, row] of batch.entries()) {
        if (!aiCurrent(token) || cancellation.current) break;
        setProgress("正在分析 " + (index + 1) + " / " + batch.length + " 件 结果保存在对应商品 原回执未确认前不重复提交");
        try {
          const detail = OrderWorkDetailViewSchema.parse(await centerRequest("lines/" + row.id, undefined, abort.signal, authority));
          if (!aiCurrent(token) || cancellation.current) break;
          if (detail.line.id !== row.id) throw new AssistRequestError(502, "原商品读取结果与所选 ID 不符 本次未提交");
          const original = await prepareAssistIntent({
            kind: "order_review", orderLineId: row.id, expectedRevision: detail.line.revision,
            expectedSourceVersionId: detail.report?.versionId ?? null, modelId: chosenModel, requestId: crypto.randomUUID(),
          }, preferenceScope, "order:" + row.id);
          if (!aiCurrent(token) || cancellation.current) break;
          const currentMarkers = readAssistIntents(identities[index]!.ownerScope).filter(item => item.kind === "order_review");
          if (currentMarkers.some(item => item.runId === null || item.taskScope === identities[index]!.taskScope))
            throw new AssistRequestError(409, "这件商品的原请求标识已变化 请读取原回执 后续商品未提交");
          saveAssistIntent(original.intent);
          const raw = await assistApi("runs", original.request, undefined, authority);
          if (!aiCurrent(token)) break;
          let run = await assertAssistEntryResponse(raw, original.request, "order:" + row.id);
          if (!aiCurrent(token)) break;
          submitted.push(row.id);
          try { recordAssistEntryRun(original.intent, run.id); }
          catch { throw new AssistRequestError(0, "原任务已登记 但本地任务 ID 更新失败 请只读取原回执 后续商品未提交"); }
          const started = Date.now();
          while (["queued", "running"].includes(run.status) && !cancellation.current) {
            if (Date.now() - started > 180_000)
              throw new AssistRequestError(0, "原任务仍可能在后台处理 请读取原回执 后续商品未提交");
            await new Promise<void>((resolve, reject) => {
              const stop = () => { clearTimeout(timer); reject(new Error("原任务状态读取已停止")); };
              const timer = setTimeout(() => { abort.signal.removeEventListener("abort", stop); resolve(); }, 2000);
              abort.signal.addEventListener("abort", stop, { once: true });
              if (abort.signal.aborted) stop();
            });
            if (!aiCurrent(token) || cancellation.current) break;
            const rawRun = await assistApi("runs/" + run.id, undefined, abort.signal, authority);
            if (!aiCurrent(token)) break;
            run = await assertAssistEntryResponse(rawRun, original.request, "order:" + row.id);
            if (!aiCurrent(token)) break;
          }
          if (!aiCurrent(token)) break;
          const ok = run.status === "completed" && !run.stale;
          next.push({ id: row.id, text: row.externalOrderId + " / " + row.externalLineId + "：" +
            (ok ? "预审完成 请展开本件核对建议" : run.stale ? "原依据已变化 请读取原任务核对" :
              run.status === "failed" ? "原预审失败 请读取原因 不自动重跑" : "原任务已登记 请读取原进度"), ok });
          if (!ok) cancellation.current = true;
        } catch (cause) {
          if (!aiCurrent(token)) break;
          if (deniedAiRead(cause)) { denyAi(); break; }
          next.push({ id: row.id, text: row.externalOrderId + " / " + row.externalLineId + "：" +
            (cause instanceof Error ? cause.message : "原请求结果尚未确认 请只读取原回执"), ok: false });
          cancellation.current = true;
        }
        if (aiCurrent(token)) setResults([...next]);
      }
      if (aiCurrent(token)) setProgress("本次已核对登记 " + submitted.length + " / " + batch.length + " 件 后续未提交行不自动继续 AI 建议仍需逐件核对采纳");
    } catch (cause) {
      if (aiCurrent(token)) {
        if (deniedAiRead(cause)) denyAi();
        else { setError(cause instanceof Error ? cause.message : "原请求标识无法核对 本批未重复发送"); setProgress(""); }
      }
    } finally {
      submittingAi.current = false;
      if (aiCurrent(token)) {
        setBusy(false);
        if (cancellation.current && !submitted.length && !next.length)
          setProgress("已停止本批处理 本次未确认任何新任务登记 请仍按原请求标识核对 不自动继续");
      }
    }
  }
  function recoveredAi(view: AssistView) {
    if (submittingAi.current || privateBlocked.current || !alive.current) return;
    const token = ++recoveryEpoch.current, epoch = aiEpoch.current;
    void (async () => {
      if (view.kind !== "order_review" || view.request && view.request.kind !== "order_review")
        throw new AssistRequestError(502, "原回执不是订单预审 未更新所选商品");
      const proof = await assistEntryVerification(view);
      if (!aiCurrent(epoch) || token !== recoveryEpoch.current) return;
      if (!proof || view.request?.kind !== "order_review") {
        setProgress("原预审正文已不可用 仅保留原回执 不猜测对应商品或自动采纳"); return;
      }
      const orderLineId = view.request.orderLineId, actual = selected.find(item => item.id === orderLineId);
      if (!actual) { setProgress("已读取本人的原预审回执 当前未选择该原商品 不更新其他行"); return; }
      const ok = view.status === "completed" && !view.stale;
      setResults(rows => [...rows.filter(item => item.id !== orderLineId), { id: orderLineId, ok,
        text: actual.externalOrderId + " / " + actual.externalLineId + "：" + (ok ? "已找回原预审 仅供核对 未自动采纳订单" : "已找回原预审回执 请核对实际状态") }]);
      setProgress("只读取原请求回执 未发起新预审 未自动采纳订单");
      setError("");
    })().catch(cause => { if (aiCurrent(epoch) && token === recoveryEpoch.current) {
      if (deniedAiRead(cause)) denyAi(); else setError(cause instanceof Error ? cause.message : "原预审回执暂不可恢复"); } });
  }
  const eligible =
    preview?.items.filter((row) => !row.blockers.length && (row.save || row.action)).length ?? 0;
  const blocked =
    (preview?.items.filter((row) => row.blockers.length).length ?? 0) +
    (preview?.failures.length ?? 0);
  const model = models.find((model) => model.id === modelId);
  if (operation === "ai" && aiDenied) return <section className="oc-bulk-panel" aria-label={names.ai}>
    <p role="status">当前订单 AI 读取权限已变化 原商品 分析和填写已隐藏 同一账号的纯 ID 标识保留供后续核对</p>
    <button type="button" className="oc-button" onClick={onClose}>关闭批量面板</button>
  </section>;
  return (
    <section className={"oc-bulk-panel" + (operation === "ai" ? " assist-entry-recovery" : "")} aria-label={names[operation]} aria-busy={busy}>
      <header className="oc-section-heading">
        <h2>
          {names[operation]} · {selected.length} 件商品
        </h2>
        <button className="oc-button" disabled={busy} onClick={onClose}>
          关闭批量面板
        </button>
      </header>
      {operation === "ai" && <>
        <AssistRequestRecovery kind="order_review" onRecovered={recoveredAi} onReadDenied={denyAi} />
        <p className="assist-entry-note">开始前先核对全部所选商品的原请求 任一行已有原提交时整批不重新编号 读取回执只恢复真实原行状态 不自动采纳订单</p>
        {!canAnalyze && <p className="oc-hint">当前可读取原订单预审 发起新预审还需订单写权限</p>}
        {intents.error && <p className="oc-error" role="alert">{intents.error}</p>}
      </>}
      <fieldset disabled={busy}>
        <div className="oc-bulk-fields">
          {operation === "bind" && (
            <>
              <label>
                绑定印花 SKU
                <select
                  aria-label="批量印花 SKU"
                  value={patch.artworkVersionId ?? ""}
                  disabled={loading}
                  onChange={(event) =>
                    change({ ...patch, artworkVersionId: event.target.value || undefined })
                  }
                >
                  <option value="">保持原值</option>
                  {catalog?.artworks.map((art) => (
                    <option key={art.id} value={art.id}>
                      {art.code} · {art.name} · V{art.version}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                绑定产品 SPU / 具体规格
                <select
                  aria-label="批量产品规格"
                  value={patch.specificationVersionId ?? ""}
                  disabled={loading}
                  onChange={(event) =>
                    change({ ...patch, specificationVersionId: event.target.value || undefined })
                  }
                >
                  <option value="">保持原值</option>
                  {catalog?.specifications.map((spec) => (
                    <option key={spec.id} value={spec.id}>
                      {spec.spuCode} · {spec.name} · {spec.dimensions}
                    </option>
                  ))}
                </select>
              </label>
            </>
          )}
          {operation === "assign" && (
            <>
              <label>
                执行方式
                <select
                  aria-label="批量执行方式"
                  value={patch.designExecutor ?? ""}
                  onChange={(event) =>
                    change({
                      ...patch,
                      designExecutor: (event.target.value || undefined) as
                        "human" | "agent" | undefined,
                    })
                  }
                >
                  <option value="">保持原值</option>
                  <option value="human">美工设计</option>
                  <option value="agent">无人设计 Agent</option>
                </select>
              </label>
              <label>
                内部截止时间
                <input
                  type="datetime-local"
                  aria-label="批量内部截止时间"
                  onChange={(event) =>
                    change({
                      ...patch,
                      dueAt: event.target.value
                        ? new Date(event.target.value).toISOString()
                        : undefined,
                    })
                  }
                />
              </label>
            </>
          )}
          {operation !== "ai" && operation !== "check" && (
            <label>
              操作原因
              <input
                aria-label="批量操作原因"
                value={reason}
                maxLength={2000}
                onChange={(event) => {
                  setReason(event.target.value);
                  setPreview(null);
                }}
              />
            </label>
          )}
          {operation === "ai" && (
            <label>
              分析模型
              <select
                value={modelId}
                disabled={loading}
                onChange={(event) => setModelId(event.target.value)}
              >
                <option value="">请选择模型</option>
                {models.map((model) => (
                  <option value={model.id} key={model.id}>
                    {model.label}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        {["bind", "assign"].includes(operation) && (
          <label className="oc-inline-check">
            <input
              type="checkbox"
              checked={onlyEmpty}
              onChange={(event) => {
                setOnlyEmpty(event.target.checked);
                setPreview(null);
              }}
            />
            仅补空值；关闭后会替换已有绑定或安排
          </label>
        )}
        {["bind", "assign"].includes(operation) && (
          <p className="oc-hint">
            修改后生成新需求版本并回到待审单；买家文字、图片和备注保持原样。
          </p>
        )}
        {operation === "ai" &&
          (!loading && !models.length ? (
            <p className="oc-notice">尚未配置分析模型，请先在 AI 设置中添加渠道和模型。</p>
          ) : (
            <p className="oc-hint">
              {model?.maxTaskCostUsd != null ? `逐件提交预审，单件费用上限 $${model.maxTaskCostUsd}，本批上限 $${(model.maxTaskCostUsd * selected.length).toFixed(2)}` : `逐件提交 ${selected.length} 次预审，每次最多输出 6000 tokens；未配置单价，整批费用以渠道账单为准`}
              。关闭页面后停止提交后续商品，已提交的任务继续运行。
            </p>
          ))}
        <div className="oc-actions">
          {operation === "ai" ? (
            <button
              className="oc-button primary"
              disabled={!modelId || busy || !selected.length || !canAnalyze || !intents.ready || Boolean(intents.error)}
              onClick={() => void analyze()}
            >
              开始本批 AI 预审
            </button>
          ) : (
            <button
              className="oc-button"
              disabled={loading || busy || !reason.trim() || !selected.length}
              onClick={() => void check()}
            >
              {operation === "check" ? "检查所选商品" : "预览变更与检查"}
            </button>
          )}
          {preview && operation !== "check" && (
            <button
              className="oc-button primary"
              disabled={busy || !eligible}
              onClick={() => void execute()}
            >
              确认处理 {eligible} 件
            </button>
          )}
        </div>
      </fieldset>
      {busy && (
        <button
          className="oc-button"
          onClick={() => {
            cancellation.current = true;
            setProgress("当前请求完成后停止后续处理…");
          }}
        >
          停止后续处理
        </button>
      )}
      {error && (
        <p className="oc-error" role="alert">
          {error}
        </p>
      )}
      {progress && <p role="status">{progress}</p>}
      {preview && (
        <>
          <p role="status">
            {operation === "check"
              ? `检查通过 ${preview.items.filter((row) => !row.blockers.length).length} 件`
              : `可处理 ${eligible} 件`}{" "}
            · 受阻 / 无需修改 {blocked} 件
          </p>
          <div className="oc-bulk-results">
            {preview.items.map((row) => (
              <div className="oc-bulk-result" key={row.line.id}>
                <strong>
                  {row.line.externalOrderId} / {row.line.externalLineId}
                </strong>
                <span>
                  {label(row.line.preparation)} · V{row.line.revision}
                </span>
                <div>
                  {row.changes.map((change) => (
                    <p key={change}>{change}</p>
                  ))}
                  {row.blockers.map((message) => (
                    <p className="oc-error" key={message}>
                      {message}
                    </p>
                  ))}
                </div>
              </div>
            ))}
            {preview.failures.map((row) => (
              <p className="oc-error" key={row.id}>
                {row.message}（{row.id}）
              </p>
            ))}
          </div>
        </>
      )}
      {!!results.length && (
        <div className="oc-bulk-results" aria-label="批量处理结果">
          <p>
            已完成 {results.filter((result) => result.ok).length} 件 · 待处理{" "}
            {results.filter((result) => !result.ok).length} 件
          </p>
          {results.map((result) => (
            <p key={result.id} className={result.ok ? "oc-notice" : "oc-error"}>
              {result.text}{" "}
              <button className="oc-text-button" disabled={busy} onClick={() => onOpen(result.id)}>
                查看商品
              </button>
            </p>
          ))}
        </div>
      )}
    </section>
  );
}
