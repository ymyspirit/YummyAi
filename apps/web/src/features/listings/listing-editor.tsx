"use client";

import type {
  ListingReplicationView,
  MarketplaceAccountView,
  MarketplaceListingSyncRequestView,
} from "@yummyai/contracts";
import type { ListingDraft, ListingValidation } from "@yummyai/platform-rules";
import {
  Archive,
  BadgeCheck,
  Boxes,
  CircleDot,
  FileClock,
  Image,
  ListTree,
  LoaderCircle,
  Monitor,
  Plus,
  RadioTower,
  Save,
  Send,
  ShieldCheck,
  Sparkles,
  Trash2,
  Workflow,
} from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { Permission } from "@yummyai/authz/permissions";
import { z } from "zod";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import { useErpAccess } from "../identity/erp-access";
import { readMarketplaceJson } from "../marketplaces/marketplace-lifecycle";
import { PublicationPreviewError, previewDenied, previewHash, checkPublicationWorkspaceRead, PUBLICATION_PREVIEW_RECHECK_EVENT } from "../marketplaces/publication-preview-client";
import type { PublicationPreviewReadCheckInput } from "@yummyai/contracts/marketplace/publication-preview";

import {
  ListingChannelOperations,
  type AutomationWorkspaceView,
} from "../marketplaces/listing-channel-operations";
import { PublicationPanel, type PublicationWorkspaceView } from "../marketplaces/publication-panel";
import { ReviewDrawer, type ReviewDrawerView } from "../reviews/review-drawer";
import { saveListingVersion, type ListingSaveResult } from "./listing-actions";
import { ValidationPanel } from "./validation-panel";
import { AssistPanel } from "../ai-assist/assist-panel";
import { adoptListingCopy } from "../ai-assist/listing-adoption";
import { AssistListingCopySchema } from "@yummyai/contracts/ai/assist";
import { readQueue, returnHref, workflowHref } from "../navigation/workflow-href";
import { useLeaveGuard } from "../navigation/use-leave-guard";

export interface ListingEditorView {
  id: string;
  ownerUserId?: string;
  platform: "amazon" | "etsy";
  marketplaceId?: string;
  locale: string;
  status: "draft" | "in_review" | "approved" | "archived";
  spuCode: string;
  versionId: string;
  versionNumber: number;
  ruleVersion: string;
  source: "human" | "ai";
  updatedAt: string;
  content: ListingDraft;
  validation: ListingValidation;
  history: Array<{
    id: string;
    versionNumber: number;
    status: "draft" | "approved" | "superseded";
    source: "human" | "ai";
    createdAt: string;
  }>;
}

const tabs = [
  "Content",
  "Media",
  "Variants",
  "Attributes",
  "Compliance",
  "Publish",
  "Channels",
  "History",
] as const;
type Tab = (typeof tabs)[number];

type ListingEditorProps = {
  accounts?: MarketplaceAccountView[];
  automations?: AutomationWorkspaceView[];
  listing: ListingEditorView;
  operationsError?: string;
  publicationError?: string;
  publications?: PublicationWorkspaceView[];
  replications?: ListingReplicationView[];
  review?: ReviewDrawerView;
  syncs?: MarketplaceListingSyncRequestView[];
  fixedVersion?: boolean;
  /** Canonical personal-session stamp, not a credential or a network authority digest. */
  contextAuthority?: string;
  currentVersionId?: string;
  storeReadChecks?: PublicationPreviewReadCheckInput[] | null;
};

const currentListingSchema = z.object({ listing: z.object({ id: EntityIdSchema, ownerUserId: EntityIdSchema.optional(),
  status: z.enum(["draft", "in_review", "approved", "archived"]) }).passthrough(), version: z.object({ id: EntityIdSchema }).passthrough() }).passthrough();
