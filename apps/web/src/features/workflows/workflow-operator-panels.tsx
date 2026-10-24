"use client";
import {
  WorkflowNodeInspectionSchema,
  WorkflowRepairOptionsSchema,
  WorkflowArtifactInspectionSchema,
  type WorkflowNodeInspection,
  type WorkflowRepairOptions,
  type WorkflowArtifactInspection,
} from "@yummyai/contracts/workflow/operator";
import type { WorkflowRunDetail } from "@yummyai/contracts/workflow";
import {
  ChevronDown,
  FileDown,
  FileSearch,
  History,
  LoaderCircle,
  RotateCcw,
  SlidersHorizontal,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { PodToolParameters } from "../pod/pod-task-create-panel";
import { customProductIssueLabel } from "../products/custom-product-issue-label";
import { workflowHref } from "../navigation/workflow-href";
import { repairWorkflowNode, type WorkflowActionState } from "./workflow-actions";
import { readWorkflow } from "./workflow-operator-client";
import { InvocationEvidence } from "../execution/invocation-evidence";
import { MethodEvidence } from "../ai-assist/method-evidence";

export function useNodeInspection(
  runId: string,
  nodeId: string,
  refresh: string | number,
  active: boolean,
) {
  const [state, setState] = useState<{
    key: string;
    value?: WorkflowNodeInspection;
    error?: string;
  }>({ key: "" });
  const key = `${runId}:${nodeId}`;
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      if (controller.signal.aborted) return;
      if (document.visibilityState !== "visible") {
        if (active) timer = setTimeout(load, 5000);
        return;
      }
      try {
        const value = await readWorkflow(
          `${runId}/nodes/${encodeURIComponent(nodeId)}/execution`,
          WorkflowNodeInspectionSchema,
          controller.signal,
        );
        if (!controller.signal.aborted) setState({ key, value });
      } catch (error) {
        if (!controller.signal.aborted)
          setState({ key, error: error instanceof Error ? error.message : "执行记录暂不可用" });
      }
      if (!controller.signal.aborted && active) timer = setTimeout(load, 5000);
    };
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [runId, nodeId, key, refresh, active]);
  return state.key === key ? state : { key };
}

export function WorkflowCollapse({
  label,
  icon,
  children,
  open,
  onToggle,
}: {
  label: string;
  icon?: ReactNode;
  children: ReactNode;
  open: boolean;
  onToggle(): void;
}) {
  return (
    <section className="wf-operator-section">
      <button className="wf-disclosure" aria-expanded={open} onClick={onToggle} type="button">
        {icon}
        <span>{label}</span>
        <ChevronDown size={15} />
      </button>
      <div className="wf-collapse" data-open={open} inert={!open} aria-hidden={!open}>
        <div>{children}</div>
      </div>
    </section>
  );
}

