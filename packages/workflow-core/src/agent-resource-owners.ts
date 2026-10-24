import { ListingCatalogQuerySchema,ListingDraftSchema } from "@yummyai/catalog-core";
import type { TenantContext } from "@yummyai/contracts";
import { agentResourceDataSchemas,type AgentResourceCandidatesQuery } from "@yummyai/contracts/ai/agent-resources";
import { CaptureDraftSchema } from "@yummyai/contracts/capture";
import { printBindingSnapshot } from "@yummyai/contracts/catalog/composition";
import { OriginalOwnerError } from "@yummyai/contracts/common/original-owner-error";
import type { ZodType } from "zod";
import type { AgentAdvertisingReader,AgentDevelopmentReader,AgentFinanceReader,AgentListingReader,AgentOrderReader,AgentResearchReader,AgentResearchStudyReader,AgentResourceOwnerCandidates,AgentResourceOwnerPort,AgentResourceOwnerResult,AgentResourceOwnerSelection } from "./agent-resources-ports.js";
export type { AgentResourceOwnerCandidates,AgentResourceOwnerPort,AgentResourceOwnerResult,AgentResourceOwnerSelection } from "./agent-resources-ports.js";
function projection<T>(schema: ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new OriginalOwnerError(502, { code: "agent_resources_owner_invalid", message: "原资料无法按所选事实契约核对" });
  return parsed.data;
}
function missing(): never {
  throw new OriginalOwnerError(404, { code: "agent_resources_not_found", message: "原对象或所选版本不存在或不可访问" });
}
const coverage = (returned: number, limitation: string, total: number | null = null, hasMore: boolean | null = null, nextCursor: string | null = null): AgentResourceOwnerCandidates["coverage"] =>
  ({ kind: "bounded_candidates", complete: false, total, returned, hasMore, nextCursor, limitation });

/** Original domain readers retain authority; projections omit private media and signed URLs. */
export class AgentResourceOwners implements AgentResourceOwnerPort {
  constructor(
    private readonly research:AgentResearchReader,
    private readonly studies:AgentResearchStudyReader,
    private readonly products:AgentDevelopmentReader,
    private readonly listings:AgentListingReader,
    private readonly orders:AgentOrderReader,
    private readonly finance:AgentFinanceReader,
    private readonly advertising:AgentAdvertisingReader,
  ) {}
  async assertAccess(context:TenantContext,selection:AgentResourceOwnerSelection):Promise<void>{
    if(selection.tool==='orders.order'){
      const order=await this.orders.get(context,selection.input.orderId);
      if(order.id!==selection.input.orderId)missing();
      return;
    }
    await this.read(context,selection);
  }

