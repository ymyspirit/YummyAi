"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import Image from "next/image";
import { RefreshCw } from "lucide-react";
import type {
  DevelopmentOptions,
  SalesSkuDetail,
  SalesRecipeView,
} from "@yummyai/contracts/catalog/development";
import {
  ProductionEditorDetailViewSchema,
  type ProductionEditorDetailView,
} from "@yummyai/contracts/pod/production-editor-api";
import { ProductionEditorSession } from "../production-editor/production-editor-session";
import { developmentRequest as request, statuses, modes } from "./development-client";
import { CombinationForm } from "./development-forms";
import { useBreadcrumbDetail } from "../navigation/breadcrumb-details";
import { formFingerprint, useFormEdits } from "../navigation/use-form-edits";
import { useLeaveGuard } from "../navigation/use-leave-guard";
import { TaskDrawer, type TaskDrawerState } from "../navigation/task-drawer";
import { useWorkflowReturn } from "../navigation/use-workflow-return";
import { workflowHref } from "../navigation/workflow-href";

type SalesSkuPanelProps = {
  skuId: string;
  options: DevelopmentOptions;
  onBack: () => void;
  onChanged: () => void;
  queue?: string[];
  onSelect?: (id: string) => void;
};

export function SalesSkuPanel(props: SalesSkuPanelProps) {
  const [state, setState] = useState<TaskDrawerState>({ dirty: false, busy: false, loading: true });
  const [editorOpen, setEditorOpen] = useState(false);
  const queue = props.queue ?? [];
  const index = queue.indexOf(props.skuId);
  const select = (id: string) => {
    setState({ dirty: false, busy: false, loading: true });
    props.onSelect?.(id);
  };
  return <TaskDrawer className="pd-page" title="销售 SKU · 连续处理" recordKey={props.skuId} state={state}
    description={index >= 0 ? `本页 ${index + 1} / ${queue.length}` : "当前 SKU"}
    onClose={props.onBack} closeLabel="返回产品开发" fullScreen={editorOpen}
    previous={{ label: "上一个 SKU", action: props.onSelect && index > 0 ? () => select(queue[index - 1]!) : undefined }}
    next={{ label: "下一个 SKU", action: props.onSelect && index >= 0 && index < queue.length - 1 ? () => select(queue[index + 1]!) : undefined }}>
    <SalesSkuContent key={props.skuId} {...props} onStateChange={setState} onEditorChange={setEditorOpen} />
  </TaskDrawer>;
}