export function WorkflowExecutionHistory({
  inspection,
  error,
}: {
  inspection?: WorkflowNodeInspection;
  error?: string;
}) {
  const [open, setOpen] = useState(true);
  if (error)
    return (
      <p className="wf-operator-notice error" role="alert">
        {error}
      </p>
    );
  if (!inspection)
    return (
      <p className="wf-operator-notice" role="status">
        <LoaderCircle className="spin" size={14} />
        正在读取执行记录
      </p>
    );
  if (!inspection.attempts.length)
    return <p className="wf-operator-notice">该节点还没有自动执行记录</p>;
  const latest = inspection.attempts[0]!;
  return (
    <WorkflowCollapse
      label="执行记录"
      icon={<History size={15} />}
      open={open}
      onToggle={() => setOpen(!open)}
    >
      <div className="wf-execution-current" role="status">
        <strong>{attemptStatus(latest.status)}</strong>
        <span>第 {latest.number} 次执行</span>
        {latest.child ? (
          <>
            <p>
              POD 子任务 · {podStatus(latest.child.status)} · {latest.child.progressPercent}%
            </p>
            {latest.child.needsReconciliation ? (
              <p>原请求的结果或费用尚未确定 请核对原任务后处理</p>
            ) : null}
            <Link
              href={workflowHref(
                `/pod-workbench?module=${latest.child.module}&task=${latest.child.id}#pod-task-${latest.child.id}`,
                `/workflows/runs/${inspection.runId}?node=${encodeURIComponent(inspection.nodeId)}`,
              )}
            >
              核对原 POD 任务
            </Link>
          </>
        ) : null}
        {latest.message ? <p>{latest.message}</p> : null}
        {!latest.inputAvailable ? <p>本次缺少原操作者或固定输入 需要人工核对</p> : null}
      </div>
      <ol className="wf-attempt-history">
        {inspection.attempts.map((attempt) => (
          <li key={attempt.id}>
            <header>
              <strong>
                第 {attempt.number} 次 · {attemptStatus(attempt.status)}
              </strong>
              <time dateTime={attempt.queuedAt}>{time(attempt.queuedAt)}</time>
            </header>
            <p>
              {attempt.actor}
              {attempt.recoveryCount ? ` · 已恢复 ${attempt.recoveryCount} 次` : ""}
            </p>
            {attempt.message && attempt.id !== latest.id ? <p>{attempt.message}</p> : null}
            <small>
              {attempt.inputAvailable ? "已固定输入" : "原始输入缺失"}
              {attempt.finishedAt
                ? ` · 结束 ${time(attempt.finishedAt)}`
                : attempt.startedAt
                  ? ` · 开始 ${time(attempt.startedAt)}`
                  : " · 等待派发"}
            </small>
            <MethodEvidence selection={attempt.methodSelection} />
            <InvocationEvidence entries={attempt.invocations}/>
          </li>
        ))}
      </ol>
      {inspection.hasMoreAttempts ? (
        <p className="wf-operator-notice">显示最近 30 次执行 历史记录仍保留</p>
      ) : null}
    </WorkflowCollapse>
  );
}

