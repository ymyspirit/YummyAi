import { createHash } from "node:crypto";

import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import {
  MarketplaceAutomationRuleViewSchema,
  MarketplaceAutomationRunViewSchema,
  createEntityId,
  type CreateMarketplaceAutomationRuleInput,
  type MarketplaceAutomationAction,
  type MarketplaceAutomationConditions,
  type MarketplaceAutomationRuleView,
  type MarketplaceAutomationRunStatus,
  type MarketplaceAutomationRunView,
  type TenantContext,
  type UpdateMarketplaceAutomationRuleInput,
} from "@yummyai/contracts";
import {
  listingVersions,
  listings,
  marketplaceAutomationRules,
  marketplaceAutomationRuns,
  type DatabaseConnection,
  withTenant,
} from "@yummyai/database";
import { and, desc, eq } from "drizzle-orm";

import { AuditService } from "../audit/audit.service.js";
import type { MarketplaceAutomationDispatcher } from "../listings/listing.service.js";
import { DATABASE_CONNECTION } from "../platform.tokens.js";
import { MarketplaceListingSyncService } from "./marketplace-listing-sync.service.js";
import { MarketplacePublicationService } from "./marketplace-publication.service.js";

@Injectable()
export class MarketplaceAutomationService implements MarketplaceAutomationDispatcher {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(MarketplacePublicationService) private readonly publications: MarketplacePublicationService,
    @Inject(MarketplaceListingSyncService) private readonly listingSyncs: MarketplaceListingSyncService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async create(context: TenantContext, input: CreateMarketplaceAutomationRuleInput): Promise<MarketplaceAutomationRuleView> {
    const [rule] = await withTenant(this.database.db, context, (tx) => tx.insert(marketplaceAutomationRules).values({
      id: createEntityId(),
      tenantId: context.tenantId,
      name: input.name,
      trigger: input.trigger,
      conditions: input.conditions,
      action: input.action,
      enabled: input.enabled,
      createdBy: context.userId,
    }).returning());
    await this.audit.record(context, {
      action: "marketplace_automation_rule.create",
      resourceType: "marketplace_automation_rule",
      resourceId: rule!.id,
      result: "success",
      metadata: { enabled: rule!.enabled, trigger: rule!.trigger, actionType: input.action.type },
    });
    return toRuleView(rule!);
  }

  async list(context: TenantContext): Promise<MarketplaceAutomationRuleView[]> {
    const rows = await withTenant(this.database.db, context, (tx) => tx.select().from(marketplaceAutomationRules).orderBy(desc(marketplaceAutomationRules.updatedAt)));
    return rows.map(toRuleView);
  }

  async update(context: TenantContext, ruleId: string, input: UpdateMarketplaceAutomationRuleInput): Promise<MarketplaceAutomationRuleView> {
    const [updated] = await withTenant(this.database.db, context, (tx) => tx.update(marketplaceAutomationRules).set({ ...input, updatedAt: new Date() }).where(eq(marketplaceAutomationRules.id, ruleId)).returning());
    if (!updated) throw new NotFoundException("Marketplace automation rule not found");
    await this.audit.record(context, {
      action: "marketplace_automation_rule.update",
      resourceType: "marketplace_automation_rule",
      resourceId: ruleId,
      result: "success",
      metadata: { changedFields: Object.keys(input) },
    });
    return toRuleView(updated);
  }

  async runs(context: TenantContext, ruleId: string): Promise<MarketplaceAutomationRunView[]> {
    const [rule] = await withTenant(this.database.db, context, (tx) => tx.select({ id: marketplaceAutomationRules.id }).from(marketplaceAutomationRules).where(eq(marketplaceAutomationRules.id, ruleId)).limit(1));
    if (!rule) throw new NotFoundException("Marketplace automation rule not found");
    const rows = await withTenant(this.database.db, context, (tx) => tx.select().from(marketplaceAutomationRuns).where(eq(marketplaceAutomationRuns.ruleId, ruleId)).orderBy(desc(marketplaceAutomationRuns.occurredAt)).limit(100));
    return rows.map(toRunView);
  }

