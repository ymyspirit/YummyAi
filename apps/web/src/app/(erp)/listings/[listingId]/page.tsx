import { FileText } from "lucide-react";
import Link from "next/link";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import { erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { Permission } from "@yummyai/authz/permissions";
import { authorize } from "@yummyai/authz/authorize";
import { PublicationPreviewReadCheckInputSchema, type PublicationPreviewReadCheckInput } from "@yummyai/contracts/marketplace/publication-preview";
import { ListingDraftSchema } from "@yummyai/catalog-core/listing-read-contracts";
import type { ListingReplicationView, MarketplaceAccountView, MarketplaceAutomationRuleView, MarketplaceAutomationRunView, MarketplaceListingSyncRequestView, MarketplacePublicationRequestView } from "@yummyai/contracts";

import {
  ListingEditor,
  type ListingEditorView,
} from "../../../../features/listings/listing-editor";
import type { ReviewDrawerView } from "../../../../features/reviews/review-drawer";
import type { PublicationWorkspaceView } from "../../../../features/marketplaces/publication-panel";
import type { AutomationWorkspaceView } from "../../../../features/marketplaces/listing-channel-operations";
import { apiFetch } from "../../../../server-api";
import { WorkflowReturnLink } from "../../../../features/navigation/use-workflow-return";
import { erpAmbientIdentity } from "../../../../erp-auth/request";
import { assertErpIdentityCurrent } from "../../../../erp-auth/server";
import { localServiceAuth } from "../../../../web-auth-mode";
import { readMarketplaceJson } from "../../../../features/marketplaces/marketplace-lifecycle";
import { returnHref } from "../../../../features/navigation/workflow-href";

export const dynamic = "force-dynamic";

export default async function ListingPage({ params, searchParams }: { params: Promise<{ listingId: string }>; searchParams?: Promise<Record<string, string | string[] | undefined>> }) {
  const { listingId } = await params;
  const query = searchParams ? await searchParams : {}, pins: Record<string, string> = {};
  let queryValid = true;
  for (const name of ["listingVersionId", "publicationRequestId", "agentNativeV3", "agentCommand"]) {
    const raw = query[name]; if (raw === undefined) continue;
    const parsed = typeof raw === "string" ? EntityIdSchema.safeParse(raw.toLowerCase()) : null;
    if (!parsed?.success) queryValid = false; else pins[name] = parsed.data;
  }
  const result: Awaited<ReturnType<typeof loadListing>> = queryValid ? await loadListing(listingId, pins.listingVersionId) : { error: "原版本或请求链接无效 不改用当前版本" };
  const originalAgent = pins.agentNativeV3 ? `/ai-tasks?${new URLSearchParams({ agentNativeV3: pins.agentNativeV3, ...(pins.agentCommand ? { agentCommand: pins.agentCommand } : {}) })}` : null;
  return (
    <div className="research-shell listing-shell">
      <main className="research-main listing-main">
        <WorkflowReturnLink className="listing-return-link" label="返回来源页面继续处理" />
        {originalAgent && !returnHref(typeof query.returnTo === "string" ? query.returnTo : null) && <Link className="listing-return-link" href={originalAgent}>返回原 Agent 任务</Link>}
        {result.listing ? (
          <ListingEditor key={`${listingId}:${result.listing.versionId}`} accounts={result.accounts} automations={result.automations} listing={result.listing} operationsError={result.operationsError} publicationError={result.publicationError} publications={result.publications} replications={result.replications} review={result.review} syncs={result.syncs} fixedVersion={Boolean(pins.listingVersionId)} contextAuthority={result.contextAuthority} currentVersionId={result.currentVersionId} storeReadChecks={result.storeReadChecks} />
        ) : (
          <section className="analysis-error" role="alert">
            <FileText size={28} />
            <h1>未找到刊登</h1>
            <p>{result.error ?? "请先为 SPU 创建平台刊登。"}</p>
            <a href="/products">返回产品开发</a>
          </section>
        )}
      </main>
    </div>
  );
}

async function loadListing(
  id: string,
  requestedVersion?: string,
): Promise<{ accounts?: MarketplaceAccountView[]; automations?: AutomationWorkspaceView[]; listing?: ListingEditorView; operationsError?: string; publicationError?: string; publications?: PublicationWorkspaceView[]; replications?: ListingReplicationView[]; review?: ReviewDrawerView; syncs?: MarketplaceListingSyncRequestView[]; error?: string; contextAuthority?: string; currentVersionId?: string; storeReadChecks?: PublicationPreviewReadCheckInput[] | null }> {
  if (process.env.LISTING_DEMO_MODE === "1") {
    const listing = demoListing(id);
    if (requestedVersion && listing.versionId !== requestedVersion) return { error: "原示例未提供此历史版本 不改用当前版本" };
    return { accounts: [], automations: [], listing, publications: [], replications: [], review: demoReview(listing), syncs: [] };
  }
  const apiBase = process.env.API_BASE_URL;
  if (!apiBase) return { error: "尚未配置刊登 API。请设置 API_BASE_URL 后重试。" };
  try {
    const identity = localServiceAuth() ? null : await erpAmbientIdentity();
    const base = apiBase.replace(/\/$/, "");
    const [response, accountsResponse, publicationsResponse, replicationsResponse, syncsResponse, automationsResponse] = await Promise.all([
      apiFetch(`${base}/v1/listings/${id}`, { cache: "no-store" }),
      apiFetch(`${base}/v1/marketplace-accounts`, { cache: "no-store" }),
      apiFetch(`${base}/v1/marketplace-publications?listingId=${encodeURIComponent(id)}&limit=50`, { cache: "no-store" }),
      apiFetch(`${base}/v1/listings/${id}/replications`, { cache: "no-store" }),
      apiFetch(`${base}/v1/marketplace-listing-syncs?listingId=${encodeURIComponent(id)}&limit=50`, { cache: "no-store" }),
      apiFetch(`${base}/v1/marketplace-automation-rules`, { cache: "no-store" }),
    ]);
    if (!response.ok) throw new Error(`刊登读取失败 (${response.status})`);
    const payload = (await readMarketplaceJson(response, 8 * 1024 * 1024)) as {
      listing: {
        id: string;
        platform: "amazon" | "etsy";
        marketplaceId?: string;
        locale: string;
        status: ListingEditorView["status"];
        spuId: string;
        ownerUserId?: string;
      };
      version: {
        id: string;
        versionNumber: number;
        ruleVersion: string;
        source: "human" | "ai";
        content: ListingEditorView["content"];
        validation: ListingEditorView["validation"];
        createdAt: string;
      };
      history: ListingEditorView["history"];
    };
    if (payload.listing.id.toLowerCase() !== id.toLowerCase()) throw new Error("原刊登绑定不符");
    const currentVersionId = payload.version.id;
    if (requestedVersion && requestedVersion !== currentVersionId.toLowerCase()) {
      const versionsResponse = await apiFetch(`${base}/v1/listings/${id}/versions`, { cache: "no-store", signal: AbortSignal.timeout(20000) });
      if (!versionsResponse.ok) throw new Error("原历史版本当前不可读取");
      const versions = await readMarketplaceJson(versionsResponse, 8 * 1024 * 1024);
      if (!Array.isArray(versions)) throw new Error("原历史版本格式无效");
      const original = versions.find((row: unknown) => typeof row === "object" && row !== null && "id" in row && typeof row.id === "string" && row.id.toLowerCase() === requestedVersion) as typeof payload.version & { listingId?: string } | undefined;
      if (!original || original.listingId?.toLowerCase() !== id.toLowerCase() || !Number.isInteger(original.versionNumber) || original.versionNumber < 1 ||
        typeof original.ruleVersion !== "string" || !["human", "ai"].includes(original.source) || typeof original.createdAt !== "string" ||
        typeof original.validation?.completeness !== "number" || !Array.isArray(original.validation.blockers) || !Array.isArray(original.validation.warnings)) throw new Error("指定的原历史版本未提供 不改用当前版本");
      payload.version = { ...original, content: ListingDraftSchema.parse(original.content) as ListingEditorView["content"] };
    }
    const accounts = accountsResponse.ok ? await readMarketplaceJson(accountsResponse, 8 * 1024 * 1024) as MarketplaceAccountView[] : [];
    const publicationRequests = publicationsResponse.ok
      ? await readMarketplaceJson(publicationsResponse, 8 * 1024 * 1024) as MarketplacePublicationRequestView[]
      : [];
    const publications = await Promise.all(publicationRequests.map(async (publication) => {
      const eventsResponse = await apiFetch(`${base}/v1/marketplace-publications/${publication.id}/events`, { cache: "no-store" });
      return {
        ...publication,
        events: eventsResponse.ok ? await readMarketplaceJson(eventsResponse, 8 * 1024 * 1024) as PublicationWorkspaceView["events"] : [publication.current],
      };
    }));
    const automationRules = automationsResponse.ok ? await readMarketplaceJson(automationsResponse, 8 * 1024 * 1024) as MarketplaceAutomationRuleView[] : [];
    const automations = await Promise.all(automationRules.map(async (rule) => {
      const runsResponse = await apiFetch(`${base}/v1/marketplace-automation-rules/${rule.id}/runs`, { cache: "no-store" });
      return { ...rule, runs: runsResponse.ok ? await readMarketplaceJson(runsResponse, 8 * 1024 * 1024) as MarketplaceAutomationRunView[] : [] };
    }));
    const replications = replicationsResponse.ok ? await readMarketplaceJson(replicationsResponse, 8 * 1024 * 1024) as ListingReplicationView[] : [];
    const syncs = syncsResponse.ok ? await readMarketplaceJson(syncsResponse, 8 * 1024 * 1024) as MarketplaceListingSyncRequestView[] : [];
    let storeReady = false, storeReadChecks: PublicationPreviewReadCheckInput[] | null = null;
    try {
      if (identity) authorize(identity.view, Permission.StoreRead);
      const accountIds = [...new Set([...accounts.map(row => row.id), ...publications.map(row => row.accountId), ...syncs.map(row => row.accountId), ...automations.map(row => row.action.accountId)].map(value => value.toLowerCase()))].sort();
      storeReadChecks = [];
      for (let offset = 0; offset < Math.max(accountIds.length, 1); offset += 120) storeReadChecks.push(PublicationPreviewReadCheckInputSchema.parse({
        listingId: payload.listing.id, listingVersionId: payload.version.id, accountIds: accountIds.slice(offset, offset + 120).join(",") }));
      for (const input of storeReadChecks) {
        const currentStores = await apiFetch(`${base}/v1/marketplace-publications/preview/workspace?${new URLSearchParams(input)}`, { method: "HEAD", cache: "no-store", signal: AbortSignal.timeout(20000) });
        await currentStores.body?.cancel(); if (currentStores.status !== 200) throw new Error("原店铺范围当前不可读取");
      }
      storeReady = true;
    } catch { storeReady = false; }
    const currentListing = await apiFetch(`${base}/v1/listings/${id}`, { method: "HEAD", cache: "no-store", signal: AbortSignal.timeout(20000) });
    await currentListing.body?.cancel(); if (currentListing.status !== 200) throw new Error("原刊登当前不可读取");
    if (identity) await assertErpIdentityCurrent(identity);
    return {
      contextAuthority: identity ? erpSessionAuthority(identity.view) : undefined,
      currentVersionId,
      accounts: storeReady ? accounts : [],
      storeReadChecks,
      listing: {
        ...payload.listing,
        spuCode: payload.listing.spuId.slice(0, 12),
        versionId: payload.version.id,
        versionNumber: payload.version.versionNumber,
        ruleVersion: payload.version.ruleVersion,
        source: payload.version.source,
        updatedAt: payload.version.createdAt,
        content: payload.version.content,
        validation: payload.version.validation,
        history: payload.history,
      },
      publicationError: !storeReady ? "当前店铺资料不可读取 已隐藏原店铺与发布快照 不影响合法刊登内容读取" : !accountsResponse.ok
        ? `店铺连接读取失败 (${accountsResponse.status})`
        : !publicationsResponse.ok
          ? `发布记录读取失败 (${publicationsResponse.status})`
          : undefined,
      publications: storeReady ? publications : [],
      replications,
      syncs: storeReady ? syncs : [],
      automations: storeReady ? automations : [],
      operationsError: !storeReady ? "当前店铺相关资料不可读取 不显示旧同步或自动化快照" : !replicationsResponse.ok
        ? `站点复制记录读取失败 (${replicationsResponse.status})`
        : !syncsResponse.ok
          ? `在线同步记录读取失败 (${syncsResponse.status})`
          : !automationsResponse.ok ? `自动化规则读取失败 (${automationsResponse.status})` : undefined,
    };
  } catch {
    return { error: "原刊登或指定版本当前不可读取 请重新核对 不改用其他版本" };
  }
}

function demoReview(listing: ListingEditorView): ReviewDrawerView {
  return {
    id: "0198fbef-4a10-7000-8000-000000000710",
    listingVersion: listing.versionNumber,
    listingVersionId: "0198fbef-4a10-7000-8000-000000000704",
    platform: listing.platform,
    locale: listing.locale,
    status: "pending",
    submittedBy: "Lin Q.",
    submittedAt: "2026-07-18T04:10:00.000Z",
    assets: listing.content.mediaAssetIds.map((_id, index) => ({
      id: `0198fbef-4a10-7000-8000-0000000007${20 + index}`,
      fileName: index === 0 ? "mug-main-hero.png" : `mug-media-${index + 1}.png`,
      version: index === 0 ? 3 : 1,
      authorized: true,
      rightsApproved: true,
    })),
    blockers: listing.validation.blockers.length,
    warnings: listing.validation.warnings.length,
  };
}

function demoListing(id: string): ListingEditorView {
  const content = {
    platform: "amazon" as const,
    locale: "en-US",
    title: "Personalized Travel Mug with Gift Box — 16 oz Insulated Cup",
    description:
      "A gift-ready insulated travel mug with optional laser engraving and two presentation box choices.",
    bullets: [
      "Add a name or short message with precision laser engraving",
      "Double-wall insulated body for everyday hot and cold drinks",
      "Choose standard or premium gift-ready packaging",
      "Production artwork is rights-approved and supplier-ready",
    ],
    tags: [],
    mainImageId: "asset-main-0198",
    mediaAssetIds: ["asset-main-0198", "asset-lifestyle-0199", "asset-giftbox-0200"],
    variants: [
      { skuId: "sku-navy", skuCode: "TMG-NVY-16", optionValues: { Color: "Navy", Size: "16 oz" } },
      { skuId: "sku-sand", skuCode: "TMG-SND-16", optionValues: { Color: "Sand", Size: "16 oz" } },
    ],
    attributes: { material: "Stainless Steel", capacity: "16 oz", brand: "" },
    compliance: { countryOfOrigin: "CN", foodContactSafe: true },
  };
  return {
    id,
    platform: "amazon",
    locale: "en-US",
    status: "draft",
    spuCode: "TRAVEL-MUG-GIFT",
    versionId: "0198fbef-4a10-7000-8000-000000000704",
    versionNumber: 4,
    ruleVersion: "amazon-2026.07",
    source: "human",
    updatedAt: "2026-07-18T03:12:00.000Z",
    content,
    validation: {
      completeness: 83,
      blockers: [
        {
          severity: "blocker",
          code: "common.required",
          path: "attributes.brand",
          message: "Brand is required before review",
          ruleVersion: "amazon-2026.07",
        },
      ],
      warnings: [
        {
          severity: "warning",
          code: "amazon.aplus.missing",
          path: "aPlusModules",
          message: "No A+ content plan is attached",
          ruleVersion: "amazon-2026.07",
        },
      ],
    },
    history: [
      {
        id: "v4",
        versionNumber: 4,
        status: "draft",
        source: "human",
        createdAt: "2026-07-18T03:12:00.000Z",
      },
      {
        id: "v3",
        versionNumber: 3,
        status: "draft",
        source: "ai",
        createdAt: "2026-07-18T02:40:00.000Z",
      },
      {
        id: "v2",
        versionNumber: 2,
        status: "approved",
        source: "human",
        createdAt: "2026-07-17T08:20:00.000Z",
      },
      {
        id: "v1",
        versionNumber: 1,
        status: "superseded",
        source: "human",
        createdAt: "2026-07-16T05:10:00.000Z",
      },
    ],
  };
}
