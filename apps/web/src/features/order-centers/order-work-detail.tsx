"use client";
import { OrderLifecycleProgress } from "./order-lifecycle";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Plus, Save, Send, Upload, X } from "lucide-react";
import { orderOperatorTask } from "@yummyai/contracts/order/workbench";
import {
  OrderWorkDetailViewSchema,
  type OrderWorkDetail,
  type OrderWorkDraft,
  type OrderWorkspaceModule,
  type OrderCenterOptions,
  type OrderWorkActionInput,
} from "@yummyai/contracts/order/workspace";
import {
  ProductionEditorDetailViewSchema,
  type ProductionEditorDetailView,
} from "@yummyai/contracts/pod/production-editor-api";
import { AmazonReportDetail } from "../orders/amazon-report-workspace";
import { ProductionEditorSession } from "../production-editor/production-editor-session";
import type { ProductionEditorFocus } from "../production-editor/production-editor-workspace";
import { OrderOperationsPanel } from "./order-operations-panel";
import { OrderPlatformDeadline } from "./order-platform-deadline";
import { OrderDesignAgentPanel } from "./order-design-agent-panel";
import { getProductionProductDefinition, productionExportDefaults } from "@yummyai/production-editor/products";
import { AssistPanel } from "../ai-assist/assist-panel";
import { adoptOrderMatch } from "../ai-assist/assist-adoption";
import { OrderArtworkBasis, OrderArtworkMaterials } from "./order-artwork-basis";
import { OrderTemplatePlanPanel } from "./order-template-plan";
import { OrderIntakeCheckPanel } from "./order-intake-check";
import { OrderWorkImageBinding } from "./order-work-image-binding";
import { defaultOrderImageUsage, orderImageBindingField, orderImageSelectionProblem, orderSingleChoiceOptions } from "./order-work-input-model";
import { OrderArtworkProgress } from "./order-artwork-progress";
import { OrderArtworkReview } from "./order-artwork-review";
import { artworkPreviewPending } from "./order-artwork-review-model";
import { useWorkflowReturn } from "../navigation/use-workflow-return";
import { useInTaskDrawer } from "../navigation/task-drawer";
import { centerRequest, centers, dateTime, fileBase64, label } from "./order-center-model";
import "../orders/amazon-report-workspace.css";
import "./order-centers.css";
import "../product-development/artwork-workflow.css";

export type OrderReviewState = { dirty: boolean; busy: boolean; loading: boolean };

