"use client";
import { Suspense, useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Plus, RefreshCw, Search } from "lucide-react";
import { Permission } from "@yummyai/authz/permissions";
import { useErpAccess } from "../identity/erp-access";
import {
  SalesPlanFieldsSchema,
  SalesPlanDraftSchema,
  type SalesPlanDetail,
  type SalesPlanFields,
  type SalesPlanOptions,
  type SalesPlanView,
} from "@yummyai/contracts/catalog/sales-plan";
import { workflowHref } from "../navigation/workflow-href";
import { WorkflowReturnLink } from "../navigation/use-workflow-return";
import { useLeaveGuard } from "../navigation/use-leave-guard";
import { useTaskDraft, clearTaskDrafts } from "../navigation/task-draft";
import { salesPlanReadDenied, salesPlanRequest } from "./sales-plan-client";
import { useSalesPlanWorkspace } from "./use-sales-plan-workspace";
import { useSalesPlanReferences } from "./use-sales-plan-references";
import { salesPlanReferenceIssues, removeSalesPlanReference } from "./sales-plan-references";
import { SalesPlanReferenceNotice } from "./sales-plan-reference-notice";
import {
  SalesPlanProductStep,
  SalesPlanResearchStep,
  SalesPlanContentStep,
  SalesPlanDesignStep,
  SalesPlanCompositionStep,
  SalesPlanListingStep,
} from "./sales-plan-steps";
import { salesPlanProgress, salesPlanSteps } from "./sales-plan-progress";
import { SalesPlanLaunch } from "./sales-plan-launch";
import "../order-centers/order-centers.css";
import "../product-development/development.css";
import "../product-development/artwork-workflow.css";
import "./sales-plans.css";