export function WorkflowRepairPanel({
  runId,
  nodeId,
  revision,
  disabled,
  onBusyChange,
  onResult,
}: {
  runId: string;
  nodeId: string;
  revision: number;
  disabled: boolean;
  onBusyChange(busy: boolean): void;
  onResult(result: WorkflowActionState<{ revision: number }>): void;
}) {
  const [open, setOpen] = useState(false),
    [options, setOptions] = useState<WorkflowRepairOptions>(),
    [error, setError] = useState<string>(),
    [busy, setBusy] = useState(false);
  const [inputRevision, setInputRevision] = useState(revision),
    [query, setQuery] = useState("");
  const [selectedSource, setSelectedSource] = useState<{
    snapshotId: string;
    title: string;
    capturedAt: string;
  }>();
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const stale = inputRevision !== revision;
  const load = async () => {
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    setBusy(true);
    setError(undefined);
    try {
      const value = await readWorkflow(
        `${runId}/nodes/${encodeURIComponent(nodeId)}/repair-options?q=${encodeURIComponent(query)}`,
        WorkflowRepairOptionsSchema,
        request.signal,
      );
      if (request.signal.aborted) return;
      if ((!options || stale) && value.kind === "profile")
        setSelectedSource(
          value.sources.find((source) => source.snapshotId === value.researchSnapshotId),
        );
      setOptions(value);
      setInputRevision(revision);
    } catch (error) {
      if (!request.signal.aborted)
        setError(error instanceof Error ? error.message : "输入选项暂不可用");
    } finally {
      if (!request.signal.aborted) setBusy(false);
    }
  };
  const toggle = () => {
    if (!open && !options) void load();
    setOpen(!open);
  };
  return (
    <WorkflowCollapse
      label="重新配置输入"
      icon={<SlidersHorizontal size={15} />}
      open={open}
      onToggle={toggle}
    >
      {error ? (
        <p className="wf-operator-notice error" role="alert">
          {error}
        </p>
      ) : null}
      {busy && !options ? (
        <p className="wf-operator-notice" role="status">
          <LoaderCircle className="spin" size={14} />
          正在读取可用输入
        </p>
      ) : null}
      {options?.kind === "profile" ? (
        <div className="wf-source-search">
          <label>
            查找研究资料
            <input
              value={query}
              maxLength={100}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <button disabled={busy || disabled} onClick={() => void load()} type="button">
            查找
          </button>
        </div>
      ) : null}
      {stale ? (
        <p className="wf-operator-notice error" role="alert">
          流程已更新 请载入最新输入后提交
        </p>
      ) : null}
      {stale || error ? (
        <button
          className="wf-quiet-button"
          disabled={busy || disabled}
          onClick={() => void load()}
          type="button"
        >
          <RotateCcw size={14} />
          载入最新输入
        </button>
      ) : null}
      {options ? (
        <form
          key={`${options.kind}:${inputRevision}`}
          onSubmit={async (event) => {
            event.preventDefault();
            if (busy || disabled || stale) return;
            setBusy(true);
            onBusyChange(true);
            const form = new FormData(event.currentTarget);
            try {
              const result = await repairWorkflowNode(runId, nodeId, inputRevision, form);
              if (result.status === "error") setError(result.message);
              onResult(result);
            } catch {
              setError("输入保存未完成 请刷新执行记录后核对");
            } finally {
              setBusy(false);
              onBusyChange(false);
            }
          }}
        >
          <fieldset className="wf-repair-fields" disabled={!open || busy || disabled || stale}>
            {options.kind === "profile" ? (
              <>
                <label>
                  研究快照
                  <select
                    name="researchSnapshotId"
                    required
                    value={selectedSource?.snapshotId ?? ""}
                    onChange={(event) =>
                      setSelectedSource(
                        options.sources.find(
                          (source) => source.snapshotId === event.target.value,
                        ) ??
                          (selectedSource?.snapshotId === event.target.value
                            ? selectedSource
                            : undefined),
                      )
                    }
                  >
                    <option value="">请选择资料</option>
                    {selectedSource &&
                    !options.sources.some(
                      (source) => source.snapshotId === selectedSource.snapshotId,
                    ) ? (
                      <option value={selectedSource.snapshotId}>
                        {selectedSource.title.slice(0, 100)} · 已选资料
                      </option>
                    ) : null}
                    {options.sources.map((source) => (
                      <option key={source.snapshotId} value={source.snapshotId}>
                        {source.title.slice(0, 100)} · {time(source.capturedAt)}
                      </option>
                    ))}
                  </select>
                </label>
                {options.hasMoreSources ? (
                  <p>显示最近 50 份快照 可按标题查找</p>
                ) : !options.sources.length ? (
                  <p>没有可用资料 请先在研究模块保存快照</p>
                ) : null}
                <label>
                  目标站点
                  <input
                    name="targetMarketplace"
                    required
                    maxLength={120}
                    defaultValue={options.targetMarketplace}
                    placeholder="amazon.com"
                  />
                </label>
              </>
            ) : options.kind === "package" ? (
              <label>
                导出方式
                <select name="mode" defaultValue={options.mode}>
                  <option value="draft">草稿包 包含待核对项</option>
                  <option value="release">正式包 必须通过完整性检查</option>
                </select>
              </label>
            ) : (
              <>
                {!options.options.enabled ? (
                  <p className="wf-operator-notice error">该工具当前未启用 请先核对处理服务配置</p>
                ) : null}
                {!options.options.skus.length ? (
                  <p>本商品还没有可用 SKU 请先到商品模块补齐</p>
                ) : options.skuId &&
                  !options.options.skus.some((sku) => sku.id === options.skuId) ? (
                  <p>原 SKU 当前不可用 请明确选择新的 SKU</p>
                ) : null}
                <label>
                  关联 SKU
                  <select
                    name="skuId"
                    required
                    defaultValue={
                      options.options.skus.some((sku) => sku.id === options.skuId)
                        ? options.skuId!
                        : ""
                    }
                  >
                    <option value="">请选择本商品的 SKU</option>
                    {options.options.skus.map((sku) => (
                      <option key={sku.id} value={sku.id}>
                        {sku.code} · {sku.productName}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  任务标题
                  <input name="title" maxLength={160} required defaultValue={options.title} />
                </label>
                <fieldset className="wf-asset-picker">
                  <legend>
                    输入素材{options.options.requiresAssetInput ? "（必选）" : "（可选）"}
                  </legend>
                  {options.options.assets.map((asset) => (
                    <label key={asset.id}>
                      <input
                        type="checkbox"
                        name="inputAssetIds"
                        value={asset.id}
                        defaultChecked={options.inputAssetIds.includes(asset.id)}
                      />
                      <span>
                        {asset.fileName}
                        <small>
                          v{asset.version} ·{" "}
                          {asset.domain === "authorized" ? "授权素材" : "研究参考"}
                        </small>
                      </span>
                    </label>
                  ))}
                </fieldset>
                {options.options.requiresAssetInput && !options.options.assets.length ? (
                  <p>没有可供此工具使用的素材 请先补充符合授权要求的输入</p>
                ) : null}
                <PodToolParameters
                  toolKey={options.toolKey}
                  initialValues={options.parameterSnapshot}
                />
                <p>原执行记录会保留 新输入可能触发新的 POD 处理调用</p>
              </>
            )}
            <button
              className="wf-primary-button"
              disabled={
                options.kind === "pod" &&
                (!options.options.enabled ||
                  !options.options.skus.length ||
                  (options.options.requiresAssetInput && !options.options.assets.length))
              }
              type="submit"
            >
              {busy ? <LoaderCircle className="spin" size={14} /> : <RotateCcw size={14} />}
              {busy ? "正在保存" : "按新输入重新排队"}
            </button>
          </fieldset>
        </form>
      ) : null}
    </WorkflowCollapse>
  );
}

export function WorkflowArtifacts({ run, nodeId }: { run: WorkflowRunDetail; nodeId: string }) {
  const artifacts = run.artifacts.filter((artifact) => artifact.nodeId === nodeId),
    [selected, setSelected] = useState<string>(),
    [value, setValue] = useState<WorkflowArtifactInspection>(),
    [error, setError] = useState<string>(),
    [busy, setBusy] = useState(false);
  const load = async (id: string) => {
    setSelected(id);
    setValue(undefined);
    setError(undefined);
    setBusy(true);
    try {
      setValue(await readWorkflow(`${run.id}/artifacts/${id}`, WorkflowArtifactInspectionSchema));
    } catch (error) {
      setError(error instanceof Error ? error.message : "产物暂不可用");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="wf-operator-section" aria-label="本节点产物">
      <h3>已生成的产物</h3>
      {!artifacts.length ? (
        <p className="wf-operator-notice">尚未生成产物</p>
      ) : (
        <ul className="wf-artifacts">
          {artifacts.map((artifact) => (
            <li key={artifact.id}>
              <div>
                <strong>{artifact.label}</strong>
                <small>
                  {artifact.validationStatus === "pending"
                    ? "待核验"
                    : artifact.validationStatus === "valid"
                      ? "已核验"
                      : "核验未通过"}{" "}
                  · {time(artifact.createdAt)}
                </small>
              </div>
              {["product_facts", "product_package", "design_version"].includes(
                artifact.artifactType,
              ) ? (
                <button
                  className="wf-quiet-button"
                  disabled={busy}
                  onClick={() =>
                    selected === artifact.id ? setSelected(undefined) : void load(artifact.id)
                  }
                  type="button"
                  aria-expanded={selected === artifact.id}
                >
                  <FileSearch size={14} />
                  核对产物
                </button>
              ) : (
                <span>请到原业务模块核对</span>
              )}
            </li>
          ))}
        </ul>
      )}
      <div
        className="wf-collapse"
        data-open={Boolean(selected)}
        inert={!selected}
        aria-hidden={!selected}
      >
        <div>
          {busy ? (
            <p role="status">正在读取产物回执</p>
          ) : error ? (
            <p className="wf-operator-notice error" role="alert">
              {error}
            </p>
          ) : value ? (
            <div className="wf-artifact-detail">
              {value.kind === "profile" ? (
                <>
                  <h4>本次生成的商品事实</h4>
                  <dl>
                    {[
                      ["SKU", value.profile.sku?.value],
                      ["商品类型", value.profile.productType?.value],
                      ["材质", value.profile.materials.map((fact) => fact.value).join("、")],
                      ["规格", value.profile.sizeOptions.map((fact) => fact.value).join("、")],
                    ].map(([label, detail]) => (
                      <div key={label}>
                        <dt>{label}</dt>
                        <dd>{detail || "待核实"}</dd>
                      </div>
                    ))}
                  </dl>
                  <p>来源参考仍需核实 后续商品修改不会覆盖这份回执</p>
                  <Link
                    href={workflowHref(
                      `/products?plan=${run.productPlanId}`,
                      `/workflows/runs/${run.id}?node=${encodeURIComponent(nodeId)}`,
                    )}
                  >
                    到商品模块核对
                  </Link>
                </>
              ) : value.kind === "package" ? (
                <>
                  <h4>{value.fileName}</h4>
                  <p>
                    {value.mode === "draft" ? "草稿包" : "正式包"} ·{" "}
                    {value.completeness.status === "ready" ? "完整性检查通过" : "包含待核对项"}
                  </p>
                  {value.completeness.issues.length ? (
                    <ul aria-label="产品包待核对项">
                      {value.completeness.issues.map((issue, index) => (
                        <li key={`${issue.code}:${index}`}>
                          {customProductIssueLabel(issue, value.completeness.unverifiedFactCount)}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  <code title={value.checksum}>SHA-256 {value.checksum}</code>
                  {value.canDownload ? (
                    <a
                      className="wf-primary-button"
                      href={`/api/workflow-runs/${run.id}/artifacts/${selected}/file`}
                      download
                    >
                      <FileDown size={14} />
                      下载产品包
                    </a>
                  ) : (
                    <p>当前成员没有下载素材的权限</p>
                  )}
                  <p>导出文件不代表人工批准或生产放行</p>
                </>
              ) : (
                <>
                  <h4>POD 设计产物</h4>
                  <p>
                    {podStatus(value.status)} · {value.progressPercent}%
                  </p>
                  <Link
                    href={workflowHref(
                      `/pod-workbench?module=${value.module}&task=${value.taskId}#pod-task-${value.taskId}`,
                      `/workflows/runs/${run.id}?node=${encodeURIComponent(nodeId)}`,
                    )}
                  >
                    打开原 POD 任务
                  </Link>
                  <p>
                    <Link
                      href={workflowHref(
                        `/design?task=${value.designTaskId}`,
                        `/workflows/runs/${run.id}?node=${encodeURIComponent(nodeId)}`,
                      )}
                    >
                      查看设计版本与审核
                    </Link>
                  </p>
                  <p>设计审核与生产放行按原业务流程处理</p>
                </>
              )}
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
function time(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Shanghai",
    hour12: false,
  }).format(new Date(value));
}
function attemptStatus(status: string) {
  return (
    (
      {
        queued: "已保存 等待派发",
        running: "正在执行",
        waiting: "等待 POD 结果",
        failed: "执行未完成",
        completed: "技术执行完成",
        cancelled: "已取消",
      } as Record<string, string>
    )[status] ?? "状态待核对"
  );
}
function podStatus(status: string) {
  return (
    (
      {
        queued: "排队中",
        running: "处理中",
        awaiting_review: "待审核",
        approved: "已审核",
        partially_succeeded: "部分完成",
        failed: "失败",
        blocked: "已阻断",
        rejected: "已驳回",
      } as Record<string, string>
    )[status] ?? "状态待核对"
  );
}
