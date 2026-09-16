"use client";
import { useEffect, useRef, useState } from "react";
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
  AssistViewSchema,
  type AssistModel,
} from "@yummyai/contracts/ai/assist";
import { assistApi } from "../ai-assist/assist-client";
import { centerRequest, label } from "./order-center-model";

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
export function OrderBulkPanel({
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
  const cancellation = useRef(false);
  const firstId = selected[0]?.id;
  useEffect(
    () => () => {
      cancellation.current = true;
    },
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
        : assistApi("models", undefined, abort.signal).then((value) => {
            const options = AssistModelSchema.array().parse(value);
            setModels(options);
            setModelId(options[0]?.id ?? "");
          })
    )
      .catch((cause) => {
        if (!abort.signal.aborted)
          setError(cause instanceof Error ? cause.message : "选项读取失败");
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [operation, firstId]);
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
    if (!modelId || busy) return;
    setBusy(true);
    setError("");
    cancellation.current = false;
    const next: Result[] = [],
      submitted: string[] = [];
    for (const [index, row] of selected.entries()) {
      if (cancellation.current) break;
      setProgress(`正在分析 ${index + 1} / ${selected.length} 件；结果会保存在对应商品中。`);
      try {
        const detail = OrderWorkDetailViewSchema.parse(await centerRequest(`lines/${row.id}`));
        if (cancellation.current) break;
        let run = AssistViewSchema.parse(
          await assistApi("runs", {
            kind: "order_review",
            orderLineId: row.id,
            expectedRevision: detail.line.revision,
            expectedSourceVersionId: detail.report?.versionId ?? null,
            modelId,
            requestId: crypto.randomUUID(),
          }),
        );
        submitted.push(row.id);
        const start = Date.now();
        while (["queued", "running"].includes(run.status) && !cancellation.current) {
          if (Date.now() - start > 180000)
            throw new Error("任务仍在后台处理，请到本件商品查看结果；后续商品未提交");
          await new Promise((resolve) => setTimeout(resolve, 2000));
          run = AssistViewSchema.parse(await assistApi(`runs/${run.id}`));
        }
        const ok = run.status === "completed";
        next.push({
          id: row.id,
          text: `${row.externalOrderId} / ${row.externalLineId}：${ok ? "预审完成，展开本件查看建议" : run.status === "failed" ? "预审失败，请展开本件查看原因" : "任务已提交，可展开本件查看进度"}`,
          ok,
        });
        if (!ok) cancellation.current = true;
      } catch (cause) {
        next.push({
          id: row.id,
          text: `${row.externalOrderId} / ${row.externalLineId}：${cause instanceof Error ? cause.message : "分析失败"}`,
          ok: false,
        });
        cancellation.current = true;
      }
      setResults([...next]);
    }
    setBusy(false);
    setProgress(`已提交 ${submitted.length} / ${selected.length} 件。AI 建议需逐件核对采纳。`);
  }
  const eligible =
    preview?.items.filter((row) => !row.blockers.length && (row.save || row.action)).length ?? 0;
  const blocked =
    (preview?.items.filter((row) => row.blockers.length).length ?? 0) +
    (preview?.failures.length ?? 0);
  const model = models.find((model) => model.id === modelId);
  return (
    <section className="oc-bulk-panel" aria-label={names[operation]} aria-busy={busy}>
      <header className="oc-section-heading">
        <h2>
          {names[operation]} · {selected.length} 件商品
        </h2>
        <button className="oc-button" disabled={busy} onClick={onClose}>
          关闭批量面板
        </button>
      </header>
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
              disabled={!modelId || busy || !selected.length}
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