/** A read never grants access merely because the membership stamp stayed unchanged. */
export async function readCurrentListing(id: string, authority: string, signal?: AbortSignal) {
  const listingId = EntityIdSchema.parse(id.toLowerCase()), path = `/api/listings/${listingId}`;
  if (!authority) throw new PublicationPreviewError(409, "authority_changed");
  const init = { cache: "no-store" as const, credentials: "same-origin" as const,
    signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(20000)]), headers: { "x-yummyai-context-authority": authority } };
  const requireRead = (response: Response) => {
    if (!response.ok) {
      const code = response.headers.get("x-yummyai-error-code");
      throw new PublicationPreviewError(response.status, code && previewDenied(new PublicationPreviewError(409, code)) ? code : undefined);
    }
    if (response.headers.get("x-yummyai-context-authority") !== authority) throw new PublicationPreviewError(409, "authority_changed");
    if (response.status !== 200) throw new PublicationPreviewError(502);
  };
  signal?.throwIfAborted();
  const response = await fetch(path, { ...init, method: "GET" }); requireRead(response);
  const value = currentListingSchema.parse(await readMarketplaceJson(response, 8 * 1024 * 1024));
  if (value.listing.id.toLowerCase() !== listingId) throw new PublicationPreviewError(502);
  signal?.throwIfAborted();
  const checked = await fetch(path, { ...init, method: "HEAD" }); requireRead(checked);
  signal?.throwIfAborted();
  return { id: value.listing.id, ownerUserId: value.listing.ownerUserId, versionId: value.version.id, status: value.listing.status };
}

/** Recheck the actual object independently of the global membership session. */
export function ListingEditor(props: ListingEditorProps) {
  const { can, authority } = useErpAccess();
  const authorityRef = useRef(authority); authorityRef.current = authority;
  const [verifiedAuthority, setVerifiedAuthority] = useState(props.contextAuthority === undefined ? authority : null);
  const [current, setCurrent] = useState({
    id: props.listing.id,
    ownerUserId: props.listing.ownerUserId,
    versionId: props.currentVersionId ?? props.listing.versionId,
    status: props.listing.status,
  });
  const [error, setError] = useState("");
  const [denied, setDenied] = useState(false);
  const [storeReady, setStoreReady] = useState(props.storeReadChecks === undefined);
  const storeAllowed = can(Permission.StoreRead), storeAllowedRef = useRef(storeAllowed); storeAllowedRef.current = storeAllowed;
  const generation = useRef(0),
    active = useRef<AbortController | null>(null);
  const check = useCallback(async () => {
    const requestAuthority = authorityRef.current;
    const request = ++generation.current;
    active.current?.abort();
    const abort = new AbortController();
    active.current = abort;
    try {
      const value = await readCurrentListing(props.listing.id, requestAuthority ?? "", abort.signal);
      if (request !== generation.current || requestAuthority !== authorityRef.current) return;
      setCurrent(value);
      setDenied(false);
      setVerifiedAuthority(requestAuthority);
      setError("");
      if (props.storeReadChecks?.length && storeAllowedRef.current) {
        try { const authority = await previewHash(requestAuthority!);
          for (const input of props.storeReadChecks) { await checkPublicationWorkspaceRead(input, authority, abort.signal, false); }
          if (request === generation.current && requestAuthority === authorityRef.current && !abort.signal.aborted) setStoreReady(true);
        } catch { if (request === generation.current && requestAuthority === authorityRef.current && !abort.signal.aborted) setStoreReady(false); }
      }
    } catch (caught) {
      if (abort.signal.aborted || request !== generation.current || requestAuthority !== authorityRef.current) return;
      if (caught instanceof PublicationPreviewError && previewDenied(caught)) { setDenied(true); setVerifiedAuthority(null); setError(""); return; }
      setError("当前刊登暂时无法核对 内容已暂时隐藏 草稿会在核对通过后恢复");
    }
  }, [props.listing.id, props.storeReadChecks]);
  useEffect(() => {
    const shown = () => {
      if (document.visibilityState !== "hidden") void check();
    };
    const recheck = (event: Event) => {
      const input = z.object({ listingId: EntityIdSchema }).strict().safeParse((event as CustomEvent<unknown>).detail);
      if (input.success && input.data.listingId.toLowerCase() === props.listing.id.toLowerCase()) void check();
    };
    shown();
    const timer = window.setInterval(shown, 30000);
    window.addEventListener("focus", shown);
    window.addEventListener("pageshow", shown);
    window.addEventListener(PUBLICATION_PREVIEW_RECHECK_EVENT, recheck);
    document.addEventListener("visibilitychange", shown);
    return () => {
      generation.current++;
      active.current?.abort();
      window.clearInterval(timer);
      window.removeEventListener("focus", shown);
      window.removeEventListener("pageshow", shown);
      window.removeEventListener(PUBLICATION_PREVIEW_RECHECK_EVENT, recheck);
      document.removeEventListener("visibilitychange", shown);
    };
  }, [check, authority]);
  const resource = { ownerId: current.ownerUserId };
  if (denied || !can(Permission.ListingRead, resource))
    return (
      <section className="analysis-error" role="alert">
        <h1>刊登当前不可读取</h1>
        <p>当前账号没有这条刊登的读取权限 请返回目录重新选择</p>
        <a href="/listings">返回 Listing 目录</a>
      </section>
    );
  if (!authority || verifiedAuthority !== authority) return <section className="analysis-error" role="status"><h1>正在核对原刊登的当前读取权限</h1><p>原资料已隐藏 读取原文后仍需核对当前对象访问权 不采用旧页面的权限依据</p></section>;
  const editable = !props.fixedVersion && current.status !== "archived" && can(Permission.ListingWrite, resource);
  return (
    <>
      {error && (
        <section className="analysis-error" role="alert">
          <p>{error}</p>
          <button type="button" onClick={() => void check()}>
            重新核对刊登
          </button>
        </section>
      )}
      <div hidden={Boolean(error)} inert={Boolean(error)}>
        <ListingEditorBody
          key={`${current.id}:${authority}:${current.ownerUserId}:${editable}:${current.status === "archived"}`}
          {...props}
          storeReadable={storeReady && storeAllowed}
          accounts={storeReady && storeAllowed ? props.accounts : []}
          publications={storeReady && storeAllowed ? props.publications : []}
          syncs={storeReady && storeAllowed ? props.syncs : []}
          automations={storeReady && storeAllowed ? props.automations : []}
          publicationError={storeReady && storeAllowed ? props.publicationError : "当前店铺资料尚未核对或不可读取 已隐藏原发布与店铺资料 刊登内容仍可按原权限处理"}
          operationsError={storeReady && storeAllowed ? props.operationsError : "当前店铺相关操作资料不可读取 不显示旧快照"}
          listing={{ ...props.listing, ownerUserId: current.ownerUserId }}
          editable={editable}
          latestVersionId={current.versionId}
          currentStatus={current.status}
          onSaved={(versionId) => setCurrent((value) => ({ ...value, versionId, status: "draft" }))}
        />
      </div>
    </>
  );
}