  async candidates(context: TenantContext, query: AgentResourceCandidatesQuery): Promise<AgentResourceOwnerCandidates> {
    switch (query.tool) {
      case "research.evidence": {
        const page = await this.research.list(context, { q: query.q, limit: 100 });
        const captured = page.items.filter(item => item.latestSnapshotId);
        const items = captured.map(item => ({ id: item.id, label: item.latestTitle ?? "研究证据", detail: `${item.platform} · ${item.marketplace} · ${item.latestStatus}`,
          versionId: item.latestSnapshotId!, revision: null, kind: "object" as const }));
        return { items, coverage: coverage(items.length, "仅原研究列表首100项中已有快照的对象 不提供旧时间游标续读 不代表全部证据或全部历史版本",
          captured.length === page.items.length ? page.total : null, Boolean(page.nextCursor)) };
      }
      case "catalog.sku": {
        const page = await this.products.workspace(context, { q: query.q, page: query.page, pageSize: query.pageSize });
        const items = page.items.map(item => ({ id: item.skuId, label: item.skuCode, detail: `${item.spuCode} · ${item.spuName}`,
          versionId: item.recipe?.id ?? null, revision: item.recipe?.version ?? null, kind: "object" as const }));
        return { items, coverage: coverage(items.length, "原商品owner当前受权列表的单页 候选页之间不承诺固定快照 配方须另行精确选定", page.total, page.page * page.pageSize < page.total) };
      }
      case "listing.version": {
        const page = await this.listings.catalog(context, ListingCatalogQuerySchema.parse({ q: query.q, page: query.page, limit: query.pageSize }));
        const items = page.items.map(item => ({ id: item.id, label: item.title, detail: `${item.platform} · ${item.locale} · v${item.versionNumber}`,
          versionId: item.versionId, revision: item.versionNumber, kind: "object" as const }));
        return { items, coverage: coverage(items.length, "原Listing目录的单页候选 读取固定版本不等于当前发布状态或整个平台已发布集合", page.total, page.page < page.pages) };
      }
      case "orders.order": {
        const rows = await this.orders.list(context, query.filters);
        const items = rows.map(item => ({ id: item.id, label: item.externalOrderId, detail: `${item.platform} · ${item.workflowState} · ${item.lineCount}项`,
          versionId: null, revision: item.latestEventSequence, kind: "object" as const }));
        return { items, coverage: coverage(items.length, "仅原订单列表的受限最近记录 保留原授权业务编号 不含客户私文 不代表完整订单历史", null, rows.length < query.filters.limit ? false : null) };
      }
      case "finance.profit_run": {
        const runs = await this.finance.recent(context);
        const items = runs.map(run => ({ id: run.id, label: `利润核算 ${run.calculatedAt}`, detail: `${run.reportingCurrency} · ${run.status} · 规则v${run.metricVersion}`,
          versionId: null, revision: null, kind: "object" as const }));
        return { items, coverage: coverage(items.length, "仅原财务工作区最近100次已保存核算 不重新计算且不代表全部历史", null, items.length < 100 ? false : null) };
      }
      case "advertising.analysis": {
        if (query.accountId === null) {
          const accounts = await this.advertising.accounts(context);
          const readable = accounts.filter(account => account.access.canRead), selected = readable.slice(0, 100);
          const items = selected.map(account => ({ id: account.id, label: account.name, detail: `${account.marketplaceIds.join(" · ")} · ${account.status}`,
            versionId: null, revision: null, kind: "account" as const }));
          return { items, coverage: coverage(items.length, "仅可按原广告读取权限访问的最多100个账户 选择账户后再读取分析候选", readable.length, readable.length > items.length) };
        }
        const page = await this.advertising.history(context, { accountId: query.accountId, kind: "analyses", pageSize: query.pageSize,
          ...(query.cursor === null ? {} : { cursor: query.cursor }) });
        if (page.accessMode !== "read") throw new OriginalOwnerError(403, { code: "agent_resources_read_required", message: "需要原账户广告读取权限" });
        const items = page.rows.map(row => ({ id: row.id, label: row.title, detail: `${row.periodStart ?? "未知日期"} 至 ${row.periodEnd ?? "未知日期"} · ${row.status ?? "已保存"}`,
          versionId: null, revision: null, kind: "object" as const }));
        return { items, coverage: coverage(items.length, "固定账户原分析历史的单页候选 沿原创建截止和游标读取 不代表其他账户或全部广告事实", page.count, page.hasMore, page.nextCursor) };
      }
    }
  }