export function OrderWorkDetailPanel({
  id,
  module,
  options,
  editorOpen,
  onBack,
  onEditor,
  onChanged,
  review,
  inline = false,
  onStateChange,
  onModuleChange,
  unified = false,
  onSelectItem,
  refreshToken = 0,
}: {
  id: string;
  module: OrderWorkspaceModule;
  options: OrderCenterOptions | null;
  editorOpen: boolean;
  onBack: () => void;
  onEditor: (open: boolean) => void;
  onChanged: () => void;
  inline?: boolean;
  unified?: boolean;
  onSelectItem?: (id: string, module: OrderWorkspaceModule) => void;
  refreshToken?: number;
  onStateChange?: (state: OrderReviewState) => void;
  onModuleChange?: (module: OrderWorkspaceModule) => void;
  review?: {
    hasNext: boolean;
    onSavedNext: () => void;
    onNext: () => void;
    autoAdvance?: boolean;
    onStateChange: (state: OrderReviewState) => void;
  };
}) {
  const inDrawer = useInTaskDrawer();
  const workflow = useWorkflowReturn();
  const journeyHref = (path: string) => {
    const origin = workflow.back && new URL(workflow.back, "https://erp.invalid");
    return origin && origin.pathname === path && origin.searchParams.get("line") === id
      ? workflow.back!
      : workflow.link(`${path}?line=${id}`);
  };
  const [detail, setDetail] = useState<OrderWorkDetail | null>(null),
    [draft, setDraft] = useState<OrderWorkDraft | null>(null);
  const [editor, setEditor] = useState<ProductionEditorDetailView | null>(null),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false);
  const [editorFocus, setEditorFocus] = useState<ProductionEditorFocus | undefined>();
  const [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [reason, setReason] = useState(""),
    [artworkReason, setArtworkReason] = useState(""),
    [refresh, setRefresh] = useState(0);
  const imageInput = useRef<HTMLInputElement>(null),
    requests = useRef(new Map<string, string>());
  const [operationState, setOperationState] = useState<OrderReviewState>({
    dirty: false,
    busy: false,
    loading: false,
  });
  const [advanceOperation, setAdvanceOperation] = useState(false);
  const [deadlineState, setDeadlineState] = useState<OrderReviewState>({ dirty: false, busy: false, loading: false });
  const [agentState, setAgentState] = useState({ workItemId: id, busy: false, blocked: false, checking: true });
  const [pendingAgentRefresh, setPendingAgentRefresh] = useState<string | null>(null);
  const [advanceArtwork, setAdvanceArtwork] = useState(review?.autoAdvance ?? false);
  const [reviewFooter, setReviewFooter] = useState<HTMLDivElement | null>(null);
  const [artworkToolsOpen, setArtworkToolsOpen] = useState(false);
  const draftDirty = !!draft && !!detail && JSON.stringify(draft) !== JSON.stringify(detail.draft);
  const customizationFields = detail?.catalog?.artworks.find(
    art => art.id === draft?.artworkVersionId,
  )?.customization.fields ?? [];
  const textCustomizationFields = customizationFields.filter(field => field.type !== "image");
  const otherUnsaved = useRef(false);
  otherUnsaved.current = draftDirty || !!reason.trim() || !!artworkReason.trim() || deadlineState.dirty;
  const dirty = draftDirty || !!reason.trim() || !!artworkReason.trim() || operationState.dirty || deadlineState.dirty;
  const navigationBusy = busy || operationState.busy || deadlineState.busy || agentState.workItemId === id && agentState.busy;
  const navigationLoading = loading || operationState.loading;
  const agentApplies = (module === "orders" || module === "artwork") && detail?.line.preparation === "pushed";
  const agentArtworkBlocked = agentApplies && (agentState.workItemId !== id || agentState.blocked || agentState.checking);
  const editable =
    module === "orders" && detail?.line.preparation !== "pushed" && !detail?.line.held;
  const onReviewStateChange = review?.onStateChange ?? onStateChange;
  const Container = review || inline ? "section" : "main";
  useEffect(() => {
    onReviewStateChange?.({ dirty, busy: navigationBusy, loading: navigationLoading });
  }, [dirty, navigationBusy, navigationLoading, onReviewStateChange]);
  useEffect(() => {
    if (pendingAgentRefresh === null) return;
    if (pendingAgentRefresh !== id) { setPendingAgentRefresh(null); return; }
    // Completion and POST acknowledgements may arrive while notes are dirty or
    // another operation is committing. Refresh once those edits are safe.
    if (dirty || navigationBusy || navigationLoading || editorOpen) return;
    setPendingAgentRefresh(null);
    setRefresh(value => value + 1);
  }, [pendingAgentRefresh, id, dirty, navigationBusy, navigationLoading, editorOpen]);
  useEffect(() => {
    const abort = new AbortController();
    setLoading(true);
    setError("");
    setEditor(null);
    void centerRequest(`lines/${id}`, undefined, abort.signal)
      .then(async (value) => {
        const next = OrderWorkDetailViewSchema.parse(value);
        if (abort.signal.aborted) return;
        setDetail(next);
        setDraft(structuredClone(next.draft));
        if (next.line.editorProjectId && (!inline || module === "artwork")) {
          const response = await fetch(
            `/api/production-editor/projects/${next.line.editorProjectId}`,
            { cache: "no-store", signal: abort.signal },
          );
          if (!response.ok) throw new Error("关联生产文件暂时无法读取");
          const file = ProductionEditorDetailViewSchema.parse(await response.json());
          if (!abort.signal.aborted) setEditor(file);
        } else setEditor(null);
      })
      .catch((cause) => {
        if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : "读取失败");
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [id, refresh, refreshToken, editorOpen, inline, module]);
  useEffect(() => {
    if (
      editorOpen ||
      !editor?.renders.some((render) => ["queued", "processing"].includes(render.status))
    )
      return;
    const abort = new AbortController();
    const timer = setInterval(() => {
      void fetch(`/api/production-editor/projects/${editor.project.id}`, {
        cache: "no-store",
        signal: abort.signal,
      })
        .then(async (response) => {
          if (!response.ok) return;
          const next = ProductionEditorDetailViewSchema.parse(await response.json());
          if (!abort.signal.aborted) setEditor(next);
        })
        .catch(() => {});
    }, 2500);
    return () => {
      abort.abort();
      clearInterval(timer);
    };
  }, [editor, editorOpen]);
  useEffect(() => {
    if (inDrawer || (!dirty && !navigationBusy)) return;
    function guard(event: BeforeUnloadEvent) {
      event.preventDefault();
      event.returnValue = "";
    }
    function linkGuard(event: MouseEvent) {
      if (
        event.target instanceof Element &&
        event.target.closest("a[href]") &&
        (navigationBusy || !window.confirm("有未保存的修改，确定离开？"))
      ) {
        event.preventDefault();
        event.stopPropagation();
      }
    }
    window.addEventListener("beforeunload", guard);
    document.addEventListener("click", linkGuard, true);
    return () => {
      window.removeEventListener("beforeunload", guard);
      document.removeEventListener("click", linkGuard, true);
    };
  }, [dirty, navigationBusy, inDrawer]);
  function requestKey(payload: unknown) {
    const signature = JSON.stringify(payload),
      key = requests.current.get(signature) ?? crypto.randomUUID();
    requests.current.set(signature, key);
    return key;
  }
  function update(next: OrderWorkDetail) {
    setDetail(next);
    setDraft(structuredClone(next.draft));
    onChanged();
  }
  async function save(
    status: "pending_review" | "needs_information" | "ready_to_push",
    advance = false,
  ) {
    if (!detail || !draft || navigationBusy || loading) return;
    if (deadlineState.dirty) { setError("请先保存平台交期核对，再保存制作需求。"); return; }
    const imageProblem = orderImageSelectionProblem(customizationFields, draft.images);
    if (imageProblem) { setError(imageProblem); return; }
    setBusy(true);
    setError("");
    setNotice("");
    const payload = {
      expectedRevision: detail.line.revision,
      expectedProjectionVersion: detail.line.projectionVersion,
      expectedSourceVersionId: detail.report?.versionId ?? null,
      draft,
      status,
      reason: reason.trim() || "运营更新订单制作需求",
    };
    try {
      update(
        OrderWorkDetailViewSchema.parse(
          await centerRequest(`lines/${id}/draft`, {
            ...payload,
            idempotencyKey: requestKey(payload),
          }),
        ),
      );
      setNotice(status === "ready_to_push" ? "审单已保存，可以推送制图。" : "草稿已保存。");
      setReason("");
      if (advance) review?.onSavedNext();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }
  async function action(action: OrderWorkActionInput["action"], advance = false) {
    if (!detail || navigationBusy || navigationLoading) return;
    if (agentArtworkBlocked && ["start_artwork", "submit_artwork", "approve_artwork", "reject_artwork", "approve_proof", "reject_proof"].includes(action)) {
      setError("请先核对自动制作状态；制作中的任务需先停止并接管，再编辑或审核。");
      return;
    }
    if (detail.line.archivedAt) {
      setError("订单已归档，请先恢复记录。");
      return;
    }
    if (draftDirty || operationState.dirty || deadlineState.dirty) {
      setError("请先保存当前修改，再执行流转操作。");
      return;
    }
    const actionReason = action === "reject_artwork" ? artworkReason.trim() : reason.trim();
    if (
      ["recall", "reject_artwork", "approve_proof", "reject_proof", "hold"].includes(action) &&
      !actionReason
    ) {
      setError("请填写操作原因或客户确认依据。");
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    const payload = {
      action,
      expectedRevision: detail.line.revision,
      expectedProjectionVersion: detail.line.projectionVersion,
      reason: actionReason || label(action),
      ...(["submit_artwork", "approve_artwork", "reject_artwork", "approve_proof", "reject_proof"].includes(action)
        ? { expectedEditorVersionId: editor?.version.id }
        : {}),
    };
    try {
      const next = OrderWorkDetailViewSchema.parse(
        await centerRequest(`lines/${id}/actions`, {
          ...payload,
          idempotencyKey: requestKey(payload),
        }),
      );
      update(next);
      setNotice(action === "approve_artwork" ? "审核已通过，系统会自动准备生产文件。你可以继续审核下一单。" : `${label(action)}已记录。`);
      setReason("");
      setArtworkReason("");
      setRefresh((value) => value + 1);
      if (action === "start_artwork") openEditor();
      else if (advance) review?.onSavedNext();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "操作失败");
    } finally {
      setBusy(false);
    }
  }
  async function archive(archived: boolean) {
    if (!detail || navigationBusy || navigationLoading || draftDirty || operationState.dirty || deadlineState.dirty)
      return;
    if (!reason.trim()) {
      setError("请填写归档或恢复原因。");
      return;
    }
    const payload = {
      archived,
      expectedProjectionVersion: detail.line.projectionVersion,
      reason: reason.trim(),
    };
    setBusy(true);
    setError("");
    try {
      update(
        OrderWorkDetailViewSchema.parse(
          await centerRequest(`lines/${id}/archive`, {
            ...payload,
            idempotencyKey: requestKey(payload),
          }),
        ),
      );
      setNotice(
        archived
          ? "已归档并暂停，从正常订单队列移除；历史记录保留。"
          : "已恢复到列表，仍保持暂停，可核对后解除暂停。",
      );
      setReason("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "归档操作失败");
    } finally {
      setBusy(false);
    }
  }
  async function upload(file: File) {
    if (!detail || !detail.line.revision) {
      setError("请先保存草稿，再上传订单图片。");
      return;
    }
    if (dirty) {
      setError("请先保存修改，再上传图片。");
      return;
    }
    if (file.size > 32 * 1024 * 1024) {
      setError("图片最大 32 MiB。");
      return;
    }
    setBusy(true);
    setError("");
    try {
      update(
        OrderWorkDetailViewSchema.parse(
          await centerRequest(`lines/${id}/images`, {
            name: file.name,
            contentBase64: await fileBase64(file),
          }),
        ),
      );
      setNotice("图片已上传，请选中它并核对对应图片字段或制作用途，然后保存。");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "上传失败");
    } finally {
      setBusy(false);
      if (imageInput.current) imageInput.current.value = "";
    }
  }
  async function renderProduction(purpose: "production" | "preview" = "production") {
    if (
      !editor ||
      navigationBusy ||
      navigationLoading ||
      agentArtworkBlocked ||
      (purpose === "preview" && artworkPreviewPending(editor))
    )
      return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/production-editor/projects/${editor.project.id}/renders`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedVersionId: editor.version.id,
          ...(purpose === "production" ? productionExportDefaults(editor.version.document) : { format: "png", background: editor.version.document.exportBackground }),
          purpose,
          ...(purpose === "preview" ? { previewFullResolution: true } : {}),
        }),
      });
      if (!response.ok) {
        const failure = await response.json().catch(() => null) as { message?: unknown } | null;
        throw new Error(typeof failure?.message === "string" ? failure.message : "生产文件未生成，请由制图人员检查预检结果后重试。");
      }
      setNotice(
        `${purpose === "preview" ? "当前版本预览" : "正式生产文件"}生成任务已提交，结果会自动更新。`,
      );
      setRefresh((value) => value + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "出图失败");
    } finally {
      setBusy(false);
    }
  }
  function openEditor() {
    openEditorAt();
  }
  function openEditorAt(focus?: ProductionEditorFocus) {
    if (agentArtworkBlocked || navigationBusy || navigationLoading) {
      setError("请先核对自动制作状态；制作中的任务需先停止并接管，再打开生产文件。");
      return;
    }
    setEditorFocus(focus);
    onEditor(true);
  }
  if (editorOpen && detail?.line.editorProjectId && !agentArtworkBlocked)
    return (
      <ProductionEditorSession
        title={`${detail.line.externalOrderId} · 制作需求 V${detail.line.revision}`}
        subtitle={`${detail.line.printSku ?? ""} · 素材按运营确认的用途列在素材面板中`}
        returnLabel="返回制图任务"
        projectId={detail.line.editorProjectId}
        initialFocus={editorFocus}
        context={
          <div className="oc-effective-requirements">
            <p>{detail.draft.instructions || "无额外制作说明"}</p>
            {detail.draft.fields.map((field) => (
              <p key={field.key}>
                <strong>{field.label}：</strong>
                {field.value}
                {field.font ? ` · 字体 ${field.font}` : ""}
                {field.color ? ` · 颜色 ${field.color}` : ""}
              </p>
            ))}
          </div>
        }
        onClose={() => {
          setLoading(true);
          onEditor(false);
          setRefresh((value) => value + 1);
        }}
      />
    );
  if (!detail || !draft)
    return (
      <Container className={review ? "oc-page oc-review-loading" : "oc-page"}>
        {!review && !inline && (
          <button className="oc-button" onClick={onBack}>
            <ArrowLeft size={16} />
            返回{centers[module].title}
          </button>
        )}
        {error ? (
          <>
            <p className="oc-error" role="alert">
              {error}
            </p>
            <button
              className="oc-button"
              disabled={loading}
              onClick={() => setRefresh((value) => value + 1)}
            >
              重试读取
            </button>
            {module==="artwork"&&<OrderDesignAgentPanel key={id} workItemId={id} refreshKey={refresh} disabled financialOnly onChanged={()=>{}} onStateChange={()=>{}} />}
          </>
        ) : (
          <p role="status">正在读取订单资料…</p>
        )}
      </Container>
    );
  const reportImages =
    detail.line.preparation === "pushed"
      ? detail.draft.images.flatMap((image, index) =>
          image.origin === "report"
            ? [
                {
                  origin: "report" as const,
                  key: image.key,
                  name: `${image.usage} · 推送时原图`,
                  path: `/api/order-centers/lines/${id}/report-images/${index}?revision=${detail.line.revision}`,
                },
              ]
            : [],
        )
      : (detail.report?.files
          .filter((file) => file.role === "buyer_image")
          .map((file) => ({
            origin: "report" as const,
            key: file.key,
            name:
              detail
                .report!.files.find((original) => original.key === file.originalFileKey)
                ?.name.split("/")
                .at(-1) ?? file.name,
            path: `/api/orders/reports/lines/${detail.report!.line.id}/files/${encodeURIComponent(file.key)}?versionId=${detail.report!.versionId}`,
          })) ?? []);
  const images = [
    ...reportImages,
    ...detail.assets.map((asset) => ({
      origin: "upload" as const,
      key: asset.id,
      name: asset.name,
      path: asset.path,
    })),
  ];
  const profiles = options?.profiles ?? [],
    historical =
      detail.profile && !profiles.some((profile) => profile.versionId === detail.profile!.versionId)
        ? [detail.profile]
        : [];
  return (
    <Container
      className={
        review ? "oc-page oc-review-detail" : inline ? "oc-page oc-inline-detail" : "oc-page"
      }
      aria-busy={busy || loading}
    >
      <div className={review ? "oc-review-body" : undefined}>
        <header className="oc-header">
          <div>
            {!review && !inline && (
              <button
                className="oc-text-button"
                onClick={() => {
                  if (!dirty || window.confirm("有未保存的修改，确定返回列表？")) onBack();
                }}
              >
                <ArrowLeft size={15} />
                返回{centers[module].title}
              </button>
            )}
            {unified ? <h2>{centers[module].title} · 本件 {detail.line.quantity} 件</h2> : inline ? <h2>编辑本件商品</h2> : <h1>{detail.line.externalOrderId}</h1>}
            <p>
              {detail.line.storeName} · {detail.line.skuCode ?? "未提供 SKU"} ·{" "}
              {detail.line.quantity} 件
            </p>
          </div>
          <button
            className="oc-button"
            disabled={navigationBusy || dirty}
            onClick={() => setRefresh((value) => value + 1)}
          >
            刷新状态
          </button>
        </header>
        {!inline && <p className="oc-detail-title">{detail.line.title}</p>}
        {!inline && !unified && <OrderLifecycleProgress status={detail.line.orderStatus} />}
        {!inline && !unified && <div className="oc-current-task" aria-label="当前任务">
          <strong>{orderOperatorTask(detail.line).title}</strong>
          <span>负责岗位：{orderOperatorTask(detail.line).owner}</span>
          <p>{orderOperatorTask(detail.line).description}</p>
        </div>}
        {!unified && <details className="oc-other-stages">
          <summary>查看制作、生产和发货记录</summary>
        <nav className="oc-journey" aria-label="此订单各环节">
          {workflow.back && <Link href={workflow.back}>返回来源订单队列</Link>}
          {([
            ["orders", "/orders", `审单：${label(detail.line.preparation)}`],
            ["artwork", "/order-artwork", `制图：${label(detail.line.artwork)}`],
            ["production", "/production", `生产：${label(detail.line.production)}`],
            ["shipments", "/shipments", `发货：${detail.line.shippedQuantity}/${detail.line.quantity}`],
            ["after-sales", "/after-sales", `售后：${detail.line.afterSalesCount} 个待办`],
          ] as const).map(([target, path, text]) => onModuleChange ? <button key={target} className="oc-button"
            aria-current={module === target ? "step" : undefined} disabled={navigationBusy || navigationLoading}
            onClick={() => onModuleChange(target)}>{text}</button> : <Link key={target} href={journeyHref(path)}>{text}</Link>)}
        </nav>
        </details>}
        {detail.line.platform === "amazon" && <OrderPlatformDeadline detail={detail}
          disabled={busy || loading || operationState.busy || operationState.dirty || draftDirty}
          onChanged={(next) => { setDetail(next); onChanged(); }} onStateChange={setDeadlineState} />}
        {detail.line.sourceChanged && (
          <p className="oc-notice">
            新导入资料与当前制作需求的来源版本不同。已保存的需求继续保留，请对照原始资料核对差异。
          </p>
        )}
        {detail.line.held && <p className="oc-error">此订单商品已暂停。原因可在操作历史中查看。</p>}
        {detail.line.archivedAt && (
          <p className="oc-notice">
            此商品已归档，保留原始资料、版本及操作历史。恢复后仍需核对并解除暂停。
          </p>
        )}
        {error && !review && (
          <p role="alert" className="oc-error">
            {error}
          </p>
        )}
        {notice && !review && (
          <p role="status" className="oc-notice">
            {notice}
          </p>
        )}
        {pendingAgentRefresh === id && (dirty || navigationBusy || editorOpen) && <p className="oc-notice" role="status">自动制作状态已有更新，当前备注和修改仍保留。保存或清空修改后，将刷新稿件与审核信息。</p>}
        {module === "artwork" && editor && (
          <OrderArtworkReview
            key={editor.version.id}
            editor={editor}
            detail={detail}
            disabled={navigationBusy || navigationLoading || draftDirty || operationState.dirty || agentArtworkBlocked}
            reason={artworkReason}
            onReason={setArtworkReason}
            onAction={(kind) => void action(kind, advanceArtwork)}
            onPreview={() => void renderProduction("preview")}
            onOpen={openEditor}
            onResolve={openEditorAt}
            advance={advanceArtwork}
            onAdvance={setAdvanceArtwork}
            hasNext={unified ? undefined : review?.hasNext}
            decisionFooter={review?.autoAdvance ? reviewFooter : null}
            onAdvanceAction={(kind) => void action(kind, true)}
          />
        )}
        {agentApplies && (
          <OrderDesignAgentPanel key={id} workItemId={id} refreshKey={detail.line.projectionVersion}
            disabled={navigationBusy || navigationLoading || dirty} onStateChange={state => setAgentState({ ...state, workItemId: id })}
            onChanged={() => { setPendingAgentRefresh(id); onChanged(); }} />
        )}
        {options && !inline && !detail.line.archivedAt && (
          <OrderOperationsPanel
            key={id + ":" + module}
            onSelectItem={onSelectItem}
            refreshToken={refreshToken}
            module={module}
            detail={detail}
            editor={editor}
            onPrepareProduction={() => void renderProduction()}
            loading={loading || busy || deadlineState.busy || deadlineState.dirty || draftDirty}
            options={options}
            onStateChange={setOperationState}
            onCompleted={
              advanceOperation && review
                ? () => {
                    if (!otherUnsaved.current) review.onSavedNext();
                  }
                : undefined
            }
            onChanged={() => {
              setRefresh((value) => value + 1);
              onChanged();
            }}
          />
        )}
        {(module === "orders" || module === "artwork") && (
          <details
            className="oc-section"
            open={artworkToolsOpen}
            onToggle={(event) => {
              setArtworkToolsOpen(event.currentTarget.open);
            }}
          >
            <summary>{module === "artwork" ? "AI 分析与制图工具" : "AI 分析与模板制图"}</summary>
            {!detail.line.archivedAt &&
              artworkToolsOpen && (
                <AssistPanel
                  key={`${id}:${module}`}
                  kind={module === "orders" ? "order_review" : "artwork_preflight"}
                  scope={`order:${id}`}
                  input={
                    module === "orders"
                      ? {
                          kind: "order_review",
                          orderLineId: id,
                          expectedRevision: detail.line.revision,
                          expectedSourceVersionId: detail.report?.versionId ?? null,
                        }
                      : editor && detail.line.revision > 0
                        ? {
                            kind: "artwork_preflight",
                            orderLineId: id,
                            expectedRevision: detail.line.revision,
                            expectedEditorVersionId: editor.project.currentVersionId,
                          }
                        : null
                  }
                  disabledReason={
                    busy
                      ? "请等待当前操作完成"
                      : dirty
                        ? "请先保存订单修改，再基于已保存资料分析"
                        : detail.line.held
                          ? "订单已暂停，请恢复后再分析"
                          : module === "artwork" && (!editor || editorOpen)
                            ? "请先保存并关闭生产文件编辑器，再进行预检"
                            : undefined
                  }
                  onMatch={
                    module === "orders" && editable
                      ? (match) => {
                          try {
                            setDraft(adoptOrderMatch(draft, detail, match));
                            setNotice("已填入匹配候选，请核对后保存需求。");
                            return true;
                          } catch (cause) {
                            setError(cause instanceof Error ? cause.message : "候选填入失败");
                            return false;
                          }
                        }
                      : undefined
                  }
                />
              )}
            {!detail.line.archivedAt &&
              (module === "orders" || (module === "artwork" && artworkToolsOpen)) && (
                <OrderTemplatePlanPanel
                  key={id}
                  id={id}
                  revision={detail.line.revision}
                  sourceVersionId={detail.report?.versionId ?? null}
                  disabled={dirty || busy}
                />
              )}
          </details>
        )}
        <details className="oc-section" open={module === "orders"}>
          <summary className="oc-section-heading">
            <span>
              制作需求 <small>V{detail.line.revision || "未保存"}</small>
            </span>
            {dirty && <span className="oc-badge warning">有未保存修改</span>}
          </summary>
          <fieldset disabled={!editable || navigationBusy} className="oc-fields">
            <OrderArtworkBasis detail={detail} draft={draft} onChange={setDraft}>
            <label>
              通用工艺底稿
              <select
                aria-label="通用工艺底稿"
                disabled={!!draft.salesRecipeVersionId || !!draft.specificationVersionId}
                value={draft.printProfileVersionId ?? ""}
                onChange={(event) =>
                  setDraft({ ...draft, printProfileVersionId: event.target.value || null })
                }
              >
                <option value="">请选择制作依据</option>
                {[...historical, ...profiles].map((profile) => (
                  <option key={profile.versionId} value={profile.versionId}>
                    {profile.code} · {profile.name} · V{profile.versionNumber}
                  </option>
                ))}
              </select>
            </label>
            </OrderArtworkBasis>
            <details className="oc-optional-internal-plan">
              <summary>人工内部计划 可不填
                <small>{draft.dueAt !== detail.line.dueAt ? "有未保存修改" : draft.dueAt ? "已保存人工时间" : "未设置"}</small>
              </summary>
              <div>
                <p>外部工厂履约以平台最晚发货时间跟进 这里仅保留可选人工备注时间 不替代平台截止</p>
                <label>
                  内部计划发货时间
                  <input
                    type="datetime-local"
                    value={draft.dueAt ? localDateTime(draft.dueAt) : ""}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        dueAt: event.target.value ? new Date(event.target.value).toISOString() : null,
                      })
                    }
                  />
                  <small>输入时区 {Intl.DateTimeFormat().resolvedOptions().timeZone} 随本单制作需求保存 留空即可</small>
                </label>
              </div>
            </details>
            <label className="oc-check">
              <input
                type="checkbox"
                checked={draft.customerApprovalRequired}
                onChange={(event) =>
                  setDraft({ ...draft, customerApprovalRequired: event.target.checked })
                }
              />
              需要客户确认校样
            </label>
          </fieldset>
          <OrderArtworkMaterials detail={detail} draft={draft} dirty={dirty} />
          <OrderIntakeCheckPanel key={detail.line.id} detail={detail} draft={draft}
            disabled={busy || navigationBusy || navigationLoading} editable={editable} onChange={setDraft} />
          {detail.profile && (
            <p className="oc-hint">
              当前底稿：{detail.profile.name} ·{" "}
              {getProductionProductDefinition(detail.profile.productType).label}。
              {detail.profile.instructions}
            </p>
          )}
          {!profiles.length && !detail.profile && (
            <p className="oc-hint">
              先在 <Link href={workflow.link("/process-library")}>工艺底稿库</Link>{" "}
              登记经过确认的底稿，再选择制作依据。
            </p>
          )}
          <div className="oc-custom-fields">
            {draft.fields.map((field, index) => {
              const choiceOptions = orderSingleChoiceOptions(customizationFields, field);
              return (
              <fieldset key={field.key} disabled={!editable || navigationBusy} className="oc-custom-field">
                {field.kind !== "image" && textCustomizationFields.length > 0 ? <label>
                  对应定制字段
                  <select aria-label="对应定制字段" value={field.key} onChange={event => {
                    const target = textCustomizationFields.find(item => item.key === event.target.value);
                    if (target) setDraft({ ...draft, fields: draft.fields.map((item, i) => i === index ? { ...item, key: target.key, label: target.label } : item) });
                  }}>
                    {!textCustomizationFields.some(item => item.key === field.key) &&
                      <option value={field.key}>待匹配 · {field.label}</option>}
                    {textCustomizationFields.map(item =>
                      <option key={item.key} value={item.key} disabled={draft.fields.some((other, i) => i !== index && other.key === item.key)}>{item.label} · {item.key}{draft.fields.some((other, i) => i !== index && other.key === item.key && !other.value.trim()) ? " · 已有空白填写项，请先核对" : ""}</option>)}
                  </select>
                </label> : null}
                <label>
                  字段名称
                  <textarea
                    aria-label="字段名称"
                    rows={2}
                    value={field.label}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        fields: draft.fields.map((value, i) =>
                          i === index ? { ...value, label: event.target.value } : value,
                        ),
                      })
                    }
                  />
                </label>
                <label>
                  定制内容
                  {choiceOptions ? <select aria-label="定制内容" value={field.value}
                    onChange={event => setDraft({ ...draft, fields: draft.fields.map((value, i) =>
                      i === index ? { ...value, value: event.target.value } : value) })}>
                    {choiceOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select> : <textarea
                    aria-label="定制内容"
                    rows={2}
                    value={field.value}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        fields: draft.fields.map((value, i) =>
                          i === index ? { ...value, value: event.target.value } : value,
                        ),
                      })
                    }
                  />}
                </label>
                {field.font !== undefined && (
                  <label>
                    字体
                    <input
                      value={field.font}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          fields: draft.fields.map((value, i) =>
                            i === index ? { ...value, font: event.target.value } : value,
                          ),
                        })
                      }
                    />
                  </label>
                )}
                {field.color !== undefined && (
                  <label>
                    颜色
                    <input
                      value={field.color}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          fields: draft.fields.map((value, i) =>
                            i === index ? { ...value, color: event.target.value } : value,
                          ),
                        })
                      }
                    />
                  </label>
                )}
                <button
                  type="button"
                  aria-label={`移除字段 ${field.label}`}
                  className="oc-icon-button"
                  onClick={() =>
                    setDraft({ ...draft, fields: draft.fields.filter((_, i) => i !== index) })
                  }
                >
                  <X size={16} />
                </button>
              </fieldset>
              );
            })}
          </div>
          {editable && (
            <button
              className="oc-button"
              disabled={busy}
              onClick={() =>
                setDraft({
                  ...draft,
                  fields: [
                    ...draft.fields,
                    {
                      key: `operator.${crypto.randomUUID()}`,
                      label: "新增定制信息",
                      kind: "text",
                      value: "",
                    },
                  ],
                })
              }
            >
              <Plus size={15} />
              添加定制字段
            </button>
          )}
          <label className="oc-full-field">
            制作说明
            <textarea
              aria-label="制作说明"
              rows={3}
              disabled={!editable || navigationBusy}
              value={draft.instructions}
              placeholder="说明制作要求、特殊位置、需要保留或去除的内容"
              onChange={(event) => setDraft({ ...draft, instructions: event.target.value })}
            />
          </label>
          <div className="oc-section-heading">
            <h3>订单图片与用途</h3>
            <small>{draft.images.length} 张已选{customizationFields.some(field => field.type === "image")
              ? ` · ${draft.images.filter(image => orderImageBindingField(customizationFields, image.usage)).length} 张已绑定字段` : ""}</small>
            {editable && (
              <button
                className="oc-button"
                disabled={busy || !detail.line.revision || dirty}
                onClick={() => imageInput.current?.click()}
              >
                <Upload size={15} />
                上传定制图片
              </button>
            )}
            <input
              ref={imageInput}
              type="file"
              hidden
              accept="image/png,image/jpeg,image/tiff"
              aria-label="上传订单定制图片"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void upload(file);
              }}
            />
          </div>
          {!images.length && (
            <p className="oc-hint">
              暂时没有可用的订单图片。可先保存草稿后上传，或在导入记录中补传定制 ZIP。
            </p>
          )}
          <div className="oc-image-grid">
            {images.map((image) => {
              const selected = draft.images.find(
                (value) => value.origin === image.origin && value.key === image.key,
              );
              return (
                <div className="oc-image" key={`${image.origin}:${image.key}`}>
                  <img src={image.path} alt={image.name} />
                  <label className="oc-check">
                    <input
                      type="checkbox"
                      disabled={!editable || navigationBusy}
                      checked={!!selected}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          images: event.target.checked
                            ? [
                                ...draft.images,
                                { origin: image.origin, key: image.key, usage: defaultOrderImageUsage(customizationFields) },
                              ]
                            : draft.images.filter(
                                (value) =>
                                  !(value.origin === image.origin && value.key === image.key),
                              ),
                        })
                      }
                    />
                    <span>{image.name}</span>
                  </label>
                  <OrderWorkImageBinding fields={customizationFields} usage={selected?.usage}
                    disabled={!editable || navigationBusy} onChange={usage => setDraft({ ...draft,
                      images: draft.images.map(value => value === selected ? { ...value, usage } : value) })} />
                </div>
              );
            })}
          </div>
        </details>
        <details className="oc-section" open={!review && module !== "artwork" || detail.line.held || detail.line.sourceChanged || detail.line.artwork === "approved" && detail.line.proof !== "not_required"}>
          <summary>处理与交接</summary>
          <label className="oc-full-field">
            操作原因 / 客户确认依据
            <textarea
              aria-label="操作原因 / 客户确认依据"
              disabled={navigationBusy || navigationLoading}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              maxLength={2000}
              rows={2}
              placeholder="撤回、退回修改、暂停或客户确认时，请填写原因或确认依据"
            />
          </label>
          <fieldset className="oc-actions" disabled={!!detail.line.archivedAt}>
            {editable && (
              <>
                {!review && (
                  <button
                    className="oc-button"
                    disabled={busy}
                    onClick={() => void save("pending_review")}
                  >
                    <Save size={15} />
                    保存草稿
                  </button>
                )}
                <button
                  className="oc-button"
                  disabled={busy}
                  onClick={() => void save("needs_information")}
                >
                  保存为待补资料
                </button>
                <button
                  className="oc-button primary"
                  disabled={busy || !draft.printProfileVersionId}
                  onClick={() => void save("ready_to_push")}
                >
                  确认审单并保存
                </button>
              </>
            )}
            {module === "orders" && detail.line.preparation === "ready_to_push" && (
              <button
                className="oc-button primary"
                disabled={busy || draftDirty || detail.line.held}
                onClick={() => void action("push")}
              >
                <Send size={15} />
                确认并派发设计
              </button>
            )}
            {module === "orders" && detail.line.preparation === "pushed" && (
              <button
                className="oc-button"
                disabled={busy || detail.line.artwork === "starting"}
                onClick={() => void action("recall")}
              >
                撤回并修改需求
              </button>
            )}
            {module === "artwork" && ["queued", "starting"].includes(detail.line.artwork) && (
              <button
                className="oc-button primary"
                disabled={navigationBusy || navigationLoading || agentArtworkBlocked || detail.line.held}
                onClick={() => void action("start_artwork")}
              >
                {detail.line.artwork === "starting" ? "重试领取" : "领取并开始制作"}
              </button>
            )}
            {module === "artwork" && detail.line.editorProjectId && !["in_review", "approved"].includes(detail.line.artwork) && (
              <button className="oc-button" disabled={navigationBusy || navigationLoading || agentArtworkBlocked} onClick={openEditor}>
                打开生产文件
              </button>
            )}
            {detail.line.artwork === "approved" && detail.line.proof !== "not_required" && (
              <>
                {detail.line.proof === "approved" && detail.line.proofVersionCurrent === false && (
                  <p className="oc-error">原客户确认未绑定当前稿件，请核对当前版本并重新登记确认。</p>
                )}
                <button
                  className="oc-button"
                  disabled={navigationBusy || navigationLoading || agentArtworkBlocked || !editor?.version.id}
                  onClick={() => void action("approve_proof")}
                >
                  记录客户已确认
                </button>
                <button
                  className="oc-button"
                  disabled={navigationBusy || navigationLoading || agentArtworkBlocked || !editor?.version.id}
                  onClick={() => void action("reject_proof")}
                >
                  记录客户要求修改
                </button>
              </>
            )}
            {detail.line.revision > 0 && (
              <button
                className="oc-button"
                disabled={busy}
                onClick={() => void action(detail.line.held ? "resume" : "hold")}
              >
                {detail.line.held ? "解除暂停" : "暂停此商品"}
              </button>
            )}
          </fieldset>
          {detail.line.revision > 0 && (
            <div className="oc-actions">
              <button
                type="button"
                className="oc-button"
                disabled={
                  navigationBusy ||
                  navigationLoading ||
                  draftDirty ||
                  operationState.dirty ||
                  !reason.trim()
                }
                onClick={() => void archive(!detail.line.archivedAt)}
              >
                {detail.line.archivedAt ? "恢复到订单列表" : "归档此商品"}
              </button>
              <small>归档保留历史记录，可恢复；不会取消平台订单。</small>
            </div>
          )}
        </details>
        {editor && module === "artwork" && (
          <details className="oc-section">
            <summary>文件历史与生成记录（{editor.renders.length}）</summary>
            {agentArtworkBlocked ? <p className="oc-hint">自动制作仍在进行或状态待核对。请先刷新进度；制作中的任务需停止并接管后再编辑文件。</p> : <OrderArtworkProgress editor={editor} onOpen={openEditor} />}
            <div className="oc-render-list">
              {editor.renders.map((render) => (
                <p key={render.id}>
                  {render.purpose === "production"
                    ? "正式文件"
                    : render.purpose === "preview"
                      ? "预览文件"
                      : "AI 素材"}
                  {" · "}
                  {render.status === "completed"
                    ? "已生成"
                    : render.status === "failed"
                      ? "生成失败"
                      : "生成中"}
                  {" · "}
                  {render.versionId === editor.version.id
                    ? `当前 V${editor.version.versionNumber}`
                    : `历史 V${editor.versions.find((version) => version.id === render.versionId)?.versionNumber ?? "—"}`}
                  {render.files.map((file) => (
                    <a
                      className="oc-file-link"
                      key={file.key}
                      href={`/api/production-editor/projects/${editor.project.id}/renders/${render.id}/files/${encodeURIComponent(file.key)}`}
                    >
                      {file.name}
                    </a>
                  ))}
                </p>
              ))}
            </div>
          </details>
        )}

        <details className="oc-section">
          <summary>{detail.line.sourceChanged ? "最新导入资料与平台预览" : "原始导入资料与平台预览"}</summary>
          <p className="oc-hint">
            平台状态：
            {detail.line.providerStatus === "report_imported"
              ? "报告未提供权威状态"
              : detail.line.providerStatus}
            。下单时间：{dateTime(detail.line.placedAt)}。
          </p>
          {detail.report ? (
            <AmazonReportDetail detail={detail.report} />
          ) : (
            <p>此订单没有报告附件。</p>
          )}
        </details>
        <details className="oc-section">
          <summary>操作历史</summary>
          {!detail.events.length ? (
            <p className="oc-hint">保存需求后开始记录操作历史。</p>
          ) : (
            <ol className="oc-history">
              {detail.events.map((event) => (
                <li key={event.id}>
                  <div>
                    <strong>{label(event.action)}</strong>
                    <span>
                      {" "}
                      {label(event.from)} → {label(event.to)} · 需求 V{event.revision}
                    </span>
                  </div>
                  <p>{event.reason}</p>
                  <small>
                    {event.actor} · {dateTime(event.occurredAt)}
                  </small>
                </li>
              ))}
            </ol>
          )}
        </details>
      </div>
      {review && (
        <footer className="oc-review-footer">
          <div ref={setReviewFooter} />
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
          <div className="oc-actions">
            {module === "orders" && detail.line.preparation === "ready_to_push" && !draftDirty ? (
              <>
                <span className="oc-hint">审单已确认，派发后进入制图。</span>
                <button className="oc-button primary" disabled={navigationBusy || navigationLoading || detail.line.held || operationState.dirty || deadlineState.dirty}
                  onClick={() => void action("push", true)}>
                  <Send size={15} />{unified ? "推送本件设计" : review.hasNext ? "推送设计并下一单" : "推送设计并返回列表"}
                </button>
              </>
            ) : editable ? (
              <>
                <button
                  className="oc-button"
                  disabled={busy || loading}
                  onClick={() => void save("pending_review")}
                >
                  <Save size={15} />
                  保存草稿
                </button>
                <button
                  className="oc-button"
                  disabled={busy || loading}
                  onClick={() => void save("needs_information", true)}
                >
                  {unified ? "记录待补资料" : review.hasNext ? "待补资料并下一单" : "待补资料并返回列表"}
                </button>
                <button
                  className="oc-button primary"
                  disabled={busy || loading || !draft.printProfileVersionId}
                  onClick={() => void save("ready_to_push", true)}
                >
                  {busy ? "正在保存…" : unified ? "确认本件审单" : review.hasNext ? "确认审单并下一单" : "确认审单并返回列表"}
                </button>
              </>
            ) : module === "artwork" ? (
              <>
                <button className="oc-button" disabled={busy || loading} onClick={review.onNext}>
                  {review.hasNext ? "查看下一单" : "返回列表"}
                </button>
                {detail.line.artwork === "approved" && detail.line.proof === "pending" && (
                  <button
                    className="oc-button primary"
                    disabled={navigationBusy || navigationLoading || agentArtworkBlocked || !reason.trim() || detail.line.held}
                    onClick={() => void action("approve_proof", true)}
                  >
                    记录客户确认{unified ? "" : review.hasNext ? "并下一单" : "并返回列表"}
                  </button>
                )}
              </>
            ) : module !== "orders" ? (
              <>
                {!unified && <label className="oc-continue-option">
                  <input
                    type="checkbox"
                    checked={advanceOperation}
                    disabled={navigationBusy}
                    onChange={(event) => setAdvanceOperation(event.target.checked)}
                  />
                  本次操作保存成功后{review.hasNext ? "处理下一单" : "返回列表"}
                </label>}
                <button
                  className="oc-button"
                  disabled={navigationBusy || navigationLoading}
                  onClick={review.onNext}
                >
                  {review.hasNext ? "查看下一单" : "返回列表"}
                </button>
              </>
            ) : (
              <span className="oc-hint">
                {detail.line.held
                  ? "此订单已暂停，可在处理与交接中解除暂停。"
                  : "本单已派发设计，可继续查看下一单。"}
              </span>
            )}
          </div>
        </footer>
      )}
    </Container>
  );
}
function localDateTime(value: string) {
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
