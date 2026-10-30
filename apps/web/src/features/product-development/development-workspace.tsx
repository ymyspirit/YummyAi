"use client";
import { Suspense, useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import Image from "next/image";
import { useSearchParams } from "next/navigation";
import { Plus, RefreshCw, Search } from "lucide-react";
import { Permission } from "@yummyai/authz/permissions";
import { useErpAccess } from "../identity/erp-access";
import type {
  ArtworkView,
  DevelopmentOptions,
  DevelopmentWorkspace as WorkspaceData,
} from "@yummyai/contracts/catalog/development";
import {
  developmentRequest as request,
  DevelopmentRequestError,
  modes,
  statuses,
} from "./development-client";
import {
  catalogDraftScope,
  currentReadableBasis,
  developmentEditorAccess,
  obsoleteCatalogDraftPrefixes,
  type EditorSelection,
} from "./editor-access";
import { ArtworkForm, SpecificationForm, CombinationForm, SpuForm } from "./development-forms";
import { SpecificationBatchForm } from "./specification-batch-form";
import { SalesSkuPanel } from "./sales-sku-panel";
import { SpuDetailPanel } from "./spu-detail-panel";
import { ArtworkTable, SpuTable, SalesSkuTable } from "./development-tables";
import { DevelopmentDrawerForm } from "./development-drawer-form";
import { useBreadcrumbDetail } from "../navigation/breadcrumb-details";
import { readQueue } from "../navigation/workflow-href";
import { WorkflowReturnLink } from "../navigation/use-workflow-return";
import { TaskDrawer, TaskDrawerActions, type TaskDrawerState } from "../navigation/task-drawer";
import { clearTaskDrafts } from "../navigation/task-draft";
import { useLeaveGuard } from "../navigation/use-leave-guard";
import "../order-centers/order-centers.css";
import "./development.css";
import "./artwork-workflow.css";

type Mode = "artwork" | "specification" | "development";
const cleanState: TaskDrawerState = { dirty: false, busy: false, loading: false };
const closedForm = {
  form: null,
  compose: null,
  editSpu: null,
  specificationVersionId: null,
  artworkVersionId: null,
};

export function DevelopmentWorkspace({ mode }: { mode: Mode }) {
  return (
    <Suspense
      fallback={
        <main className="oc-page pd-page" aria-busy="true">
          <p role="status">正在读取…</p>
        </main>
      }
    >
      <DevelopmentWorkspaceContent mode={mode} />
    </Suspense>
  );
}

function DevelopmentWorkspaceContent({ mode }: { mode: Mode }) {
  const { can, canAll, authority, localDevelopment } = useErpAccess();
  const canWrite = can(Permission.ProductWrite);
  const canRegisterArtwork = canAll([Permission.ProductWrite, Permission.DesignReview]);
  const canEditMode = mode === "artwork" ? canRegisterArtwork : canWrite;
  const searchParams = useSearchParams();
  const q = searchParams.get("q") ?? "";
  const status = searchParams.get("status") ?? "all";
  const page = Math.max(1, Number(searchParams.get("page")) || 1);
  const selected = searchParams.get("sku");
  const spuId = searchParams.get("spu");
  const targetArtwork = searchParams.get("artwork");
  const artworkVersionId = searchParams.get("artworkVersionId");
  const specVersion = searchParams.get("specificationVersionId");
  const compose = searchParams.get("compose") === "1";
  const editingSpu = searchParams.get("editSpu") === "1";
  const requestedEditing = searchParams.get("form") === "1" || compose || editingSpu;
  const showArchivedArt = searchParams.get("archived") === "1";
  const [options, setOptions] = useState<DevelopmentOptions | null>(null);
  const [optionsUsable, setOptionsUsable] = useState(false);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const selection: EditorSelection = {
    form: searchParams.get("form") === "1",
    compose,
    editSpu: editingSpu,
    spuId,
    specVersion,
    artworkId: targetArtwork,
    artworkVersionId,
  };
  const requestKey = JSON.stringify({ mode, selection });
  const pinned = useRef<{ key: string; requestKey: string; options: DevelopmentOptions } | null>(
    null,
  );
  let basis = pinned.current?.requestKey === requestKey ? pinned.current.options : options;
  let editor = options
    ? developmentEditorAccess(mode, selection, options, can, basis ?? options)
    : null;
  const contextMatches = Boolean(
    options && (localDevelopment || (authority !== null && options.contextAuthority === authority)),
  );
  const editorKey = `${requestKey}:${options?.contextAuthority ?? "missing"}:${editor?.key ?? "loading"}`;
  if (options && editor?.allowed && contextMatches && pinned.current?.key !== editorKey) {
    pinned.current = { key: editorKey, requestKey, options };
    basis = options;
    editor = developmentEditorAccess(mode, selection, options, can);
  }
  const editing = Boolean(editor?.allowed && contextMatches);
  const batchEditing = editing && editor?.kind === "batch";
  const formOptions = options && basis ? currentReadableBasis(basis, options, can) : options;
  const formSpu = formOptions?.spus.find((spu) => spu.id === spuId);
  const formSpec =
    formOptions?.specifications.find((spec) => spec.versionId === specVersion) ?? null;
  const formArtwork =
    [...(formOptions?.artworks ?? []), ...(formOptions?.archivedArtworks ?? [])].find((art) =>
      targetArtwork ? art.id === targetArtwork : art.versionId === artworkVersionId,
    ) ?? null;
  const viewKey = JSON.stringify({
    mode,
    selection,
    selected,
    authority: options?.contextAuthority,
    editor: editor?.key,
  });
  const viewRef = useRef(viewKey);
  viewRef.current = viewKey;
  const [workspace, setWorkspace] = useState<WorkspaceData | null>(null);
  const [optionsLoading, setOptionsLoading] = useState(true);
  const [workspaceLoading, setWorkspaceLoading] = useState(mode === "development");
  const [refresh, setRefresh] = useState(0);
  const [workspaceRefresh, setWorkspaceRefresh] = useState(0);
  const [error, setError] = useState("");
  const [optionsError, setOptionsError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [formState, setFormState] = useState(cleanState);
  const retry = useRef(new Map<string, string>());
  const mutationPending = useRef(false);
  const mounted = useRef(true);
  const ready = optionsUsable && contextMatches;
  const loading = optionsLoading || workspaceLoading;
  const allArtworks = [...(options?.artworks ?? []), ...(options?.archivedArtworks ?? [])];
  const artwork =
    allArtworks.find(
      (item) =>
        item.id === targetArtwork || (!targetArtwork && item.versionId === artworkVersionId),
    ) ?? null;
  const selectedSpu = options?.spus.find((item) => item.id === spuId);
  const filteredArt = (
    (showArchivedArt ? options?.archivedArtworks : options?.artworks) ?? []
  ).filter((item) =>
    [item.code, item.name, ...item.tags].join(" ").toLowerCase().includes(q.toLowerCase()),
  );
  const filteredSpus = (options?.spus ?? []).filter((item) =>
    [
      item.code,
      item.name,
      ...(options?.specifications
        .filter((spec) => spec.spuId === item.id)
        .flatMap((spec) => [spec.code, spec.name]) ?? []),
    ]
      .join(" ")
      .toLowerCase()
      .includes(q.toLowerCase()),
  );
  const skuQueue =
    (selected && readQueue(searchParams.get("queue"), selected)) ||
    workspace?.items.map((item) => item.skuId) ||
    [];
  const recordId = mode === "specification" ? spuId : targetArtwork;
  const recordQueue =
    (recordId && readQueue(searchParams.get("queue"), recordId)) ||
    (mode === "specification" ? filteredSpus : filteredArt).map((item) => item.id);
  const recordIndex = recordId ? recordQueue.indexOf(recordId) : -1;
  const drawerOpen =
    !batchEditing && !(selected && mode === "development") && (requestedEditing || !!recordId);
  const state = { ...(editing ? formState : cleanState), busy, loading: optionsLoading || !ready };
  const mayLeaveBatch = useLeaveGuard(formState.dirty, busy, batchEditing);
  useBreadcrumbDetail(
    mode === "specification" && spuId ? `/product-specifications:${spuId}` : null,
    selectedSpu ? `${selectedSpu.code} · ${selectedSpu.name}` : undefined,
  );

  function updateSearch(values: Record<string, string | null>, push = false) {
    const params = new URLSearchParams(location.search);
    for (const [key, value] of Object.entries(values)) {
      if (value) params.set(key, value);
      else params.delete(key);
    }
    const search = params.toString();
    const href = `${location.pathname}${search ? `?${search}` : ""}`;
    if (push) history.pushState(null, "", href);
    else history.replaceState(null, "", href);
  }
  function open(values: Record<string, string | null>, push = true) {
    setError("");
    setNotice("");
    setFormState(cleanState);
    updateSearch(values, push);
  }
  function closeDrawer() {
    if (options && editing) {
      if (compose)
        clearTaskDrafts(`${catalogDraftScope(options)}:combination:${artworkVersionId ?? "new"}`);
      if (specVersion)
        clearTaskDrafts(`${catalogDraftScope(options)}:specification:${specVersion}`);
    }
    open({ ...closedForm, sku: null, spu: null, artwork: null, queue: null }, false);
  }
  function selectRecord(id: string, extra: Record<string, string | null> = {}) {
    open(
      {
        ...closedForm,
        [mode === "specification" ? "spu" : "artwork"]: id,
        queue: recordQueue.slice(0, 100).join(","),
        ...extra,
      },
      !recordId,
    );
  }
  function selectSku(id: string | null) {
    open({ sku: id, queue: id ? skuQueue.slice(0, 100).join(",") : null }, !selected);
  }
  const composeArtwork = (item: ArtworkView) =>
    selectRecord(item.id, { compose: "1", artworkVersionId: item.versionId });

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!requestedEditing) pinned.current = null;
    setFormState(cleanState);
  }, [requestKey, requestedEditing]);
  useEffect(() => {
    let disposed = false;
    let pending: AbortController | null = null;
    async function read(showLoading = false) {
      pending?.abort();
      const abort = new AbortController();
      pending = abort;
      if (showLoading) setOptionsLoading(true);
      try {
        const data = await request<DevelopmentOptions>("options", undefined, abort.signal);
        if (disposed || abort.signal.aborted) return;
        const previous = optionsRef.current;
        if (previous)
          for (const prefix of obsoleteCatalogDraftPrefixes(previous, data))
            clearTaskDrafts(prefix);
        const active = pinned.current;
        if (active && previous) {
          const before = developmentEditorAccess(mode, selection, previous, can, active.options);
          const after = developmentEditorAccess(mode, selection, data, can, active.options);
          if (!after.allowed || before.key !== after.key) pinned.current = null;
        }
        const matches =
          localDevelopment || (authority !== null && data.contextAuthority === authority);
        if (!matches) {
          if (previous) clearTaskDrafts(catalogDraftScope(previous));
          pinned.current = null;
          setOptionsError("当前身份已变化 正在重新核对访问范围");
        }
        if (matches) setOptionsError("");
        optionsRef.current = data;
        setOptions(data);
        setOptionsUsable(matches);
      } catch (error) {
        if (disposed || abort.signal.aborted) return;
        setOptionsUsable(false);
        if (error instanceof DevelopmentRequestError && [401, 403, 404].includes(error.status)) {
          if (optionsRef.current) clearTaskDrafts(catalogDraftScope(optionsRef.current));
          optionsRef.current = null;
          pinned.current = null;
          setOptions(null);
          setFormState(cleanState);
        }
        setOptionsError(error instanceof Error ? error.message : "暂时无法核对访问范围 请刷新重试");
      } finally {
        if (!disposed && !abort.signal.aborted) setOptionsLoading(false);
      }
    }
    void read(true);
    const recheck = () => {
      if (document.visibilityState !== "hidden") void read();
    };
    const observe = requestedEditing || recordId !== null || selected !== null;
    const timer = observe ? window.setInterval(recheck, 30_000) : undefined;
    if (observe) {
      window.addEventListener("focus", recheck);
      document.addEventListener("visibilitychange", recheck);
    }
    return () => {
      disposed = true;
      pending?.abort();
      if (timer !== undefined) window.clearInterval(timer);
      window.removeEventListener("focus", recheck);
      document.removeEventListener("visibilitychange", recheck);
    };
  }, [
    refresh,
    mode,
    authority,
    localDevelopment,
    requestedEditing,
    recordId,
    selected,
    requestKey,
  ]);
  useEffect(() => {
    if (mode !== "development") {
      setWorkspaceLoading(false);
      return;
    }
    const abort = new AbortController();
    setWorkspaceLoading(true);
    void request<WorkspaceData>(
      `workspace?${new URLSearchParams({ q, status, page: String(page) })}`,
      undefined,
      abort.signal,
    )
      .then((data) => {
        if (!abort.signal.aborted) setWorkspace(data);
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!abort.signal.aborted) setWorkspaceLoading(false);
      });
    return () => abort.abort();
  }, [q, status, page, workspaceRefresh, mode]);

  async function mutate(path: string, body: Record<string, unknown>, message: string) {
    if (!ready || mutationPending.current) return false;
    mutationPending.current = true;
    const origin = viewRef.current;
    const currentView = () => mounted.current && viewRef.current === origin;
    setBusy(true);
    setError("");
    setNotice("");
    const key = JSON.stringify({ path, body });
    const idempotencyKey = retry.current.get(key) ?? crypto.randomUUID();
    retry.current.set(key, idempotencyKey);
    try {
      const result = await request<{
        spu?: DevelopmentOptions["spus"][number];
        artwork?: ArtworkView;
      }>(path, { ...body, idempotencyKey });
      retry.current.delete(key);
      if (mounted.current) {
        setRefresh((value) => value + 1);
        setWorkspaceRefresh((value) => value + 1);
      }
      if (!currentView()) return true;
      updateSearch({ ...closedForm, ...(result.spu ? { spu: result.spu.id } : {}) });
      setFormState(cleanState);
      setNotice(message);
      return true;
    } catch (e) {
      if (currentView()) setError(e instanceof Error ? e.message : "保存失败");
      return false;
    } finally {
      mutationPending.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  const title =
    mode === "artwork" ? "印花库" : mode === "specification" ? "商品库" : "销售 SKU 与资料包";
  const subtitle =
    mode === "artwork"
      ? "管理固定印花与来图定制方案，保存素材包和制作规则，同一印花可以用于多个产品。"
      : mode === "specification"
        ? "先创建商品 SPU，确认工艺、规格、重量和可定制范围，再建立定制或标品销售方案。"
        : "组合印花与产品规格，跟进销售 SKU 的制作、套图和渠道资料包。";
  const formTitle =
    compose || mode === "development"
      ? "组合生成销售 SKU"
      : editingSpu
        ? "编辑 SPU 基础信息"
        : mode === "artwork"
          ? artwork
            ? "修改印花 · 保存为新版本"
            : "登记印花"
          : specVersion
            ? "修改规格 · 创建新版本"
            : "新增 SPU";
  const detailTitle =
    mode === "specification"
      ? selectedSpu
        ? `${selectedSpu.code} · ${selectedSpu.name}`
        : "SPU 详情"
      : artwork
        ? `${artwork.code} · ${artwork.name}`
        : "印花详情";
  const formKey = editorKey;
  const feedback = (
    <>
      {(error || optionsError) && (
        <p role="alert" className="oc-error">
          {error || optionsError}
        </p>
      )}
      {notice && (
        <p role="status" className="oc-notice">
          {notice}
        </p>
      )}
    </>
  );
  return (
    <main className="oc-page pd-page" aria-busy={loading}>
      <WorkflowReturnLink className="oc-button" label="返回原任务" />
      <header className="oc-header">
        <div>
          <h1>{batchEditing ? "批量绑定规格" : title}</h1>
          <p>{subtitle}</p>
        </div>
        <div className="oc-actions">
          {batchEditing ? (
            <button
              className="oc-button"
              disabled={busy}
              onClick={() => {
                if (mayLeaveBatch()) open(closedForm, false);
              }}
            >
              返回 SPU 详情
            </button>
          ) : (
            <>
              <button
                className="oc-button"
                disabled={loading || busy}
                onClick={() => {
                  setError("");
                  setRefresh((value) => value + 1);
                  setWorkspaceRefresh((value) => value + 1);
                }}
              >
                <RefreshCw size={15} />
                刷新
              </button>
              {canEditMode && (
                <button
                  className="oc-button primary"
                  disabled={!ready || busy}
                  onClick={() =>
                    open({
                      ...closedForm,
                      form: "1",
                      spu: null,
                      artwork: null,
                      ...(mode === "development" ? { compose: "1" } : {}),
                    })
                  }
                >
                  <Plus size={15} />
                  {mode === "artwork"
                    ? "登记印花"
                    : mode === "specification"
                      ? "新增 SPU"
                      : "组合生成 SKU"}
                </button>
              )}
            </>
          )}
        </div>
      </header>
      {!canWrite && (
        <p className="oc-hint" role="status">
          当前账户只读 可查看商品与规格
        </p>
      )}
      {mode === "artwork" && canWrite && !canRegisterArtwork && (
        <p className="oc-hint" role="status">
          登记和修改印花需要印花审核权限
        </p>
      )}
      <nav className="pd-flow" aria-label="商品开发流程">
        <Link href="/product-specifications">1. 商品 SPU</Link>
        <span>→</span>
        <Link href="/sales-plans?step=1">2. 市场调研</Link>
        <span>→</span>
        <Link href="/sales-plans?step=2">3. 图文与设计</Link>
        <span>→</span>
        <Link href="/listings">4. 刊登与上架</Link>
      </nav>
      {(!drawerOpen || !options) && feedback}
      {!ready && (
        <p role="status">
          {optionsLoading ? "正在核对商品访问范围…" : "暂时无法核对访问范围 请刷新后继续"}
        </p>
      )}
      {batchEditing && formOptions && spuId && (
        <section hidden={!ready} inert={!ready} style={!ready ? { display: "none" } : undefined}>
          <DevelopmentDrawerForm key={formKey} busy={busy || !ready} onStateChange={setFormState}>
            <SpecificationBatchForm
              options={formOptions}
              spuId={spuId}
              busy={busy || !ready}
              onSave={(body) => mutate("specifications/batch", body, "所选规格已绑定到当前 SPU")}
            />
          </DevelopmentDrawerForm>
        </section>
      )}
      <div
        hidden={batchEditing || !ready}
        inert={!ready}
        style={!ready ? { display: "none" } : undefined}
        data-development-list
      >
        <form
          className="oc-actions pd-filters"
          onSubmit={(e: FormEvent<HTMLFormElement>) => {
            e.preventDefault();
            updateSearch({ q: String(new FormData(e.currentTarget).get("q") ?? ""), page: "1" });
          }}
        >
          <label className="pd-search">
            <Search size={16} />
            <input
              name="q"
              aria-label="搜索编号或名称"
              defaultValue={q}
              key={q}
              placeholder="搜索编号、名称或规格"
            />
          </label>
          <button className="oc-button">搜索</button>
          {mode === "artwork" && (
            <select
              aria-label="印花状态"
              value={showArchivedArt ? "archived" : "active"}
              onChange={(e) =>
                updateSearch({ archived: e.target.value === "archived" ? "1" : null })
              }
            >
              <option value="active">使用中的印花</option>
              <option value="archived">已归档（可恢复）</option>
            </select>
          )}
          {mode === "development" && (
            <select
              aria-label="开发状态"
              value={status}
              onChange={(e) =>
                updateSearch({
                  status: e.target.value === "all" ? null : e.target.value,
                  page: "1",
                })
              }
            >
              {Object.entries(statuses).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          )}
        </form>
        {!options ? (
          <p role="status">{loading ? "正在读取…" : "资料暂不可用，请检查连接与权限后刷新。"}</p>
        ) : (
          <>
            {loading && <p role="status">正在更新列表…</p>}
            {mode === "artwork" && (
              <ArtworkTable
                items={filteredArt}
                options={options}
                selected={targetArtwork}
                archived={showArchivedArt}
                busy={busy}
                onOpen={(item) => selectRecord(item.id)}
                onEdit={(item) =>
                  selectRecord(item.id, { form: "1", artworkVersionId: item.versionId })
                }
                onCompose={composeArtwork}
                onArchive={(item) =>
                  void mutate(
                    `artworks/${item.id}/archive`,
                    {
                      archived: !showArchivedArt,
                      expectedVersion: item.version,
                      reason: showArchivedArt
                        ? "从印花库恢复使用"
                        : "从日常印花库归档，保留历史版本与关联",
                    },
                    showArchivedArt ? "印花已恢复" : "印花已归档，可在已归档列表恢复",
                  )
                }
              />
            )}
            {mode === "specification" && (
              <SpuTable items={filteredSpus} options={options} onOpen={(id) => selectRecord(id)} />
            )}
            {mode === "development" && workspace && (
              <>
                <div className="oc-actions">
                  <button
                    className="oc-button"
                    disabled={loading || !workspace.items.length}
                    onClick={() => selectSku(workspace.items[0]!.skuId)}
                  >
                    连续处理 SKU
                  </button>
                </div>
                <SalesSkuTable workspace={workspace} onOpen={selectSku} />
                <footer className="oc-pagination">
                  <span>
                    共 {workspace.total} 个 SKU · 第 {page} 页
                  </span>
                  <div className="oc-actions">
                    <button
                      className="oc-button"
                      disabled={loading || page === 1}
                      onClick={() => updateSearch({ page: String(page - 1) })}
                    >
                      上一页
                    </button>
                    <button
                      className="oc-button"
                      disabled={loading || page * workspace.pageSize >= workspace.total}
                      onClick={() => updateSearch({ page: String(page + 1) })}
                    >
                      下一页
                    </button>
                  </div>
                </footer>
              </>
            )}
          </>
        )}
      </div>
      {selected && mode === "development" && ready && options && (
        <SalesSkuPanel
          key={`${selected}:${options.contextAuthority}`}
          skuId={selected}
          options={options}
          queue={skuQueue}
          onSelect={selectSku}
          onBack={() => selectSku(null)}
          onChanged={() => setWorkspaceRefresh((value) => value + 1)}
        />
      )}
      {drawerOpen && options && (
        <TaskDrawer
          className="pd-page"
          title={!ready ? "核对商品访问范围" : editing ? formTitle : detailTitle}
          contentUnavailable={!ready}
          recordKey={editing ? formKey : (recordId ?? "new")}
          state={state}
          description={
            !editing && recordIndex >= 0
              ? `本页 ${recordIndex + 1} / ${recordQueue.length}`
              : undefined
          }
          onClose={closeDrawer}
          closeLabel={`返回${title}列表`}
          previous={
            !editing && recordId
              ? {
                  label: "上一条",
                  action:
                    recordIndex > 0 ? () => selectRecord(recordQueue[recordIndex - 1]!) : undefined,
                }
              : undefined
          }
          next={
            !editing && recordId
              ? {
                  label: "下一条",
                  action:
                    recordIndex >= 0 && recordIndex < recordQueue.length - 1
                      ? () => selectRecord(recordQueue[recordIndex + 1]!)
                      : undefined,
                }
              : undefined
          }
        >
          {feedback}
          {requestedEditing && !editing && (
            <p role="alert">{editor?.message || "当前访问范围无法核对 请刷新后继续"}</p>
          )}
          {editing && formOptions ? (
            <DevelopmentDrawerForm key={formKey} busy={busy || !ready} onStateChange={setFormState}>
              {(specVersion && !formSpec) ||
              (editingSpu && !formSpu) ||
              (mode === "artwork" && artworkVersionId && !formArtwork && !compose) ? (
                <p role="alert">要编辑的资料当前不可用，请关闭后刷新列表。</p>
              ) : compose || mode === "development" ? (
                <CombinationForm
                  options={formOptions}
                  initialArtworkVersionId={artworkVersionId ?? undefined}
                  busy={busy || !ready}
                  onSave={(body) =>
                    mutate("combinations", body, "销售 SKU 已生成，可在产品开发中继续制作")
                  }
                />
              ) : mode === "artwork" ? (
                <ArtworkForm
                  options={formOptions}
                  value={formArtwork}
                  busy={busy || !ready}
                  onSave={(body) => mutate("artworks", body, "印花版本已登记，可进入产品组合")}
                />
              ) : editingSpu && formSpu ? (
                <SpuForm
                  value={formSpu}
                  busy={busy || !ready}
                  onSave={(body) =>
                    mutate(`spus/${formSpu.id}`, body, "SPU 基础信息已保存，规格与 SKU 关联保留")
                  }
                />
              ) : formSpec ? (
                <SpecificationForm
                  options={formOptions}
                  value={formSpec}
                  initialSpuId={spuId ?? undefined}
                  busy={busy || !ready}
                  onSave={(body) =>
                    mutate("specifications", body, "规格版本已保存，历史 SKU 保留原版本")
                  }
                />
              ) : (
                <SpuForm
                  busy={busy || !ready}
                  onSave={(body) => mutate("spus", body, "SPU 已建立，请添加这个产品的规格")}
                />
              )}
            </DevelopmentDrawerForm>
          ) : mode === "specification" && spuId ? (
            <SpuDetailPanel
              key={`${spuId}:${options.contextAuthority ?? "legacy"}`}
              options={options}
              spuId={spuId}
              busy={busy || optionsLoading}
              onEdit={() => open({ editSpu: "1" })}
              onBind={() => open({ form: "1" })}
              onSpecification={(item) =>
                open({ form: "1", specificationVersionId: item.versionId })
              }
            />
          ) : artwork ? (
            <section aria-label={`${artwork.name} 制作说明与素材`}>
              {artwork.assetId && (
                <Image
                  unoptimized
                  className="pd-artwork-detail-image"
                  src={`/api/product-development/assets/${artwork.assetId}/preview`}
                  alt={artwork.name}
                  width={420}
                  height={420}
                />
              )}
              <p>
                {modes[artwork.mode]} · V{artwork.version} · {artwork.tags.join(" / ")}
              </p>
              <h3>制作说明</h3>
              <p className="pd-artwork-notes">{artwork.instructions || "尚未填写制作说明"}</p>
              <h3>附加素材（{artwork.materials.length}）</h3>
              {artwork.materials.map((material) => (
                <p key={material.assetId}>
                  {material.usage} · {material.fileName} · V{material.assetVersion}
                </p>
              ))}
              {!artwork.materials.length && <p>尚无附加素材；顾客原图由订单提供。</p>}
              {!showArchivedArt && canWrite && (
                <TaskDrawerActions>
                  {canAll([Permission.ProductWrite, Permission.DesignReview], {
                    ownerId: artwork.ownerUserId,
                    teamId: artwork.teamId,
                  }) && (
                    <button
                      className="oc-button"
                      onClick={() =>
                        selectRecord(artwork.id, { form: "1", artworkVersionId: artwork.versionId })
                      }
                    >
                      修改印花
                    </button>
                  )}
                  <button className="oc-button primary" onClick={() => composeArtwork(artwork)}>
                    组合商品
                  </button>
                </TaskDrawerActions>
              )}
            </section>
          ) : (
            <p role="alert">此印花当前不可用，请关闭详情后刷新列表。</p>
          )}
        </TaskDrawer>
      )}
    </main>
  );
}