function SalesSkuContent({
  skuId,
  options,
  onBack,
  onChanged,
  onStateChange,
  onEditorChange,
}: SalesSkuPanelProps & {
  onStateChange: (state: TaskDrawerState) => void;
  onEditorChange: (open: boolean) => void;
}) {
  const workflow = useWorkflowReturn();
  const [detail, setDetail] = useState<SalesSkuDetail | null>(null),
    [recipeId, setRecipeId] = useState(""),
    [refresh, setRefresh] = useState(0),
    [editor, setEditor] = useState<ProductionEditorDetailView | null>(null),
    [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [loading, setLoading] = useState(true),
    [reason, setReason] = useState("");
  const [listingVersionId, setListingVersionId] = useState(""),
    [evidence, setEvidence] = useState<Record<string, string>>({});
  const forms = useFormEdits();
  const dirty = forms.dirty || !!reason.trim() || !!listingVersionId || Object.keys(evidence).length > 0;
  const mayLeave = useLeaveGuard(dirty, busy, false);
  const go = (action: () => void) => { if (mayLeave()) action(); };
  const submittedForm = useRef<{ element: HTMLFormElement; fingerprint: string } | null>(null);
  const keys = useRef(new Map<string, string>()),
    recipe = detail?.recipes.find((r) => r.id === recipeId) ?? detail?.recipes[0] ?? null;
  useEffect(() => onStateChange({ dirty, busy, loading }), [dirty, busy, loading, onStateChange]);
  useEffect(() => onEditorChange(editing && !!recipe?.editorProjectId), [editing, recipe?.editorProjectId, onEditorChange]);
  useBreadcrumbDetail(`/product-development:${skuId}`, detail?.item.skuId === skuId ? detail.item.skuCode : undefined);
  useEffect(() => {
    const abort = new AbortController();
    setLoading(true);
    setError("");
    void request<SalesSkuDetail>(`skus/${skuId}`, undefined, abort.signal)
      .then((d) => {
        if (!abort.signal.aborted) setDetail(d);
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [skuId, refresh]);
  useEffect(() => {
    setEditor(null);
    if (!recipe?.editorProjectId) return;
    const abort = new AbortController();
    void fetch(`/api/production-editor/projects/${recipe.editorProjectId}`, {
      cache: "no-store",
      signal: abort.signal,
    })
      .then(async (r) => {
        if (!r.ok) throw Error("制作文件暂不可用");
        return ProductionEditorDetailViewSchema.parse(await r.json());
      })
      .then((d) => {
        if (!abort.signal.aborted) setEditor(d);
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(e.message);
      });
    return () => abort.abort();
  }, [recipe?.editorProjectId, refresh]);
  async function mutate(path: string, body: Record<string, unknown>, message: string) {
    setBusy(true);
    setError("");
    setNotice("");
    const identity = JSON.stringify({ path, body });
    const key = keys.current.get(identity) ?? crypto.randomUUID();
    keys.current.set(identity, key);
    try {
      const result = await request<{ recipe?: SalesRecipeView; listingId?: string }>(path, {
        ...body,
        idempotencyKey: key,
      });
      keys.current.delete(identity);
      setNotice(message);
      setRefresh((n) => n + 1);
      onChanged();
      return result;
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作失败");
      return null;
    } finally {
      setBusy(false);
    }
  }
  async function start() {
    if (!recipe) return;
    const result = await mutate(
      `recipes/${recipe.id}/actions`,
      { action: "start_adaptation", reason: "按印花和规格创建 SKU 制作稿" },
      "制作项目已创建",
    );
    if (result?.recipe) {
      setDetail((d) =>
        d
          ? {
              ...d,
              recipes: d.recipes.map((r) => (r.id === result.recipe!.id ? result.recipe! : r)),
            }
          : d,
      );
      setEditing(true);
    }
  }
  async function approve() {
    if (!recipe || !editor) return;
    const render = editor.renders.find(
      (r) =>
        r.purpose === "production" &&
        r.status === "completed" &&
        r.versionId === editor.version.id &&
        r.preflight?.productionReady &&
        r.files.some((f) => f.mediaType === "image/png"),
    );
    if (!render) {
      setError("请先在编辑器审核当前文件，再以 PNG 格式完成生产出图，返回后刷新。");
      return;
    }
    if (!reason.trim()) {
      setError("请填写审核说明，确认印花、产品事实和素材使用权。");
      return;
    }
    const result = await mutate(
      `recipes/${recipe.id}/actions`,
      {
        action: "approve_adaptation",
        expectedEditorVersionId: editor.version.id,
        renderId: render.id,
        reason,
      },
      "制作版本已锁定，可进入套图",
    );
    if (result) setReason("");
  }
  async function confirmPlan() {
    if (!recipe || !reason.trim()) return;
    const result = await mutate(`recipes/${recipe.id}/actions`, {action:"confirm_customization_plan",reason}, "来图方案已确认，可在订单中选择此销售 SKU；每单生产文件另行制作审核");
    if (result) setReason("");
  }
  async function revise() {
    if (!recipe || !detail) return;
    const art = options.artworks.find((a) => a.id === recipe.artwork.id),
      spec = options.specifications.find((s) => s.id === recipe.specification.id);
    if (!art || !spec || !reason.trim()) {
      setError("请填写变更原因");
      return;
    }
    const result = await mutate(
      `skus/${skuId}/revisions`,
      {
        artworkVersionId: art.versionId,
        specificationVersionId: spec.versionId,
        expectedVersion: detail.recipes[0]!.version,
        reason,
      },
      "已创建制作新版本，旧资料包与订单保留原记录",
    );
    if (result?.recipe) { setRecipeId(result.recipe.id); setReason(""); }
  }
  async function listing(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!recipe) return;
    const d = new FormData(e.currentTarget);
    const element = e.currentTarget, submitted = formFingerprint(element);
    const result = await mutate(
      "listings",
      {
        recipeIds: d.getAll("recipe").map(String),
        platform: d.get("platform"),
        marketplaceId: d.get("marketplace"),
        locale: d.get("locale"),
        title: d.get("title"),
      },
      "Listing 草稿已创建，请进入刊登控制台完善文案、图片与变体并审核",
    );
    if (result) forms.commit(element, submitted);
  }
  const selectedListing = detail?.listings.find((l) => l.versionId === listingVersionId);
  async function seal() {
    if (!recipe || !selectedListing || !reason.trim()) {
      setError("请选择已审核 Listing 并填写审核说明");
      return;
    }
    const result = await mutate(
      "packages",
      {
        recipeId: recipe.id,
        listingId: selectedListing.id,
        listingVersionId: selectedListing.versionId,
        imageEvidence: selectedListing.assetIds.map((assetId) => ({
          assetId,
          kind: evidence[assetId] ?? "mockup",
        })),
        reason,
      },
      "渠道资料包已封存，可下载或登记店铺映射",
    );
    if (result) { setReason(""); setListingVersionId(""); setEvidence({}); }
  }
  async function bind(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const d = new FormData(e.currentTarget);
    const element = e.currentTarget, submitted = formFingerprint(element);
    const result = await mutate(
      "channels",
      {
        packageId: d.get("package"),
        accountId: d.get("account"),
        externalSku: d.get("sku"),
        externalListingId: d.get("listing"),
        effectiveFrom: new Date(String(d.get("effective"))).toISOString(),
        evidence: d.get("evidence"),
      },
      "渠道映射已登记，订单按下单时间匹配版本",
    );
    if (result) forms.commit(element, submitted);
  }
  if (editing && recipe?.editorProjectId)
    return (
      <ProductionEditorSession
        title={`${recipe.skuCode} · 制作 v${recipe.version}`}
        subtitle={`${recipe.artwork.code} + ${recipe.specification.spuCode} · ${recipe.specification.name}`}
        returnLabel="返回产品开发"
        projectId={recipe.editorProjectId}
        onClose={() => {
          setEditing(false);
          setRefresh((n) => n + 1);
        }}
      />
    );
  if (!detail)
    return (
      <section className="oc-page">
        <button className="oc-button" disabled={busy} onClick={() => go(onBack)}>
          返回产品开发
        </button>
        {error ? <p role="alert">{error}</p> : <p role="status">读取销售 SKU…</p>}
      </section>
    );
  return (
    <section className="oc-page pd-page" ref={forms.ref} onInputCapture={forms.check} onChangeCapture={forms.check} onSubmitCapture={event => {
      if (event.target instanceof HTMLFormElement) submittedForm.current = { element: event.target, fingerprint: formFingerprint(event.target) };
    }}>
      <header className="oc-header">
        <div>
          <h1>{detail.item.skuCode}</h1>
          <p>
            {detail.item.spuCode} · {detail.item.spuName}
          </p>
        </div>
        <button
          className="oc-button"
          disabled={busy || loading || forms.dirty}
          onClick={() => setRefresh((n) => n + 1)}
        >
          <RefreshCw size={15} />
          刷新状态
        </button>
      </header>
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
      {!recipe ? (
        <section className="oc-section">
          <h2>待映射的旧 SKU</h2>
          <p>请明确选择印花与产品规格。现有编号、订单和库存记录会保留。</p>
          <CombinationForm
            options={options}
            busy={busy}
            legacy={detail.item}
            onSave={async (body) => {
              const submitted = submittedForm.current;
              const result = await mutate("combinations", body, "映射已保存");
              if (result && submitted) forms.commit(submitted.element, submitted.fingerprint);
              return !!result;
            }}
          />
        </section>
      ) : (
        <>
          <section className="pd-section">
            <label>
              查看制作版本
              <select value={recipe.id} onChange={(e) => setRecipeId(e.target.value)}>
                {detail.recipes.map((r) => (
                  <option key={r.id} value={r.id}>
                    V{r.version} · {statuses[r.status]} ·{" "}
                    {new Date(r.createdAt).toLocaleString("zh-CN")}
                  </option>
                ))}
              </select>
            </label>
            <dl className="pd-detail-facts">
              <div>
                <dt>独立印花</dt>
                <dd>
                  {recipe.artwork.code} · V{recipe.artwork.version}
                  <small>
                    {recipe.artwork.name} · {modes[recipe.artwork.mode]}
                  </small>
                </dd>
              </div>
              <div>
                <dt>商品与规格</dt>
                <dd>
                  {recipe.specification.spuCode} / {recipe.specification.code} · V
                  {recipe.specification.version}
                  <small>{recipe.specification.name}</small>
                </dd>
              </div>
              <div>
                <dt>生产工艺</dt>
                <dd>
                  {recipe.specification.processName}
                  <small>
                    {recipe.specification.facts.material} · {recipe.specification.facts.dimensions}
                  </small>
                </dd>
              </div>
            </dl>
            {recipe.needsUpdate && (
              <p className="oc-hint">
                印花或规格已有新版本。本制作版本保持原内容，可填写原因后创建新版。
              </p>
            )}
            <label>
              审核 / 变更说明
              <textarea
                aria-label="审核 / 变更说明"
                disabled={busy}
                rows={2}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="记录核对结果、使用权或变更原因"
                maxLength={2000}
              />
            </label>
          </section>
          <section className="pd-step">
            <div>
              <h2>{recipe.artwork.assetId ? "1. 制作文件" : "1. 来图制作方案"}</h2>
              <p>
                {statuses[recipe.status]} ·{" "}
                {!recipe.artwork.assetId
                  ? "确认印花规则与产品规格，收到买家图片后在订单中制作并审核生产文件"
                  : recipe.status === "approved"
                  ? "版本已锁定，后续修改请创建新版"
                  : "完成版面、预检、文件审核和 PNG 生产出图"}
              </p>
            </div>
            <div className="oc-actions">
              {!recipe.artwork.assetId ? (
                <button className="oc-button primary" disabled={busy || !reason.trim() || recipe.status === "ready_for_customization"} onClick={() => void confirmPlan()}>
                  {recipe.status === "ready_for_customization" ? "来图方案已确认" : "确认来图方案"}
                </button>
              ) : recipe.editorProjectId ? (
                <button className="oc-button" onClick={() => setEditing(true)}>
                  打开制作文件
                </button>
              ) : (
                <button className="oc-button primary" disabled={busy} onClick={() => void start()}>
                  开始制作
                </button>
              )}
              {recipe.artwork.assetId && recipe.status !== "approved" && (
                <button
                  className="oc-button primary"
                  disabled={busy || !editor}
                  onClick={() => void approve()}
                >
                  审核并锁定
                </button>
              )}
              <button
                className="oc-button"
                disabled={busy || !reason.trim()}
                onClick={() => void revise()}
              >
                创建新版本
              </button>
            </div>
          </section>
          <section className="pd-step">
            <div>
              <h2>2. 商品套图</h2>
              <p>
                {recipe.specification.canvasPrintSpecVersionId
                  ? "选择与此制作规格兼容的场景模板，审核套图输出。"
                  : "请先为产品规格补充套图印刷规格，再创建制作新版本。"}
              </p>
            </div>
            {recipe.status === "approved" && recipe.specification.canvasPrintSpecVersionId ? (
              <Link
                className="oc-button"
                href={workflowHref(`/pod-workbench/mockup-batches?skuId=${skuId}&designVersionId=${recipe.designVersionId}`, workflow.current)}
              >
                进入套图工作台
              </Link>
            ) : (
              <span className="oc-hint">等待制作和规格就绪</span>
            )}
          </section>
          <section className="pd-section">
            <h2>3. 渠道 Listing 与资料包</h2>
            <p className="oc-hint">
              在刊登控制台完善文案、场景图和销售变体并审核，然后在此封存。每个资料包固定本 SKU
              的制作版本。
            </p>
            <details>
              <summary>创建渠道 Listing 草稿</summary>
              <form key={recipe.id} onSubmit={listing}>
                <fieldset disabled={busy || recipe.status !== "approved"} className="pd-form">
                  <fieldset className="pd-variants">
                    <legend>同款销售规格</legend>
                    {[recipe, ...detail.relatedRecipes.filter((r) => r.skuId !== recipe.skuId)].map(
                      (r) => (
                        <label className="pd-check" key={r.id}>
                          <input type="checkbox" name="recipe" value={r.id} defaultChecked />
                          {r.specification.name} · {r.skuCode} · 制作 V{r.version}
                        </label>
                      ),
                    )}
                    <p className="oc-hint">
                      同一印花与 SPU 的多个规格可以合并为一个 Listing；这里只显示已审核制作版本。
                    </p>
                  </fieldset>
                  <label>
                    平台
                    <select name="platform">
                      <option value="etsy">Etsy</option>
                      <option value="amazon">Amazon</option>
                    </select>
                  </label>
                  <label>
                    站点编号
                    <input name="marketplace" required placeholder="US / ATVPDKIKX0DER" />
                  </label>
                  <label>
                    语言
                    <input name="locale" required defaultValue="en-US" />
                  </label>
                  <label>
                    商品标题
                    <input
                      name="title"
                      required
                      defaultValue={`${recipe.artwork.name} ${recipe.specification.spuName}`}
                    />
                  </label>
                  <button className="oc-button">创建草稿</button>
                </fieldset>
              </form>
            </details>
            <div className="pd-table">
              <table>
                <thead>
                  <tr>
                    <th>Listing</th>
                    <th>渠道</th>
                    <th>审核状态</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.listings.map((l) => (
                    <tr key={l.versionId}>
                      <td>{l.title || "未填写标题"}</td>
                      <td>
                        {l.platform} / {l.locale}
                      </td>
                      <td>
                        {l.status === "approved"
                          ? "已审核"
                          : l.status === "superseded"
                            ? "历史版本"
                            : "待审核"}
                      </td>
                      <td>
                        <Link className="oc-button" href={workflowHref(`/listings/${l.id}`, workflow.current)}>
                          文案 / AI 助手 / 审核
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="pd-form pd-section">
              <label>
                封存 Listing 版本
                <select
                  value={listingVersionId}
                  onChange={(e) => {
                    setListingVersionId(e.target.value);
                    setEvidence({});
                  }}
                >
                  <option value="">请选择已审核版本</option>
                  {detail.listings
                    .filter((l) => l.status === "approved")
                    .map((l) => (
                      <option key={l.versionId} value={l.versionId}>
                        {l.platform} / {l.locale} · {l.title}
                      </option>
                    ))}
                </select>
              </label>
              <div>
                {selectedListing?.assetIds.map((id, index) => (
                  <label className="pd-evidence" key={id}>
                    <span>
                      <Image
                        unoptimized
                        className="pd-thumb"
                        src={`/api/product-development/assets/${id}/preview`}
                        alt={`Listing 图片 ${index + 1}`}
                        width={64}
                        height={64}
                      />
                      图片 {index + 1}
                      <small className="pd-code">{id}</small>
                    </span>
                    <select
                      aria-label={`图片 ${index + 1} 用途`}
                      value={evidence[id] ?? "mockup"}
                      onChange={(e) => setEvidence({ ...evidence, [id]: e.target.value })}
                    >
                      <option value="mockup">已审核套图</option>
                      <option value="finished_photo">实际成品照片</option>
                      <option value="detail">细节图</option>
                      <option value="size">尺寸说明</option>
                      <option value="customization">定制说明</option>
                    </select>
                  </label>
                ))}
              </div>
              <button
                className="oc-button primary"
                disabled={
                  busy || !selectedListing || !reason.trim() || recipe.status !== "approved"
                }
                onClick={() => void seal()}
              >
                审核并封存资料包
              </button>
            </div>
          </section>
        </>
      )}
      <section className="pd-section">
        <h2>已封存资料包</h2>
        <div className="pd-table">
          <table>
            <thead>
              <tr>
                <th>渠道</th>
                <th>资料包版本</th>
                <th>制作依据</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {detail.packages.map((p) => (
                <tr key={p.id}>
                  <td>
                    {p.platform} / {p.marketplaceId} / {p.locale}
                  </td>
                  <td>
                    V{p.version}
                    <small>{new Date(p.createdAt).toLocaleString("zh-CN")}</small>
                  </td>
                  <td>
                    制作 V{detail.recipes.find((r) => r.id === p.recipeId)?.version}
                    <small className="pd-code">SHA256 {p.checksum.slice(0, 16)}…</small>
                  </td>
                  <td>
                    <a
                      className="oc-button"
                      href={`/api/product-development/packages/${p.id}/export`}
                    >
                      下载资料包
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!detail.packages.length && <p className="pd-empty">尚未封存资料包。</p>}
        </div>
      </section>
      <section className="pd-section">
        <h2>店铺 SKU 映射</h2>
        <p className="oc-hint">
          记录已在平台使用的 SKU、Listing 编号和生效时间，供导入订单匹配版本。登记映射不会发布商品。
        </p>
        {detail.packages.length > 0 && (
          <details>
            <summary>登记映射</summary>
            <form onSubmit={bind}>
              <fieldset disabled={busy} className="pd-form">
                <label>
                  渠道资料包
                  <select name="package" required>
                    {detail.packages.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.platform} / {p.marketplaceId} · 资料包 V{p.version}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  店铺
                  <select name="account" required>
                    <option value="">请选择</option>
                    {options.accounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.displayName} · {a.platform}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  平台销售 SKU
                  <input name="sku" required defaultValue={detail.item.skuCode} />
                </label>
                <label>
                  平台 Listing 编号
                  <input name="listing" required />
                </label>
                <label>
                  生效时间
                  <input name="effective" type="datetime-local" required />
                </label>
                <label>
                  登记依据
                  <input name="evidence" required placeholder="例如：上架记录编号及核对说明" />
                </label>
                <button className="oc-button primary">登记映射</button>
              </fieldset>
            </form>
          </details>
        )}
        <ul className="pd-history">
          {detail.channelBindings.map((b) => (
            <li key={b.id}>
              {b.accountName} · {b.externalSku} · {b.externalListingId}
              <br />
              <small>
                {new Date(b.effectiveFrom).toLocaleString("zh-CN")} 生效 · {b.evidence}
              </small>
            </li>
          ))}
        </ul>
      </section>
      <details className="pd-section">
        <summary>操作记录（{detail.events.length}）</summary>
        <ul className="pd-history">
          {detail.events.map((e) => (
            <li key={e.id}>
              {e.reason}
              <br />
              <small>
                {new Date(e.occurredAt).toLocaleString("zh-CN")} · {e.action}
              </small>
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}
