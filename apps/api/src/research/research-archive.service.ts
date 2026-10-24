import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { authorize, Permission } from "@yummyai/authz";
import type { TenantContext } from "@yummyai/contracts";
import { SetResearchArchivedInputSchema } from "@yummyai/contracts/research";
import { researchItems, withTenant, type DatabaseConnection } from "@yummyai/database";
import { and, inArray, sql } from "drizzle-orm";
import { AuditService } from "../audit/audit.service.js";
import { DATABASE_CONNECTION } from "../platform.tokens.js";
import { currentResearchAuthority, researchOwnerFilter } from "./research-access.js";

@Injectable()
export class ResearchArchiveService {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async setArchived(context: TenantContext, body: unknown) {
    authorize(context, Permission.ResearchWrite);
    const input = SetResearchArchivedInputSchema.parse(body);
    return withTenant(this.database.db, context, async (tx) => {
      const current = await currentResearchAuthority(tx, context),
        scope = researchOwnerFilter(context, current, Permission.ResearchWrite);
      const selected = await tx
        .select({ id: researchItems.id })
        .from(researchItems)
        .where(and(inArray(researchItems.id, input.itemIds), scope))
        .for("update");
      if (selected.length !== input.itemIds.length)
        throw new NotFoundException("One or more research items were not found");
      await tx
        .update(researchItems)
        .set({
          archivedAt: input.archived ? sql`coalesce(${researchItems.archivedAt}, now())` : null,
        })
        .where(and(inArray(researchItems.id, input.itemIds), scope));
      await this.audit.recordInTransaction(tx, context, {
        action: input.archived ? "research.archive" : "research.restore",
        resourceType: "research_item",
        result: "success",
        metadata: { itemIds: input.itemIds },
      });
      return { updated: selected.length, archived: input.archived };
    });
  }
}