function ListingEditorBody({
  accounts = [],
  automations = [],
  listing: initialListing,
  editable,
  latestVersionId,
  currentStatus,
  onSaved,
  operationsError,
  publicationError,
  publications = [],
  replications = [],
  review,
  syncs = [],
  fixedVersion = false,
  storeReadable,
}: ListingEditorProps & {
  editable: boolean;
  storeReadable: boolean;
  latestVersionId: string;
  currentStatus: ListingEditorView["status"];
  onSaved: (versionId: string) => void;
}) {
  const [listing, setListing] = useState(initialListing);
  const { can } = useErpAccess();
  const mounted = useRef(true);
  const router = useRouter();
  const params = useSearchParams();
  const queue = readQueue(params.get("queue"), listing.id) ?? [];
  const index = queue.indexOf(listing.id);
  const back = returnHref(params.get("returnTo")) ?? "/listings";
  const itemHref = (id: string) =>
    workflowHref(`/listings/${id}?${new URLSearchParams({ queue: queue.join(",") })}`, back);
  const [hydrated, setHydrated] = useState(false);
  const [tab, setTab] = useState<Tab>(() => params.getAll("tab").length === 1 && tabs.includes(params.get("tab") as Tab) ? params.get("tab") as Tab : "Content");
  const [baseline, setBaseline] = useState(() => copyDraft(listing.content));
  const [draft, setDraft] = useState(() => copyDraft(listing.content));
  const [reviewOpen, setReviewOpen] = useState(false);
  const [saveResult, setSaveResult] = useState<ListingSaveResult>();
  const [saving, startSaving] = useTransition();
  const dirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(baseline),
    [baseline, draft],
  );
  const mayLeave = useLeaveGuard(dirty, saving);
  const go = (href: string) => {
    if (mayLeave()) router.push(href);
  };

  useEffect(() => {
    mounted.current = true;
    setHydrated(true);
    return () => {
      mounted.current = false;
    };
  }, []);
  const save = (advance = false) =>
    startSaving(async () => {
      if (!editable) return;
      const result = await saveListingVersion(listing.id, draft, listing.versionId);
      if (!mounted.current) return;
      setSaveResult(result);
      if (result.status === "success" && result.version) {
        setBaseline(copyDraft(draft));
        const version = result.version;
        setListing((value) => ({
          ...value,
          content: copyDraft(draft),
          status: "draft",
          versionId: version.id,
          versionNumber: version.versionNumber,
          validation: version.validation,
          ruleVersion: version.ruleVersion,
          updatedAt: version.createdAt,
          source: version.source,
          history: [
            {
              id: version.id,
              versionNumber: version.versionNumber,
              status: "draft",
              source: version.source,
              createdAt: version.createdAt,
            },
            ...value.history.filter((item) => item.id !== version.id),
          ],
        }));
        onSaved(version.id);
        if (advance) router.push(queue[index + 1] ? itemHref(queue[index + 1]!) : back);
        else router.refresh();
      }
    });

  return (
    <div
      aria-busy={!hydrated}
      className="listing-workbench"
      data-hydrated={hydrated ? "true" : "false"}
    >
      {queue.length > 0 && (
        <nav className="listing-toolbar-actions listing-queue" aria-label="Listing 修订队列">
          <span>
            本页 {index + 1} / {queue.length}
          </span>
          <button
            disabled={!hydrated || saving || index <= 0}
            onClick={() => go(itemHref(queue[index - 1]!))}
          >
            上一条
          </button>
          <button
            disabled={!hydrated || saving || index >= queue.length - 1}
            onClick={() => go(itemHref(queue[index + 1]!))}
          >
            下一条
          </button>
          <button disabled={!hydrated || !editable || saving || !dirty} onClick={() => save(true)}>
            {index < queue.length - 1 ? "保存并下一条" : "保存并返回列表"}
          </button>
        </nav>
      )}
      <header className="listing-header">
        <div>
          <p className="kicker">{listing.platform.toUpperCase()} / LISTING CONTROL</p>
          <h1>{listing.spuCode}</h1>
          <p>平台内容、媒体、变体映射与合规校验固定在同一版本中。</p>
        </div>
        <div className="channel-stamp">
          <strong>{listing.platform === "amazon" ? "AMZ" : "ETSY"}</strong>
          <span>{listing.locale}</span>
          <b>{statusLabel(currentStatus)}</b>
        </div>
      </header>
      <div className="listing-toolbar">
        <div>
          <span className="mono">VERSION {String(listing.versionNumber).padStart(2, "0")}</span>
          <b>
            {listing.source === "ai" ? <Sparkles size={13} /> : <CircleDot size={13} />}
            {listing.source === "ai" ? "AI 草稿" : "人工草稿"}
          </b>
          {dirty && <em>● 未保存</em>}
        </div>
        <div className="listing-toolbar-actions">
          <button
            disabled={!hydrated || !editable || !dirty || saving}
            onClick={() => save()}
            type="button"
          >
            {saving ? <LoaderCircle className="spin" size={16} /> : <Save size={16} />}
            {saving ? "保存中" : "保存为新版本"}
          </button>
          {review && !fixedVersion && (
            <button
              type="button"
              className="review-open"
              disabled={!hydrated}
              onClick={() => setReviewOpen(true)}
            >
              <Send size={16} />
              查看审核
            </button>
          )}
        </div>
      </div>
      {!editable && (
        <p className="listing-save-notice" role="status">
          当前刊登内容仅可查看 编辑需要这条刊登的写入权限且刊登未归档
        </p>
      )}
      {fixedVersion && <p className="listing-save-notice" role="status">正在读取链接指定的不可变原版本 此处只读 不会用今天版本替换或通过旧编辑器提交</p>}
      {latestVersionId !== listing.versionId && (
        <p className="listing-save-notice" role="status">
          当前已有其他版本 你的草稿仍基于 V{listing.versionNumber} 保存时会检查冲突{" "}
          <button
            type="button"
            disabled={saving}
            onClick={() => {
              if (mayLeave()) window.location.reload();
            }}
          >
            重新载入当前版本
          </button>
        </p>
      )}
      {saveResult && (
        <p className={`listing-save-notice ${saveResult.status}`} role="status">
          {saveResult.message}
        </p>
      )}
      <nav className="listing-tabs" aria-label="刊登编辑区">
        {tabs.map((item) => (
          <button
            key={item}
            type="button"
            aria-current={tab === item ? "page" : undefined}
            disabled={!hydrated}
            onClick={() => setTab(item)}
          >
            {tabIcon(item)}
            {item}
          </button>
        ))}
      </nav>
      <div className="listing-layout">
        <main className="listing-canvas">
          {tab === "Content" && (
            <>
              {can(Permission.DesignRead) && can(Permission.ProductRead) ? (
                <AssistPanel
                  readOnly={!editable}
                  kind="sku_package"
                  scope={`listing:${listing.id}`}
                  input={{
                    kind: "sku_package",
                    listingId: listing.id,
                    expectedVersionId: listing.versionId,
                  }}
                  disabledReason={
                    !editable
                      ? "当前刊登仅可查看"
                      : listing.status === "archived"
                        ? "Listing 已归档。"
                        : dirty || saving
                          ? "请先保存当前改动，再根据最新版本分析。"
                          : undefined
                  }
                  onListingCopy={(copy, fields) => {
                    if (!editable || !mounted.current) return false;
                    const parsed = AssistListingCopySchema.safeParse(copy);
                    if (
                      !parsed.success ||
                      (listing.platform === "etsy" && copy.title.length > 140)
                    ) {
                      setSaveResult({
                        status: "error",
                        message: "建议内容超出字段限制，请检查标题、标签和描述长度。",
                      });
                      return false;
                    }
                    if (
                      fields.includes("personalizationInstructions") &&
                      !draft.personalization?.enabled
                    ) {
                      setSaveResult({
                        status: "error",
                        message: "请先启用并保存定制设置，或取消勾选定制说明。",
                      });
                      return false;
                    }
                    setDraft((current) => adoptListingCopy(current, parsed.data, fields));
                  }}
                />
              ) : (
                <p className="listing-panel-empty">
                  SKU 资料包助手需要商品、刊登和设计资料的读取权限
                </p>
              )}
              <ContentEditor
                draft={draft}
                interactive={hydrated && editable && !saving}
                platform={listing.platform}
                setDraft={setDraft}
              />
            </>
          )}
          {tab === "Media" && (
            <section className="listing-panel">
              <header>
                <p className="section-code">AUTHORIZED MEDIA</p>
                <h2>媒体与 A+ 计划</h2>
              </header>
              <div className="media-grid">
                {draft.mediaAssetIds.map((id, index) => (
                  <article key={id}>
                    <span>
                      <Image size={22} />
                    </span>
                    <strong>
                      {id === draft.mainImageId ? "MAIN IMAGE" : `MEDIA ${index + 1}`}
                    </strong>
                    <code>{id.slice(0, 16)}…</code>
                    <b>
                      <ShieldCheck size={13} />
                      已关联
                    </b>
                    <label>
                      图片说明
                      <textarea
                        disabled={!editable || saving}
                        aria-label={`媒体 ${index + 1} 图片说明`}
                        maxLength={500}
                        value={draft.mediaDescriptions?.[id] ?? ""}
                        onChange={(e) =>
                          setDraft((current) => ({
                            ...current,
                            mediaDescriptions: {
                              ...current.mediaDescriptions,
                              [id]: e.target.value,
                            },
                          }))
                        }
                      />
                    </label>
                  </article>
                ))}
              </div>
              {!draft.mediaAssetIds.length && (
                <p className="listing-panel-empty">尚未关联可发布媒体。</p>
              )}
            </section>
          )}
          {tab === "Variants" && (
            <section className="listing-panel">
              <header>
                <p className="section-code">SKU MAPPING</p>
                <h2>变体映射</h2>
              </header>
              <table>
                <thead>
                  <tr>
                    <th>SKU</th>
                    <th>平台选项</th>
                    <th>映射状态</th>
                  </tr>
                </thead>
                <tbody>
                  {draft.variants.map((variant) => (
                    <tr key={variant.skuId}>
                      <td>
                        <code>{variant.skuCode}</code>
                      </td>
                      <td>
                        {Object.entries(variant.optionValues)
                          .map(([key, value]) => `${key}: ${value}`)
                          .join(" · ") || "标准款"}
                      </td>
                      <td>
                        <span className="mapping-ok">
                          <BadgeCheck size={14} />
                          已映射
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
          {tab === "Attributes" && (
            <ReadOnlyRecord
              title="平台属性"
              code="CATALOG ATTRIBUTES"
              values={draft.attributes}
              source="VERSION SNAPSHOT"
            />
          )}
          {tab === "Compliance" && (
            <ReadOnlyRecord
              title="合规声明"
              code="COMPLIANCE"
              values={draft.compliance}
              source="VERSION SNAPSHOT"
            />
          )}
          {tab === "Publish" && (storeReadable ? (
            <PublicationPanel
              accounts={accounts}
              error={publicationError}
              initialAccountId={params.get("accountId") ?? undefined}
              initialMarketplaceId={params.get("marketplaceId") ?? listing.marketplaceId}
              initialRequestId={params.getAll("publicationRequestId").length === 1 ? params.get("publicationRequestId") ?? undefined : undefined}
              listing={{
                id: listing.id,
                platform: listing.platform,
                status: latestVersionId === listing.versionId ? currentStatus : "draft",
                validationBlockers: listing.validation.blockers.length,
                variants: draft.variants,
                versionId: listing.versionId,
              }}
              publications={publications}
            />
          ) : <p role="status" className="listing-save-notice">{publicationError ?? "当前店铺原预览不可读取 原资料已隐藏"}</p>)}
          {tab === "Channels" && (
            <ListingChannelOperations
              key={storeReadable ? "store-readable" : "store-unavailable"}
              accounts={accounts}
              automations={automations}
              error={operationsError}
              listing={{
                id: listing.id,
                locale: listing.locale,
                marketplaceId: listing.marketplaceId,
                platform: listing.platform,
                status: latestVersionId === listing.versionId ? currentStatus : "draft",
                variants: draft.variants,
                versionId: listing.versionId,
              }}
              publications={publications}
              replications={replications}
              syncs={syncs}
            />
          )}
          {tab === "History" && <HistoryPanel history={listing.history} />}
        </main>
        <div className="listing-side-rail">
          <ListingPreview draft={draft} platform={listing.platform} />
          <section className="listing-activity-rail" aria-labelledby="activity-title">
            <header>
              <p className="section-code">VERSION ACTIVITY</p>
              <h2 id="activity-title">版本活动</h2>
            </header>
            <ol>
              {listing.history.slice(0, 5).map((version) => (
                <li key={version.id}>
                  <span className={`version-dot ${version.status}`} />
                  <div>
                    <strong>
                      V{String(version.versionNumber).padStart(2, "0")} ·{" "}
                      {version.source === "ai" ? "AI 建议" : "人工编辑"}
                    </strong>
                    <small>
                      {version.status === "approved"
                        ? "已审批"
                        : version.status === "superseded"
                          ? "已替代"
                          : "草稿"}
                    </small>
                  </div>
                  <time>{formatDate(version.createdAt)}</time>
                </li>
              ))}
            </ol>
            {!listing.history.length && <p>暂无历史版本。</p>}
          </section>
          {dirty && (
            <p className="listing-validation-stale">
              当前门禁结果对应上次保存版本；保存后将按平台规则重新校验。
            </p>
          )}
          <ValidationPanel validation={listing.validation} ruleVersion={listing.ruleVersion} />
        </div>
      </div>
      {reviewOpen && review && !fixedVersion && (
        <div
          className="review-scrim"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setReviewOpen(false);
          }}
        >
          <ReviewDrawer review={review} onClose={() => setReviewOpen(false)} />
        </div>
      )}
    </div>
  );
}

function ContentEditor({
  draft,
  interactive,
  platform,
  setDraft,
}: {
  draft: ListingDraft;
  interactive: boolean;
  platform: ListingEditorView["platform"];
  setDraft: React.Dispatch<React.SetStateAction<ListingDraft>>;
}) {
  const titleLimit = platform === "amazon" ? 200 : 140;
  return (
    <section className="listing-content" aria-labelledby="content-title">
      <header>
        <p className="section-code">MARKETPLACE COPY</p>
        <h2 id="content-title">商品内容</h2>
        <span>
          {platform === "amazon" ? "TITLE · BULLETS · DESCRIPTION" : "TITLE · DESCRIPTION · TAGS"}
        </span>
      </header>
      <FieldMeta label="商品标题" source="当前草稿">
        <textarea
          disabled={!interactive}
          value={draft.title}
          maxLength={titleLimit}
          onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))}
        />
        <small>
          {draft.title.length} / {titleLimit}
        </small>
      </FieldMeta>
      {platform === "amazon" && (
        <div className="listing-bullet-editor">
          {draft.bullets.map((bullet, index) => (
            <FieldMeta key={index} label={`卖点 ${index + 1}`} source="当前草稿">
              <div className="listing-inline-field">
                <input
                  disabled={!interactive}
                  value={bullet}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      bullets: current.bullets.map((item, itemIndex) =>
                        itemIndex === index ? event.target.value : item,
                      ),
                    }))
                  }
                />
                <button
                  aria-label={`删除卖点 ${index + 1}`}
                  disabled={!interactive}
                  onClick={() =>
                    setDraft((current) => ({
                      ...current,
                      bullets: current.bullets.filter((_, itemIndex) => itemIndex !== index),
                    }))
                  }
                  type="button"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </FieldMeta>
          ))}
          <button
            className="listing-add-bullet"
            disabled={!interactive || draft.bullets.length >= 5}
            onClick={() =>
              setDraft((current) => ({ ...current, bullets: [...current.bullets, ""] }))
            }
            type="button"
          >
            <Plus size={14} />
            新增卖点
          </button>
        </div>
      )}
      <FieldMeta label="商品描述" source="当前草稿">
        <textarea
          disabled={!interactive}
          value={draft.description}
          rows={6}
          onChange={(event) =>
            setDraft((current) => ({ ...current, description: event.target.value }))
          }
        />
      </FieldMeta>
      <div className="listing-field">
        <strong>定制设置</strong>
        <label>
          <input
            type="checkbox"
            checked={draft.personalization?.enabled ?? false}
            disabled={!interactive}
            onChange={(e) =>
              setDraft((current) => ({
                ...current,
                personalization: { ...current.personalization, enabled: e.target.checked },
              }))
            }
          />
          允许顾客定制
        </label>
        {draft.personalization?.enabled && (
          <textarea
            disabled={!interactive}
            aria-label="定制说明"
            value={draft.personalization.instructions ?? ""}
            maxLength={1024}
            onChange={(e) =>
              setDraft((current) => ({
                ...current,
                personalization: {
                  ...current.personalization,
                  enabled: true,
                  instructions: e.target.value,
                },
              }))
            }
          />
        )}
      </div>
      {platform === "etsy" && (
        <FieldMeta label="标签" source="当前草稿">
          <input
            disabled={!interactive}
            value={draft.tags.join(", ")}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                tags: event.target.value
                  .split(",")
                  .map((tag) => tag.trim())
                  .filter(Boolean),
              }))
            }
          />
          <small>{draft.tags.length} / 13 个标签</small>
        </FieldMeta>
      )}
    </section>
  );
}