export function SalesPlanWorkspace() {
  return (
    <Suspense
      fallback={
        <main className="oc-page" aria-busy="true">
          <p role="status">正在读取上架工作台…</p>
        </main>
      }
    >
      <Workspace />
    </Suspense>
  );
}
function Workspace() {
  const params = useSearchParams(),
    selected = params.get("plan"),
    creating = params.get("new") === "1";
  const { can } = useErpAccess();
  const [scopeNotice, setScopeNotice] = useState("");
  const query = new URLSearchParams();
  for (const key of ["q", "spuId", "page", "archived"]) {
    const value = params.get(key);
    if (value) query.set(key, value);
  }
  const filterQuery = query.toString();
  const { options, list, detail, loading, error, usable, retry } = useSalesPlanWorkspace(
    selected,
    filterQuery,
  );
  const editable = !!(
    detail &&
    !detail.plan.archived &&
    options?.access.write &&
    can(Permission.ProductWrite, { ownerId: detail.plan.ownerUserId, teamId: detail.plan.teamId })
  );
  const editorIdentity =
    detail && options ? salesPlanDraftPrefix(options, detail.plan, editable) : null;
  const priorEditor = useRef<{ id: string; prefix: string } | null>(null);
  useEffect(() => {
    const prior = priorEditor.current;
    if (prior && prior.id === selected && prior.prefix !== editorIdentity) {
      clearTaskDrafts(prior.prefix);
      if (editorIdentity) setScopeNotice("方案状态、归属或编辑范围已变化 原草稿已清除");
    } else if (prior?.id !== selected) setScopeNotice("");
    priorEditor.current =
      detail && editorIdentity ? { id: detail.plan.id, prefix: editorIdentity } : null;
  }, [editorIdentity, selected, detail]);
  const routeKey = `${selected ?? "list"}:${creating}:${filterQuery}`;
  const routeRef = useRef(routeKey);
  routeRef.current = routeKey;
  function navigate(values: Record<string, string | null>) {
    const next = new URLSearchParams(params.toString());
    for (const [key, value] of Object.entries(values)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    history.pushState(null, "", `/sales-plans${next.size ? `?${next}` : ""}`);
  }
  const current = `/sales-plans${params.size ? `?${params}` : ""}`;
  return (
    <main className="oc-page sp-page" aria-busy={loading}>
      <WorkflowReturnLink className="oc-button" label="返回来源" />
      <header className="oc-header">
        <div>
          <h1>上架工作台</h1>
          <p>从载体与工艺出发，准备印花组合、套图与文案，再完成刊登审核。</p>
        </div>
        <div className="oc-actions">
          <Link className="oc-button" href={workflowHref("/product-specifications", current)}>
            商品库
          </Link>
          {!selected && (
            <button className="oc-button" disabled={loading} onClick={retry}>
              <RefreshCw size={15} />
              刷新
            </button>
          )}
          {!selected && !creating && (
            <button
              className="oc-button primary"
              disabled={!usable || !options?.access.write || loading}
              onClick={() => navigate({ new: "1" })}
            >
              <Plus size={15} />
              新建销售方案
            </button>
          )}
        </div>
      </header>
      {error && (
        <div className="oc-error" role="alert">
          <span>{error}</span>
          <button className="oc-button" onClick={retry}>
            重试
          </button>
        </div>
      )}
      {scopeNotice && (
        <p className="oc-notice" role="status">
          {scopeNotice}
        </p>
      )}
      {loading && (
        <div className="sp-loading" role="status">
          正在读取商品与销售方案…
        </div>
      )}
      {options && (
        <div hidden={!usable} inert={!usable || loading}>
          {selected ? (
            detail && (
              <SalesPlanEditor
                key={editorIdentity}
                initial={detail}
                options={options}
                current={current}
                taskView={params.get("view") === "tasks"}
                onTaskView={(show) => navigate({ view: show ? "tasks" : null })}
                step={Math.max(0, Math.min(4, Number(params.get("step")) || 0))}
                onStep={(step) => {
                  const next = new URLSearchParams(params.toString());
                  next.set("step", String(step));
                  history.replaceState(null, "", `/sales-plans?${next}`);
                }}
                onClose={() => navigate({ plan: null, step: null, new: null })}
                onCommitted={retry}
                draftPrefix={editorIdentity!}
              />
            )
          ) : creating ? (
            <CreatePlan
              key={`${options.contextAuthority}:new:${params.get("spuId") ?? ""}`}
              options={options}
              initialSpuId={params.get("spuId") ?? ""}
              onCreated={(plan) => {
                if (routeRef.current === routeKey)
                  navigate({ plan: plan.id, step: "1", new: null });
              }}
              onCancel={() => navigate({ new: null })}
            />
          ) : (
            list && (
              <>
                <form className="sp-filters" method="get">
                  <label>
                    搜索方案
                    <div className="sp-search">
                      <Search size={15} />
                      <input
                        name="q"
                        defaultValue={params.get("q") ?? ""}
                        placeholder="方案名称、SPU 编号或名称"
                      />
                    </div>
                  </label>
                  <label>
                    商品 SPU
                    <select name="spuId" defaultValue={params.get("spuId") ?? ""}>
                      <option value="">全部商品</option>
                      {options.spus.map((spu) => (
                        <option key={spu.id} value={spu.id}>
                          {spu.name} · {spu.code}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    记录范围
                    <select name="archived" defaultValue={params.get("archived") ?? "0"}>
                      <option value="0">进行中的方案</option>
                      <option value="1">已归档历史</option>
                    </select>
                  </label>
                  <button className="oc-button">筛选</button>
                </form>
                <p className="sp-caption">
                  共 {list.total} 个销售方案 · 每个方案独立管理定位、图文和刊登
                </p>
                <div className="sp-list">
                  {list.items.map((plan) => (
                    <article key={plan.id}>
                      <div>
                        <Link
                          className="sp-plan-title"
                          href={`/sales-plans?${new URLSearchParams({ ...Object.fromEntries(params), plan: plan.id, step: "1" })}`}
                        >
                          {plan.fields.name}
                        </Link>
                        <p>
                          {plan.spuName} · {plan.spuCode}
                        </p>
                      </div>
                      <span>
                        {plan.fields.mode === "custom" ? "定制" : "标品"} /{" "}
                        {plan.fields.fulfillment.toUpperCase()}
                      </span>
                      <span>
                        第 {plan.revision} 版{plan.archived ? " · 已归档" : ""}
                      </span>
                      <Link
                        className="oc-button"
                        href={`/sales-plans?${new URLSearchParams({ ...Object.fromEntries(params), plan: plan.id, step: "1" })}`}
                      >
                        继续处理
                      </Link>
                    </article>
                  ))}
                </div>
                {!list.items.length && (
                  <div className="sp-empty">
                    <h2>{params.get("archived") === "1" ? "暂无归档方案" : "暂无销售方案"}</h2>
                    <p>先创建商品 SPU，再为它建立定制或标品方案。同一 SPU 可以开展多个销售方向。</p>
                  </div>
                )}
                <div className="sp-pagination">
                  <button
                    className="oc-button"
                    disabled={list.page <= 1}
                    onClick={() => navigate({ page: String(list.page - 1) })}
                  >
                    上一页
                  </button>
                  <span>第 {list.page} 页</span>
                  <button
                    className="oc-button"
                    disabled={list.page * list.pageSize >= list.total}
                    onClick={() => navigate({ page: String(list.page + 1) })}
                  >
                    下一页
                  </button>
                </div>
              </>
            )
          )}
        </div>
      )}
    </main>
  );
}
function salesPlanDraftPrefix(options: SalesPlanOptions, plan: SalesPlanView, editable: boolean) {
  return `${options.preferenceScope}:sales-plan:${plan.id}:${options.contextAuthority}:${plan.spuId}:${plan.ownerUserId ?? "unknown"}:${plan.teamId ?? "none"}:${editable ? "write" : "read"}`;
}
function CreatePlan({
  options,
  initialSpuId,
  onCreated,
  onCancel,
}: {
  options: SalesPlanOptions;
  initialSpuId: string;
  onCreated: (plan: SalesPlanView) => void;
  onCancel: () => void;
}) {
  const { can } = useErpAccess();
  const writableSpus = options.spus.filter((spu) =>
    can(Permission.ProductWrite, { ownerId: spu.ownerUserId, teamId: spu.teamId }),
  );
  const [spuId, setSpuId] = useState(initialSpuId);
  const selectedSpu = writableSpus.some((spu) => spu.id === spuId);
  const mounted = useRef(true),
    pending = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [mode, setMode] = useState<"custom" | "standard">("custom"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [dirty, setDirty] = useState(false);
  const keys = useRef(new Map<string, string>());
  const leave = useLeaveGuard(dirty, busy);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending.current || !selectedSpu || !options.access.write) return;
    pending.current = true;
    const data = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    try {
      const payload = {
        spuId: String(data.get("spuId")),
        fields: SalesPlanFieldsSchema.parse({
          name: String(data.get("name")),
          mode,
          fulfillment: String(data.get("fulfillment")),
        }),
      };
      const fingerprint = JSON.stringify(payload),
        key = keys.current.get(fingerprint) ?? crypto.randomUUID();
      keys.current.set(fingerprint, key);
      const result = await salesPlanRequest<{ plan: SalesPlanView }>("", {
        ...payload,
        idempotencyKey: key,
      });
      if (!mounted.current) return;
      setDirty(false);
      keys.current.delete(fingerprint);
      onCreated(result.plan);
    } catch (error) {
      if (mounted.current) setError(error instanceof Error ? error.message : "创建方案失败");
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <form aria-label="新建销售方案" onChange={() => setDirty(true)} onSubmit={submit}>
      <h2>基于商品创建销售方案</h2>
      <p>确定商品模式和销售方向，其他资料可以逐步补齐。</p>
      {error && (
        <p className="oc-error" role="alert">
          {error}
        </p>
      )}
      <fieldset className="pd-form" disabled={busy || !options.access.write}>
        <label>
          商品 SPU
          <select
            aria-label="商品 SPU"
            name="spuId"
            required
            value={spuId}
            onChange={(event) => setSpuId(event.target.value)}
          >
            <option value="">请选择商品</option>
            {spuId && !selectedSpu && (
              <option value={spuId} disabled>
                当前商品不可用于创建方案 请重新选择
              </option>
            )}
            {writableSpus.map((spu) => (
              <option key={spu.id} value={spu.id}>
                {spu.name} · {spu.code}
              </option>
            ))}
          </select>
        </label>
        <label>
          方案名称
          <input
            name="name"
            required
            maxLength={160}
            placeholder="例如 宠物纪念来图款 / 固定猫咪印花款"
          />
        </label>
        <label>
          商品模式
          <select
            aria-label="商品模式"
            value={mode}
            onChange={(e) => setMode(e.target.value as typeof mode)}
          >
            <option value="custom">定制</option>
            <option value="standard">标品</option>
          </select>
        </label>
        <label>
          履约方式
          <select aria-label="履约方式" key={mode} name="fulfillment" defaultValue="fbm">
            <option value="fbm">FBM 自配送</option>
            {mode === "standard" && <option value="fba">FBA 亚马逊配送</option>}
          </select>
          <small>
            {mode === "custom" ? "Amazon Custom 使用 FBM 自配送。" : "标品可以选择 FBA 或 FBM。"}
          </small>
        </label>
      </fieldset>
      <div className="sp-footer">
        <button
          className="oc-button"
          type="button"
          disabled={busy}
          onClick={() => {
            if (leave()) onCancel();
          }}
        >
          取消
        </button>
        <button
          className="oc-button primary"
          disabled={busy || !options.access.write || !selectedSpu}
        >
          {busy ? "创建中…" : "创建方案并准备印花"}
        </button>
      </div>
      {!writableSpus.length && (
        <p role="status">暂无可用于创建方案的商品 请核对商品写入范围或先创建 SPU</p>
      )}
    </form>
  );
}
function SalesPlanEditor({
  initial,
  options: baseOptions,
  current,
  step,
  onStep,
  onClose,
  taskView,
  onTaskView,
  onCommitted,
  draftPrefix,
}: {
  initial: SalesPlanDetail;
  options: SalesPlanOptions;
  current: string;
  step: number;
  onStep: (step: number) => void;
  onClose: () => void;
  taskView: boolean;
  onTaskView: (show: boolean) => void;
  onCommitted: () => void;
  draftPrefix: string;
}) {
  const { can } = useErpAccess();
  const [record, setRecord] = useTaskDraft(draftPrefix, "basis", initial.plan);
  const linked = initial.listings;
  const prefix = `${draftPrefix}:${record.revision}`;
  const [fields, setFields] = useTaskDraft(prefix, "fields", record.fields),
    [keywords, setKeywords] = useTaskDraft(prefix, "keywords", record.fields.keywords.join("\n"));
  const references = useSalesPlanReferences(
    record.id,
    record.spuId,
    fields,
    baseOptions,
    onCommitted,
  );
  let options = {
    ...references.options,
    access: {
      ...references.options.access,
      write:
        references.options.access.write &&
        can(Permission.ProductWrite, {
          ownerId: initial.plan.ownerUserId,
          teamId: initial.plan.teamId,
        }),
    },
  };
  const referenceIssues = references.ready
    ? salesPlanReferenceIssues(fields, options, record.spuId)
    : [];
  const referenceReason = !references.ready
    ? "请先完成关联资料核对"
    : referenceIssues.length
      ? "请先处理不可用的关联资料"
      : "";
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [requestKeys, setRequestKeys] = useTaskDraft<Record<string, string>>(
    draftPrefix,
    "requests",
    {},
  );
  const keys = useRef(requestKeys);
  keys.current = requestKeys;
  const mounted = useRef(true),
    pending = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const dirty =
    JSON.stringify(fields) !== JSON.stringify(record.fields) ||
    keywords !== record.fields.keywords.join("\n");
  const leave = useLeaveGuard(dirty, busy);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const target = linked.find(
    (listing) => listing.marketplaceId === fields.marketplaceId && listing.locale === fields.locale,
  );
  options = {
    ...options,
    access: {
      ...options.access,
      listingWrite:
        options.access.listingWrite &&
        (!target || can(Permission.ListingWrite, { ownerId: target.ownerUserId })),
    },
  };
  const disabled = busy || record.archived || !options.access.write;
  const progress = salesPlanProgress(fields, options.specifications, linked);
  function change<K extends keyof SalesPlanFields>(key: K, value: SalesPlanFields[K]) {
    setFields((f) => ({ ...f, [key]: value }));
    setNotice("");
  }
  function adoptCurrent(refreshed: SalesPlanDetail) {
    if (!mounted.current || refreshed.plan.id !== record.id) return;
    clearTaskDrafts(draftPrefix);
    setRecord(refreshed.plan);
    setFields(refreshed.plan.fields);
    setKeywords(refreshed.plan.fields.keywords.join("\n"));
  }
  async function reloadCurrent() {
    if (pending.current || !leave()) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      const refreshed = await salesPlanRequest<SalesPlanDetail>(record.id);
      if (!mounted.current) return;
      adoptCurrent(refreshed);
      onCommitted();
    } catch (error) {
      if (mounted.current)
        setError(error instanceof Error ? error.message : "当前版本未能核对 草稿已保留");
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function mutate(action: "save" | "draft" | "archive") {
    if (action === "draft" && dirty) return;
    if (action !== "archive" && referenceReason) return;
    if (
      pending.current ||
      record.archived ||
      (action === "draft" ? !options.access.listingWrite : !options.access.write)
    )
      return;
    pending.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const normalized = SalesPlanFieldsSchema.parse({
        ...fields,
        keywords: keywords
          .split("\n")
          .map((word) => word.trim())
          .filter(Boolean),
        bullets: fields.bullets.filter((bullet) => bullet.trim()),
      });
      const currentListing = linked.find(
        (listing) =>
          listing.marketplaceId === normalized.marketplaceId &&
          listing.locale === normalized.locale,
      );
      const path = action === "save" ? record.id : `${record.id}/${action}`;
      let payload = {
        expectedRevision: record.revision,
        ...(action === "save"
          ? { fields: normalized }
          : action === "draft"
            ? { expectedListingVersionId: currentListing?.versionId ?? null }
            : {}),
      };
      let signature = JSON.stringify({ path, payload });
      if (action === "draft") {
        for (const [previous, key] of Object.entries(keys.current)) {
          const candidate = JSON.parse(previous);
          const parsed = SalesPlanDraftSchema.safeParse({
            ...candidate.payload,
            idempotencyKey: key,
          });
          if (
            candidate.path === path &&
            parsed.success &&
            parsed.data.expectedRevision === record.revision
          ) {
            payload = {
              expectedRevision: parsed.data.expectedRevision,
              expectedListingVersionId: parsed.data.expectedListingVersionId,
            };
            signature = previous;
            break;
          }
        }
      }
      const key = keys.current[signature] ?? crypto.randomUUID();
      keys.current = { ...keys.current, [signature]: key };
      setRequestKeys(keys.current);
      const result = await salesPlanRequest<{
        plan?: SalesPlanView;
        listingId?: string;
        listingVersionId?: string;
      }>(path, { ...payload, idempotencyKey: key });
      if (!mounted.current) return;
      if (action !== "draft" && (!result.plan || result.plan.id !== record.id))
        throw Error("保存结果尚未确认 请重新核对方案 原草稿已保留");
      if (action === "draft" && (!result.listingId || !result.listingVersionId))
        throw Error("同步回执尚未确认 请重新核对刊登");
      const remaining = { ...keys.current };
      delete remaining[signature];
      keys.current = remaining;
      setRequestKeys(remaining);
      if (result.plan)
        adoptCurrent({ plan: result.plan, listings: linked, listingAccess: initial.listingAccess });
      onCommitted();
      setNotice(
        action === "save"
          ? "销售方案已保存"
          : action === "draft"
            ? "本地刊登草稿已保存，请进入刊登审核与平台校验"
            : "销售方案已归档，历史资料继续保留",
      );
    } catch (error) {
      if (mounted.current) {
        setError(error instanceof Error ? error.message : "操作未完成");
        if (salesPlanReadDenied(error)) onCommitted();
      }
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  const props = { fields, options, spuId: record.spuId, change, disabled, current };
  return (
    <section className="sp-editor" aria-label="销售方案详情">
      <div className="sp-subject">
        <button
          className="oc-button"
          disabled={busy}
          onClick={() => {
            if (leave()) {
              clearTaskDrafts(draftPrefix);
              onClose();
            }
          }}
        >
          返回方案列表
        </button>
        {dirty && (
          <button type="button" className="oc-button" disabled={busy} onClick={onClose}>
            保留草稿返回列表
          </button>
        )}
        <span>
          {record.spuName} · {record.spuCode}
        </span>
        <span>
          {fields.mode === "custom" ? "定制" : "标品"} / {fields.fulfillment.toUpperCase()}
        </span>
      </div>
      {initial.plan.revision > record.revision && (
        <p className="oc-notice" role="status">
          当前方案已有第 {initial.plan.revision} 版 原草稿仍基于第 {record.revision} 版
          保存时会检查冲突
        </p>
      )}
      {!options.access.write && (
        <p className="sp-hint">当前方案内容仅可查看 写入需要当前商品的编辑权限</p>
      )}
      <button
        type="button"
        className="oc-button"
        disabled={busy}
        onClick={() => void reloadCurrent()}
      >
        重新载入当前方案
      </button>
      <div className="sp-plan-meta">
        <label>
          方案名称
          <input
            value={fields.name}
            disabled={disabled}
            maxLength={160}
            onChange={(e) => change("name", e.target.value)}
          />
        </label>
        <label>
          商品模式
          <select
            aria-label="商品模式"
            value={fields.mode}
            disabled={disabled || linked.length > 0}
            onChange={(e) => {
              change("mode", e.target.value as typeof fields.mode);
              if (e.target.value === "custom") change("fulfillment", "fbm");
            }}
          >
            <option value="custom">定制</option>
            <option value="standard">标品</option>
          </select>
          {linked.length > 0 && <small>更换销售方式可基于同一 SPU 新建方案。</small>}
        </label>
        <label>
          履约方式
          <select
            aria-label="履约方式"
            value={fields.fulfillment}
            disabled={disabled || linked.length > 0}
            onChange={(e) => change("fulfillment", e.target.value as typeof fields.fulfillment)}
          >
            <option value="fbm">FBM 自配送</option>
            {fields.mode === "standard" && <option value="fba">FBA 亚马逊配送</option>}
          </select>
        </label>
      </div>
      <SalesPlanReferenceNotice
        checking={references.checking}
        error={references.error}
        issues={referenceIssues}
        disabled={disabled}
        retry={references.retry}
        remove={(issue) => {
          setFields((current) => removeSalesPlanReference(current, issue));
          setNotice("");
        }}
      />
      <nav className="sp-task-tabs" aria-label="销售方案工作视图">
        <button
          className="oc-button"
          aria-pressed={!taskView}
          disabled={busy}
          onClick={() => onTaskView(false)}
        >
          方案编辑
        </button>
        <button
          className="oc-button"
          aria-pressed={taskView}
          disabled={busy || record.archived}
          onClick={() => onTaskView(true)}
        >
          上新任务
        </button>
      </nav>
      {taskView && !record.archived && (
        <SalesPlanLaunch
          plan={record}
          current={current}
          canWrite={options.access.write}
          disabledReason={
            dirty
              ? "请先保存方案修改，再读取依据或采纳成果。"
              : busy
                ? "正在保存方案，请稍候。"
                : referenceReason
          }
          onAdopted={async () => {
            const refreshed = await salesPlanRequest<SalesPlanDetail>(record.id);
            if (!mounted.current) return;
            if (dirtyRef.current) setNotice("上新成果已保存 当前未保存草稿继续保留 请核对新版本");
            else adoptCurrent(refreshed);
            onCommitted();
          }}
        />
      )}
      {!taskView && (
        <>
          <nav className="sp-steps" aria-label="上架五步流程">
            {salesPlanSteps.map((label, index) => (
              <button
                key={label}
                type="button"
                disabled={busy}
                aria-current={index === step ? "step" : undefined}
                onClick={() => onStep(index)}
              >
                <strong>
                  {index + 1}. {label}
                </strong>
                <small>{progress[index]!.detail}</small>
              </button>
            ))}
          </nav>
          {error && (
            <p className="oc-error" role="alert">
              {error}
            </p>
          )}
          {notice && (
            <p className="oc-notice" role="status">
              {notice}
            </p>
          )}
          {record.archived && <p className="sp-hint">此方案已归档，正在查看历史资料。</p>}
          <div className="sp-step-content">
            <h2>{salesPlanSteps[step]}</h2>
            {step === 0 && <SalesPlanProductStep {...props} />}
            {step === 1 && <SalesPlanDesignStep {...props} />}
            {step === 2 && <SalesPlanCompositionStep {...props} />}
            {step === 3 && <SalesPlanContentStep {...props} />}
            {step === 4 && (
              <SalesPlanListingStep
                {...props}
                listings={linked}
                planRevision={record.revision}
                dirty={dirty}
                draftDisabledReason={
                  busy
                    ? "正在核对当前操作"
                    : record.archived
                      ? "方案已归档"
                      : initial.plan.revision > record.revision
                        ? "方案已有新版本 请重新载入后再同步"
                        : referenceReason || undefined
                }
                listingAccess={initial.listingAccess}
                onDraft={() => void mutate("draft")}
              />
            )}
          </div>
          <details className="sp-archive">
            <summary>研究与定位依据</summary>
            <SalesPlanResearchStep {...props} keywords={keywords} onKeywords={setKeywords} />
          </details>
        </>
      )}
      {(!taskView || dirty) && (
        <div className="sp-footer">
          <span role="status">
            {dirty ? "有未保存的修改" : `方案第 ${record.revision} 版已保存`}
          </span>
          {!taskView && step > 0 && (
            <button className="oc-button" disabled={busy} onClick={() => onStep(step - 1)}>
              上一步
            </button>
          )}
          <button
            className="oc-button primary"
            disabled={disabled || !!referenceReason}
            onClick={() => void mutate("save")}
          >
            {busy ? "正在处理…" : "保存方案"}
          </button>
          {!taskView && step < 4 && (
            <button className="oc-button" disabled={busy} onClick={() => onStep(step + 1)}>
              下一步
            </button>
          )}
        </div>
      )}
      {!record.archived && (
        <details className="sp-archive">
          <summary>归档方案</summary>
          <p>归档后退出日常列表；已有刊登、审核版本和订单记录继续保留。</p>
          <button
            className="oc-button"
            disabled={disabled || dirty}
            onClick={() => void mutate("archive")}
          >
            归档当前方案
          </button>
        </details>
      )}
    </section>
  );
}
