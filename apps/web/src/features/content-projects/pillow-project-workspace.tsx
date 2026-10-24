"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, ArrowUpRight, RefreshCw, Search } from "lucide-react";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import {
  PillowProjectWorkspaceSchema,
  PillowProjectOrderSchema,
  type PillowProjectWorkspace as Workspace,
  type PillowProjectOrder,
  type PillowOrderStage,
} from "@yummyai/contracts/catalog/pillow-project";
import { ORDER_QUEUE_LABELS, OrderQueueStageSchema } from "@yummyai/contracts/order/workbench";
import { RULE_EXECUTION_LABELS } from "@yummyai/contracts/rules";
import { SHAPED_PILLOW_FACTORY_STANDARD } from "@yummyai/contracts/pod/production-editor";
import { designAgentErrorMessage } from "../order-centers/order-design-agent-panel";
import { label } from "../order-centers/order-center-model";
import { workflowHref } from "../navigation/workflow-href";

const stageLabels: Record<PillowOrderStage["status"], string> = {
  not_started: "待开始",
  in_progress: "进行中",
  complete: "已完成",
  blocked: "待处理",
};
const agentLabels: Record<string, string> = {
  queued: "排队中",
  running: "制作中",
  awaiting_review: "待人工审核",
  needs_attention: "需要处理",
  cancelled: "已停止",
  pending: "待执行",
  completed: "已完成",
  failed: "未完成",
  uncertain: "结果待核实",
  skipped: "无需执行",
};
const modeLabels: Record<string, string> = {
  fixed: "固定图案",
  personalized_text: "文字定制",
  customer_image: "客户来图",
  mixed: "图文定制",
};
const recipeLabels: Record<string, string> = {
  ready_for_customization: "来图方案已确认",
  approved: "制作已审核",
  pending_adaptation: "待确认制作方案",
  in_adaptation: "制作适配中",
};
const measurementLabels: Record<string, string> = {
  unconfirmed: "未确认",
  artwork: "图案主体",
  finished: "历史成品口径",
  cut_contour: "裁线口径",
};
const version = (id: string | null) => (id ? id.slice(-8) : "未绑定");
const money = (value: number | null) => (value === null ? "未取得记录" : `$${value.toFixed(4)}`);
async function read(path: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(`/api/content-projects/pillow${path}`, {
    cache: "no-store",
    signal,
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(typeof data.message === "string" ? data.message : "抱枕项目读取失败");
  return data;
}

export function PillowProjectWorkspace() {
  const params = useSearchParams(),
    router = useRouter();
  const q = params.get("q") ?? "",
    page = Math.max(1, Math.min(10000, Number(params.get("page")) || 1));
  const stageResult = OrderQueueStageSchema.safeParse(params.get("stage"));
  const stage = stageResult.success ? stageResult.data : "";
  const lineId = params.get("line"),
    configuration = params.get("section") === "configuration";
  const [search, setSearch] = useState(q),
    [retry, setRetry] = useState(0);
  const [workspace, setWorkspace] = useState<Workspace | null>(null),
    [order, setOrder] = useState<PillowProjectOrder | null>(null);
  const [loading, setLoading] = useState(true),
    [orderLoading, setOrderLoading] = useState(false);
  const [error, setError] = useState(""),
    [orderError, setOrderError] = useState("");
  useEffect(() => setSearch(q), [q]);
  useEffect(() => {
    const abort = new AbortController();
    setLoading(true);
    setError("");
    setWorkspace(null);
    const query = new URLSearchParams({ q, page: String(page), ...(stage ? { stage } : {}) });
    void read(`?${query}`, abort.signal)
      .then((data) => {
        if (!abort.signal.aborted) setWorkspace(PillowProjectWorkspaceSchema.parse(data));
      })
      .catch((cause: unknown) => {
        if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : "读取失败");
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [q, page, stage, retry]);
  useEffect(() => {
    const abort = new AbortController();
    setOrder(null);
    setOrderError("");
    setOrderLoading(false);
    if (!lineId) return () => abort.abort();
    if (!EntityIdSchema.safeParse(lineId).success) {
      setOrderError("订单编号无效，请从列表选择");
      return () => abort.abort();
    }
    setOrderLoading(true);
    void read(`/orders/${lineId}`, abort.signal)
      .then((data) => {
        if (!abort.signal.aborted) setOrder(PillowProjectOrderSchema.parse(data));
      })
      .catch((cause: unknown) => {
        if (!abort.signal.aborted)
          setOrderError(cause instanceof Error ? cause.message : "订单读取失败");
      })
      .finally(() => {
        if (!abort.signal.aborted) setOrderLoading(false);
      });
    return () => abort.abort();
  }, [lineId, retry]);
  useEffect(() => {
    if (!order?.agent.run || !["queued", "running"].includes(order.agent.run.status)) return;
    const timer = setTimeout(() => setRetry((n) => n + 1), 8000);
    return () => clearTimeout(timer);
  }, [order]);
  function href(values: Record<string, string | null>) {
    const next = new URLSearchParams(params);
    next.set("view", "pillow");
    next.delete("project");
    for (const [key, value] of Object.entries(values))
      if (value === null) next.delete(key);
      else next.set(key, value);
    return `/content-projects?${next}`;
  }
  const current = href({}),
    link = (target: string) => workflowHref(target, current);
  function filter(event: FormEvent) {
    event.preventDefault();
    router.replace(href({ q: search.trim() || null, page: null, line: null }));
  }
  const orders = workspace?.orders;
  return (
    <main className="cp-page cp-pillow" aria-busy={loading}>
      <header className="cp-header">
        <div>
          <h1>异形抱枕项目</h1>
          <p>复用商品与工艺配置，按每位顾客的照片制作、审核并安排生产。</p>
        </div>
        <div className="cp-actions">
          <button type="button" onClick={() => setRetry((n) => n + 1)} disabled={loading}>
            <RefreshCw size={15} />
            刷新进度
          </button>
          <Link href={link("/orders")}>
            进入订单中心
            <ArrowUpRight size={14} />
          </Link>
        </div>
      </header>
      <nav className="cp-pillow-tabs" aria-label="抱枕项目板块">
        <Link href={href({ section: null })} aria-current={!configuration ? "page" : undefined}>
          订单任务
        </Link>
        <Link
          href={href({ section: "configuration", line: null })}
          aria-current={configuration ? "page" : undefined}
        >
          商品与制作方案
        </Link>
      </nav>
      {error && (
        <div className="cp-message cp-error" role="alert">
          {error}
          <button type="button" onClick={() => setRetry((n) => n + 1)}>
            重新读取
          </button>
        </div>
      )}
      {loading && (
        <p role="status" className="cp-message">
          正在读取抱枕商品与订单进度…
        </p>
      )}
      {!!workspace?.diagnostics.length && (
        <p className="cp-message cp-warning" role="status">
          {workspace.diagnostics.join("；")}
        </p>
      )}
      {!loading && workspace && !configuration && (
        <>
          <p className="cp-note">
            此处显示已在审单中绑定抱枕工艺的订单。尚未绑定的订单，请先在订单中心核对商品与制作方案。
          </p>
          {!workspace.access.orders ? (
            <p className="cp-message" role="status">
              当前账号没有订单读取权限。
            </p>
          ) : (
            <>
              <form className="cp-filters" onSubmit={filter}>
                <label htmlFor="pillow-search">订单查询</label>
                <div className="cp-search">
                  <Search size={15} />
                  <input
                    id="pillow-search"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="订单号、SKU 或商品名称"
                    maxLength={200}
                  />
                </div>
                <label htmlFor="pillow-stage">环节</label>
                <select
                  id="pillow-stage"
                  value={stage}
                  onChange={(event) =>
                    router.replace(
                      href({ stage: event.target.value || null, page: null, line: null }),
                    )
                  }
                >
                  <option value="">全部环节</option>
                  {OrderQueueStageSchema.options.map((key) => (
                    <option key={key} value={key}>
                      {ORDER_QUEUE_LABELS[key]}
                    </option>
                  ))}
                </select>
                <button type="submit">查询</button>
                <span>共 {orders?.total ?? 0} 个订单商品</span>
              </form>
              <div className="cp-pillow-counts" aria-label="抱枕订单进度">
                {orders?.counts &&
                  ["pending_review", "in_progress", "in_review", "approved", "production"].map(
                    (key) => (
                      <Link key={key} href={href({ stage: key, page: null, line: null })}>
                        {ORDER_QUEUE_LABELS[key as keyof typeof ORDER_QUEUE_LABELS]}{" "}
                        <strong>
                          {orders.counts!.stages[key as keyof typeof ORDER_QUEUE_LABELS]}
                        </strong>
                      </Link>
                    ),
                  )}
              </div>
              <div className="cp-table-wrap">
                <table className="cp-table">
                  <thead>
                    <tr>
                      <th>订单商品</th>
                      <th>规格与方案</th>
                      <th>审单／制图</th>
                      <th>生产</th>
                      <th>下一步</th>
                    </tr>
                  </thead>
                  <tbody>
                    {orders?.items.map((item) => (
                      <tr key={item.id} aria-selected={item.id === lineId}>
                        <td data-label="订单商品">
                          <strong>{item.externalOrderId}</strong>
                          <small>
                            {item.storeName} · {item.quantity} 件
                          </small>
                        </td>
                        <td data-label="规格与方案">
                          {item.specificationName ?? "规格待核对"}
                          <small>{item.printSku ?? "来图方案待核对"}</small>
                        </td>
                        <td data-label="审单／制图">
                          {label(item.preparation)} · {label(item.artwork)}
                          {item.held && <small>已暂停</small>}
                          {item.sourceChanged && <small>来源已变化</small>}
                        </td>
                        <td data-label="生产">{label(item.production)}</td>
                        <td data-label="下一步">
                          {workspace.access.details ? (
                            <Link href={href({ line: item.id })}>
                              查看任务
                              <ArrowUpRight size={13} />
                            </Link>
                          ) : (
                            <span>需要订单资料与设计素材权限</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {!orders?.items.length && (
                <div className="cp-stage-empty">
                  没有匹配的抱枕订单。可调整筛选，或在订单中心为未绑定订单选择抱枕制作方案。
                </div>
              )}
              {!!orders && orders.total > orders.pageSize && (
                <nav className="cp-pagination" aria-label="抱枕订单分页">
                  {page > 1 && (
                    <Link href={href({ page: String(page - 1), line: null })}>上一页</Link>
                  )}
                  <span>
                    第 {page} / {Math.ceil(orders.total / orders.pageSize)} 页
                  </span>
                  {page * orders.pageSize < orders.total && (
                    <Link href={href({ page: String(page + 1), line: null })}>下一页</Link>
                  )}
                </nav>
              )}
            </>
          )}
          {lineId && (
            <section className="cp-pillow-order" aria-label="本单任务详情" aria-busy={orderLoading}>
              <Link href={href({ line: null })} className="cp-back">
                <ArrowLeft size={14} />
                收起本单任务
              </Link>
              {orderLoading && <p role="status">正在核对本单固定版本…</p>}
              {orderError && (
                <p className="cp-message cp-error" role="alert">
                  {orderError}
                </p>
              )}
              {order && <PillowOrderDetail order={order} link={link} />}
            </section>
          )}
        </>
      )}
      {!loading && workspace && configuration && (
        <PillowConfiguration workspace={workspace} link={link} />
      )}
    </main>
  );
}

function PillowConfiguration({
  workspace,
  link,
}: {
  workspace: Workspace;
  link: (target: string) => string;
}) {
  if (!workspace.access.catalog) return <p role="status">当前账号没有商品配置读取权限。</p>;
  return (
    <div className="cp-pillow-configuration">
      <div className="cp-section-header">
        <div>
          <h2>载体与加工规格</h2>
          <p className="cp-note">
            异形轮廓按订单照片生成。此处维护可复用的面料、尺寸、包装与工艺底稿，成品尺寸需按供应商口径确认。
          </p>
        </div>
        <Link href={link("/product-specifications")}>
          维护 SPU 与规格
          <ArrowUpRight size={14} />
        </Link>
      </div>
      <div className="cp-table-wrap">
        <table className="cp-table">
          <thead>
            <tr>
              <th>载体／规格</th>
              <th>材质与包装</th>
              <th>工艺</th>
              <th>物料关联</th>
              <th>状态</th>
            </tr>
          </thead>
          <tbody>
            {workspace.specifications.map((spec) => (
              <tr key={spec.id}>
                <td data-label="载体／规格">
                  <Link href={link(`/product-specifications?spu=${spec.spuId}`)}>
                    {spec.spuName} · {spec.name}
                  </Link>
                  <small>
                    规格 V{spec.version} · {spec.facts.dimensions || "尺寸基准待确认"}
                  </small>
                </td>
                <td data-label="材质与包装">
                  {spec.facts.material || "材质待确认"}
                  <small>{spec.facts.packageContents || "包装内容待确认"}</small>
                </td>
                <td data-label="工艺">{spec.processName || "待绑定工艺底稿"}</td>
                <td data-label="物料关联">
                  {spec.stockItemId ? "已关联库存物料" : "未关联库存物料"}
                </td>
                <td data-label="状态">
                  {spec.facts.factsConfirmed && spec.processProfileVersionId
                    ? "事实已确认，已绑定工艺"
                    : "草稿，暂不能用于生产"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!workspace.specifications.length && (
        <p className="cp-stage-empty">
          还没有绑定抱枕工艺的产品规格。先在 SPU 中确认真实规格，再绑定已审核底稿。
        </p>
      )}
      <div className="cp-section-header">
        <h2>可复用的图案与来图方案</h2>
        <Link href={link("/print-library")}>
          维护印花与来图方案
          <ArrowUpRight size={14} />
        </Link>
      </div>
      <ul className="cp-artworks">
        {workspace.artworks.map((art) => (
          <li key={art.id}>
            <div>
              <strong>
                {art.name} · V{art.version}
              </strong>
              <span>
                {art.code} · {modeLabels[art.mode]}
              </span>
              <p className="cp-note">
                {art.customization.fields
                  .map((field) => `${field.label}${field.required ? "（必填）" : ""}`)
                  .join("、") || "固定母版"}
              </p>
              <p className="cp-preserve">{art.instructions || "制作说明待补齐"}</p>
            </div>
          </li>
        ))}
      </ul>
      {!workspace.artworks.length && (
        <p className="cp-stage-empty">
          尚无组合到抱枕销售 SKU 的设计方案。客户原图在每笔订单内保存。
        </p>
      )}
      <div className="cp-section-header">
        <h2>销售 SKU 与生产配方</h2>
        <Link href={link("/product-development")}>
          维护销售组合
          <ArrowUpRight size={14} />
        </Link>
      </div>
      <ul className="cp-artworks">
        {workspace.recipes.map((recipe) => (
          <li key={recipe.recipeId}>
            <div>
              <Link href={link(`/product-development?sku=${recipe.skuId}`)}>
                {recipe.skuCode} · 配方 V{recipe.version}
                <ArrowUpRight size={13} />
              </Link>
              <span>
                {recipeLabels[recipe.status]}
                {recipe.needsUpdate ? " · 来源有新版本，需另行修订配方" : ""}
              </span>
            </div>
          </li>
        ))}
      </ul>
      {!workspace.recipes.length && (
        <p className="cp-stage-empty">
          还没有抱枕销售组合。确认来图方案与规格后，在产品开发组合并确认。
        </p>
      )}
      <p className="cp-note">
        方案确认允许订单选用。新增 Listing 与商品套图仍需经过独立审核的展示素材和资料包。
      </p>
    </div>
  );
}

function PillowOrderDetail({
  order,
  link,
}: {
  order: PillowProjectOrder;
  link: (target: string) => string;
}) {
  const run = order.agent.run;
  const target = (path: string) => link(`${path}?productType=shaped_pillow&line=${order.line.id}`);
  return (
    <>
      <div className="cp-section-header">
        <div>
          <h2>本单制作 · {order.line.externalOrderId}</h2>
          <p className="cp-note">
            {order.basis.pinned
              ? `已固定制作需求 V${order.line.revision}`
              : "制作方案尚未保存，派发前需核对"}
          </p>
        </div>
        <Link href={target("/orders")}>
          核对定制要求
          <ArrowUpRight size={14} />
        </Link>
      </div>
      {!!order.diagnostics.length && (
        <div className="cp-message cp-warning" role="status">
          {order.diagnostics.map((text, index) => (
            <p key={index}>{text}</p>
          ))}
        </div>
      )}
      <ol className="cp-pillow-stages">
        {order.stages.map((stage) => (
          <li key={stage.key}>
            <div>
              <strong>{stage.label}</strong>
              <span className="cp-status" data-status={stage.status}>
                {stageLabels[stage.status]}
              </span>
            </div>
            <p>{stage.detail}</p>
          </li>
        ))}
      </ol>
      <div className="cp-stage-actions">
        <Link href={target("/order-artwork")}>
          {run ? "处理自动任务与制作稿" : "进入本单制图"}
          <ArrowUpRight size={14} />
        </Link>
        <Link href={target("/order-artwork")}>
          查看图稿与审核
          <ArrowUpRight size={14} />
        </Link>
        <Link href={target("/production")}>
          正式文件与生产安排
          <ArrowUpRight size={14} />
        </Link>
      </div>
      <dl className="cp-pillow-basis">
        <div>
          <dt>定制方案</dt>
          <dd>
            {order.basis.artworkName ?? "名称待核对"} · 版本 {version(order.basis.artworkVersionId)}
          </dd>
        </div>
        <div>
          <dt>本单规格</dt>
          <dd>
            {order.basis.specificationName ?? "规格待核对"} · 版本{" "}
            {version(order.basis.specificationVersionId)}
          </dd>
        </div>
        <div>
          <dt>固定工艺</dt>
          <dd>
            {order.basis.profile.name} · V{order.basis.profile.versionNumber}
          </dd>
        </div>
        <div>
          <dt>工厂要求</dt>
          <dd>对照已确认标准 {SHAPED_PILLOW_FACTORY_STANDARD.id}</dd>
        </div>
      </dl>
      <div className="cp-pillow-versions">
        <ProcessEvidence title="本单固定底稿" value={order.template} />
        <ProcessEvidence title="当前制作版本" value={order.currentArtwork} />
      </div>
      <section aria-label="无人设计任务">
        <div className="cp-section-header">
          <h3>无人设计任务</h3>
          {run && <span className="cp-status">{agentLabels[run.status]}</span>}
        </div>
        {!run ? (
          <p className="cp-note">
            本单没有自动任务记录。先核对制作需求，再按已审核底稿派发；人工制作在制图中心继续。
          </p>
        ) : (
          <>
            {run.errorCode && (
              <p className="cp-message cp-warning" role="status">
                {designAgentErrorMessage(run.errorCode)}
              </p>
            )}
            <p className="cp-note">
              预估费用 {money(run.estimatedCostUsd)} · 实际费用 {money(run.actualCostUsd)}
              {run.costStatus === "unknown" ? " · 调用费用待核实" : ""}
            </p>
            <ol className="cp-pillow-steps">
              {run.steps.map((step) => (
                <li key={step.id}>
                  <strong>{step.key === "review_required" ? "交付待核对稿件" : step.label}</strong>
                  <span>
                    {step.key === "review_required" && step.status === "completed"
                      ? "待人工核对"
                      : (agentLabels[step.status] ?? "状态待核对")}
                  </span>
                  {step.errorCode && <p>{designAgentErrorMessage(step.errorCode)}</p>}
                </li>
              ))}
            </ol>
            <details className="cp-pillow-rules">
              <summary>
                本任务使用的规则
                {run.ruleSnapshot
                  ? ` · ${run.ruleSnapshot.rules.length} 项`
                  : " · 历史任务未固定快照"}
              </summary>
              {run.ruleSnapshot && (
                <p className="cp-note">
                  核验方式表示派发时固定的执行能力；本单完成情况见上方任务步骤与审核状态。
                </p>
              )}
              {run.ruleSnapshot ? (
                run.ruleSnapshot.rules.length ? (
                  run.ruleSnapshot.rules.map((rule) => (
                    <div key={rule.id}>
                      <strong>
                        {rule.name} · V{rule.version}
                      </strong>
                      <span>
                        核验方式：
                        {rule.execution === "automatic"
                          ? "系统自动核验"
                          : RULE_EXECUTION_LABELS[rule.execution]}
                      </span>
                      <p>{rule.instructions}</p>
                      <Link
                        href={link(`/settings/rules?rule=${rule.ruleId}&version=${rule.version}`)}
                      >
                        查看固定版本依据
                      </Link>
                    </div>
                  ))
                ) : (
                  <p>派发时没有匹配的启用规则；仍按已固定工艺预检。</p>
                )
              ) : (
                <p>历史任务未记录规则快照，不能用当前规则补填。</p>
              )}
            </details>
          </>
        )}
      </section>
    </>
  );
}

function ProcessEvidence({
  title,
  value,
}: {
  title: string;
  value: PillowProjectOrder["template"];
}) {
  return (
    <section>
      <h3>{title}</h3>
      {value ? (
        <dl>
          <div>
            <dt>版本</dt>
            <dd>
              V{value.version} · {version(value.versionId)} · {value.reviewed ? "已审核" : "未审核"}
            </dd>
          </div>
          <div>
            <dt>工厂标识</dt>
            <dd>{value.factoryStandardId ?? "旧版本未标注"}</dd>
          </div>
          <div>
            <dt>尺寸／细窄处口径</dt>
            <dd>
              {measurementLabels[value.sizeBasis]}／{measurementLabels[value.minimumNeckBasis]}
            </dd>
          </div>
          <div>
            <dt>印刷面数</dt>
            <dd>{value.sideMode === "single" ? "单面" : "双面"}</dd>
          </div>
          <div>
            <dt>自动制图配方</dt>
            <dd>{value.automationEnabled ? "底稿已配置，派发条件另行检查" : "未配置"}</dd>
          </div>
        </dl>
      ) : (
        <p className="cp-note">尚无可读取的制作版本。</p>
      )}
    </section>
  );
}