function ListingPreview({
  draft,
  platform,
}: {
  draft: ListingDraft;
  platform: ListingEditorView["platform"];
}) {
  return (
    <section className={`listing-local-preview ${platform}`} aria-labelledby="local-preview-title">
      <header>
        <span>
          <Monitor size={16} />
        </span>
        <div>
          <p className="section-code">LOCAL RULE PREVIEW</p>
          <h2 id="local-preview-title">平台本地预览</h2>
        </div>
      </header>
      <p className="listing-preview-disclaimer">
        仅按本地字段规则排版，不代表平台在线状态或最终渲染。
      </p>
      <div className="listing-preview-media">
        {draft.mainImageId ? (
          <>
            <Image size={24} />
            <span>主图已关联</span>
          </>
        ) : (
          <>
            <Image size={24} />
            <span>主图缺失</span>
          </>
        )}
      </div>
      <article>
        <small>{platform === "amazon" ? "Amazon 商品详情样式" : "Etsy 商品卡片样式"}</small>
        <h3>{draft.title || "未填写商品标题"}</h3>
        {platform === "amazon" ? (
          <ul>
            {draft.bullets
              .filter(Boolean)
              .slice(0, 5)
              .map((bullet, index) => (
                <li key={index}>{bullet}</li>
              ))}
          </ul>
        ) : (
          <div className="listing-preview-tags">
            {draft.tags.slice(0, 13).map((tag) => (
              <span key={tag}>{tag}</span>
            ))}
          </div>
        )}
        <p>{draft.description || "未填写商品描述"}</p>
      </article>
    </section>
  );
}
function ReadOnlyRecord({
  code,
  source,
  title,
  values,
}: {
  code: string;
  source: string;
  title: string;
  values: Record<string, string | number | boolean>;
}) {
  return (
    <section className="listing-panel">
      <header>
        <p className="section-code">{code}</p>
        <h2>{title}</h2>
      </header>
      <dl className="attribute-grid">
        {Object.entries(values).map(([key, value]) => (
          <div key={key}>
            <dt>{key}</dt>
            <dd>{String(value)}</dd>
            <span>{source}</span>
          </div>
        ))}
      </dl>
      {!Object.keys(values).length && <p className="listing-panel-empty">暂无可用字段。</p>}
    </section>
  );
}
function HistoryPanel({ history }: { history: ListingEditorView["history"] }) {
  return (
    <section className="listing-panel">
      <header>
        <p className="section-code">VERSION HISTORY</p>
        <h2>不可变历史</h2>
      </header>
      <ol className="listing-history">
        {history.map((version) => (
          <li key={version.id}>
            <strong>V{String(version.versionNumber).padStart(2, "0")}</strong>
            <span>{version.source === "ai" ? "AI 建议" : "人工编辑"}</span>
            <b>
              {version.status === "approved"
                ? "已审批"
                : version.status === "superseded"
                  ? "已替代"
                  : "草稿"}
            </b>
            <time>{formatDate(version.createdAt)}</time>
          </li>
        ))}
      </ol>
    </section>
  );
}
function FieldMeta({
  label,
  source,
  children,
}: {
  label: string;
  source: string;
  children: React.ReactNode;
}) {
  return (
    <label className="listing-field">
      <span>
        <strong>{label}</strong>
        <em>{source}</em>
      </span>
      {children}
    </label>
  );
}
function tabIcon(tab: Tab) {
  return {
    Content: <Archive size={15} />,
    Media: <Image size={15} />,
    Variants: <Boxes size={15} />,
    Attributes: <ListTree size={15} />,
    Compliance: <ShieldCheck size={15} />,
    Publish: <RadioTower size={15} />,
    Channels: <Workflow size={15} />,
    History: <FileClock size={15} />,
  }[tab];
}
function statusLabel(status: ListingEditorView["status"]) {
  return { draft: "草稿", in_review: "评审中", approved: "已审批", archived: "已归档" }[status];
}
function formatDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}
function copyDraft(content: ListingDraft): ListingDraft {
  return {
    ...content,
    ...(content.mediaDescriptions ? { mediaDescriptions: { ...content.mediaDescriptions } } : {}),
    bullets: [...content.bullets],
    tags: [...content.tags],
    mediaAssetIds: [...content.mediaAssetIds],
    variants: content.variants.map((variant) => ({
      ...variant,
      optionValues: { ...variant.optionValues },
    })),
    attributes: { ...content.attributes },
    compliance: { ...content.compliance },
    ...(content.aPlusModules
      ? {
          aPlusModules: content.aPlusModules.map((module) => ({
            ...module,
            assetIds: [...module.assetIds],
          })),
        }
      : {}),
    ...(content.personalization ? { personalization: { ...content.personalization } } : {}),
  };
}