  async read(context: TenantContext, call: AgentResourceOwnerSelection): Promise<AgentResourceOwnerResult> {
    switch (call.tool) {
      case "research.evidence": {
        const [reference] = await this.studies.resolve(context, [call.input]);
        if (!reference || reference.researchItemId !== call.input.researchItemId || reference.snapshotId !== call.input.snapshotId || reference.studyRevisionId !== call.input.studyRevisionId) missing();
        const selected = (await this.research.timeline(context, call.input.researchItemId)).find(row => row.id === call.input.snapshotId);
        if (!selected || selected.researchItemId !== call.input.researchItemId || selected.domain !== "research") missing();
        const draft = projection(CaptureDraftSchema, selected.draft);
        if (draft.domain !== "research") missing();
        const data = projection(agentResourceDataSchemas[call.tool], {
          source: { domain: reference.domain, researchItemId: reference.researchItemId, snapshotId: reference.snapshotId,
            studyRevisionId: reference.studyRevisionId, studyVersion: reference.studyVersion, title: reference.title,
            sourceUrl: reference.sourceUrl, platform: reference.platform, capturedAt: reference.capturedAt, mediaCount: reference.mediaCount, content: reference.content },
          snapshot: { platform: draft.platform, parserVersion: draft.parserVersion, extensionVersion: draft.extensionVersion,
            marketplace: draft.marketplace, sourceUrl: draft.sourceUrl, externalId: draft.externalId, title: draft.title, domain: draft.domain,
            price: draft.price, rating: draft.rating, reviewCount: draft.reviewCount, taxonomy: draft.taxonomy, listingPublishedAt: draft.listingPublishedAt,
            favoriteCount: draft.favoriteCount, bullets: draft.bullets, missingFields: draft.missingFields, diagnostics: draft.diagnostics,
            captureStatus: draft.captureStatus, capturedAt: draft.capturedAt },
        });
        return { data, sources: [{ owner: "research", kind: "capture_snapshot", id: reference.researchItemId, versionId: reference.snapshotId, revision: null }] };
      }
      case "catalog.sku": {
        const detail = await this.products.detail(context, call.input.skuId);
        if (detail.item.skuId !== call.input.skuId) missing();
        const recipe = call.input.recipeId === null ? detail.item.recipe : detail.recipes.find(item => item.id === call.input.recipeId);
        if (call.input.recipeId !== null && !recipe || recipe && recipe.skuId !== call.input.skuId) missing();
        const data = projection(agentResourceDataSchemas[call.tool], {
          skuId: detail.item.skuId, skuCode: detail.item.skuCode, spuId: detail.item.spuId, spuCode: detail.item.spuCode,
          spuName: detail.item.spuName, attributes: detail.item.attributes, lifecycle: detail.lifecycle,
          packageCount: detail.item.packageCount, packageRead: detail.access.packageRead,
          packages: detail.access.packageRead ? detail.packages.slice(0, 1000).map(item => ({ id: item.id, version: item.version, recipeId: item.recipeId,
            listingId: item.listingId, listingVersionId: item.listingVersionId, checksum: item.checksum, platform: item.platform, marketplaceId: item.marketplaceId, locale: item.locale })) : [],
          recipe: recipe ? {
            id: recipe.id, skuId: recipe.skuId, version: recipe.version, status: recipe.status, createdAt: recipe.createdAt, needsUpdate: recipe.needsUpdate,
            artwork: { id: recipe.artwork.id, code: recipe.artwork.code, name: recipe.artwork.name, mode: recipe.artwork.mode,
              versionId: recipe.artwork.versionId, version: recipe.artwork.version, assetId: recipe.artwork.assetId, assetVersion: recipe.artwork.assetVersion,
              creativeVersionId: recipe.artwork.creativeVersionId, customization: recipe.artwork.customization },
            printBindings: recipe.printBindings?.map(printBindingSnapshot) ?? null,
            specification: { id: recipe.specification.id, spuId: recipe.specification.spuId, spuCode: recipe.specification.spuCode, code: recipe.specification.code,
              name: recipe.specification.name, versionId: recipe.specification.versionId, version: recipe.specification.version, attributes: recipe.specification.attributes,
              facts: recipe.specification.facts, processProfileVersionId: recipe.specification.processProfileVersionId, productType: recipe.specification.productType,
              canvasPrintSpecVersionId: recipe.specification.canvasPrintSpecVersionId, stockItemId: recipe.specification.stockItemId },
            editorProjectId: recipe.editorProjectId, editorVersionId: recipe.editorVersionId, renderId: recipe.renderId, designVersionId: recipe.designVersionId,
          } : null,
        });
        return { data, sources: [
          { owner: "catalog", kind: "sku", id: data.skuId, versionId: null, revision: null },
          ...(data.recipe ? [
            { owner: "catalog", kind: "sales_recipe", id: data.recipe.id, versionId: null, revision: data.recipe.version },
            { owner: "catalog", kind: "artwork", id: data.recipe.artwork.id, versionId: data.recipe.artwork.versionId, revision: data.recipe.artwork.version },
            { owner: "catalog", kind: "specification", id: data.recipe.specification.id, versionId: data.recipe.specification.versionId, revision: data.recipe.specification.version },
          ] : []),
        ] };
      }
      case "listing.version": {
        const workspace = await this.listings.getWorkspace(context, call.input.listingId);
        const selected = (await this.listings.listVersions(context, call.input.listingId)).find(version => version.id === call.input.versionId);
        if (!selected || selected.listingId !== call.input.listingId || selected.tenantId !== context.tenantId || workspace.listing.id !== call.input.listingId) missing();
        const content = projection(ListingDraftSchema, selected.content), listing = workspace.listing;
        const data = projection(agentResourceDataSchemas[call.tool], {
          listing: { id: listing.id, spuId: listing.spuId, platform: listing.platform, marketplaceId: listing.marketplaceId ?? null,
            locale: listing.locale, status: listing.status, primaryVersionId: listing.primaryVersionId ?? null },
          version: { id: selected.id, listingId: selected.listingId, versionNumber: selected.versionNumber, ruleVersion: selected.ruleVersion,
            status: selected.status, source: selected.source, createdAt: selected.createdAt.toISOString(), validation: selected.validation,
            content: { platform: content.platform, locale: content.locale, title: content.title, description: content.description, bullets: content.bullets,
              tags: content.tags, mainImageId: content.mainImageId ?? null, mediaAssetIds: content.mediaAssetIds, variants: content.variants,
              attributes: content.attributes, compliance: content.compliance, personalization: content.personalization ?? null,
              mediaDescriptions: content.mediaDescriptions ?? {}, aPlusModules: content.aPlusModules ?? [] } },
        });
        return { data, sources: [{ owner: "listings", kind: "listing_version", id: data.listing.id, versionId: data.version.id, revision: data.version.versionNumber }] };
      }
      case "orders.order": {
        const order = await this.orders.get(context, call.input.orderId);
        if (order.id !== call.input.orderId || order.latestEventSequence !== call.input.expectedSequence || order.lineCount !== order.lines.length)
          throw new OriginalOwnerError(409, { code: "agent_resources_source_changed", message: "原订单版本已变化 请重新选择" });
        const data = projection(agentResourceDataSchemas[call.tool], order);
        // The legacy reader assembles lines separately. Detect an intervening owner mutation before returning its projection.
        const final = await this.orders.get(context, call.input.orderId);
        if (final.latestEventSequence !== call.input.expectedSequence)
          throw new OriginalOwnerError(409, { code: "agent_resources_source_changed", message: "原订单版本已变化 请重新选择" });
        return { data, sources: [{ owner: "orders", kind: "order", id: data.id, versionId: null, revision: data.latestEventSequence }] };
      }
      case "finance.profit_run": {
        const data = projection(agentResourceDataSchemas[call.tool], await this.finance.getProfitRun(context, call.input.runId));
        if (data.id !== call.input.runId) missing();
        return { data, sources: [{ owner: "finance", kind: "profit_run", id: data.id, versionId: null, revision: null }] };
      }
      case "advertising.analysis": {
        const record = await this.advertising.record(context, call.input.analysisId, { accountId: call.input.accountId, kind: "analyses" });
        if (record.accessMode !== "read") throw new OriginalOwnerError(403, { code: "agent_resources_read_required", message: "需要原账户广告读取权限" });
        if (record.record.kind !== "analyses") missing();
        const data = projection(agentResourceDataSchemas[call.tool], record.record.value);
        if (data.accountId !== call.input.accountId || data.id !== call.input.analysisId) missing();
        return { data, sources: [{ owner: "customer_intelligence", kind: "ad_analysis", id: data.id, versionId: null, revision: null }] };
      }
    }
  }
}