  async dispatchListingApproved(context: TenantContext, listingId: string, listingVersionId: string): Promise<void> {
    const snapshot = await withTenant(this.database.db, context, async (tx) => {
      const [[listing], [version], rules] = await Promise.all([
        tx.select().from(listings).where(eq(listings.id, listingId)).limit(1),
        tx.select().from(listingVersions).where(and(eq(listingVersions.id, listingVersionId), eq(listingVersions.listingId, listingId))).limit(1),
        tx.select().from(marketplaceAutomationRules).where(and(eq(marketplaceAutomationRules.enabled, true), eq(marketplaceAutomationRules.trigger, "listing_approved"))).orderBy(marketplaceAutomationRules.createdAt),
      ]);
      if (!listing || !version) throw new ConflictException("Approved Listing automation snapshot is incomplete");
      return { listing, version, rules };
    });

    for (const rule of snapshot.rules) {
      const triggerKey = checksum({ version: 1, ruleId: rule.id, listingVersionId });
      const exists = await withTenant(this.database.db, context, (tx) => tx.select({ id: marketplaceAutomationRuns.id }).from(marketplaceAutomationRuns).where(and(eq(marketplaceAutomationRuns.ruleId, rule.id), eq(marketplaceAutomationRuns.triggerKey, triggerKey))).limit(1));
      if (exists.length) continue;
      if (!matches(rule.conditions, snapshot.listing, snapshot.version)) {
        await this.recordRun(context, rule.id, listingId, listingVersionId, triggerKey, "skipped", null, null, "AUTOMATION_CONDITIONS_NOT_MET", "Listing did not match the rule conditions");
        continue;
      }
      try {
        const output = await this.execute(context, rule.action, listingId, listingVersionId, rule.id);
        await this.recordRun(context, rule.id, listingId, listingVersionId, triggerKey, "enqueued", output.type, output.id, null, null);
      } catch (error) {
        await this.recordRun(context, rule.id, listingId, listingVersionId, triggerKey, "failed", null, null, "AUTOMATION_ACTION_REJECTED", error instanceof Error ? error.message : "Automation action failed");
      }
    }
  }

  private async execute(context: TenantContext, action: MarketplaceAutomationAction, listingId: string, listingVersionId: string, ruleId: string) {
    if (action.type === "queue_publication") {
      const request = await this.publications.create(context, {
        accountId: action.accountId,
        listingId,
        listingVersionId,
        marketplaceId: action.marketplaceId,
        variantSkuId: action.variantSkuId,
      });
      return { id: request.id, type: "marketplace_publication_request" };
    }
    const request = await this.listingSyncs.create(context, {
      accountId: action.accountId,
      listingId,
      listingVersionId,
      sourcePublicationRequestId: action.sourcePublicationRequestId,
      action: action.action,
      requestKey: ruleId,
    });
    return { id: request.id, type: "marketplace_listing_sync_request" };
  }

  private async recordRun(context: TenantContext, ruleId: string, listingId: string, listingVersionId: string, triggerKey: string, status: MarketplaceAutomationRunStatus, outputType: string | null, outputId: string | null, code: string | null, message: string | null) {
    await withTenant(this.database.db, context, (tx) => tx.insert(marketplaceAutomationRuns).values({
      id: createEntityId(), tenantId: context.tenantId, ruleId, listingId, listingVersionId, triggerKey,
      status, outputType, outputId, code, message, actorUserId: context.userId,
    }).onConflictDoNothing());
  }
}

type ListingRow = typeof listings.$inferSelect;
type ListingVersionRow = typeof listingVersions.$inferSelect;
type RuleRow = typeof marketplaceAutomationRules.$inferSelect;
type RunRow = typeof marketplaceAutomationRuns.$inferSelect;

function matches(conditions: MarketplaceAutomationConditions, listing: ListingRow, version: ListingVersionRow): boolean {
  return (!conditions.listingId || conditions.listingId === listing.id)
    && (!conditions.platform || conditions.platform === listing.platform)
    && (!conditions.locale || conditions.locale === listing.locale)
    && version.validation.completeness >= conditions.minimumCompleteness;
}

function toRuleView(rule: RuleRow): MarketplaceAutomationRuleView {
  return MarketplaceAutomationRuleViewSchema.parse({ ...rule, createdAt: rule.createdAt.toISOString(), updatedAt: rule.updatedAt.toISOString() });
}

function toRunView(run: RunRow): MarketplaceAutomationRunView {
  return MarketplaceAutomationRunViewSchema.parse({ ...run, occurredAt: run.occurredAt.toISOString() });
}

function checksum(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
