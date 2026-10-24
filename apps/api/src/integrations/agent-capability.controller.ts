import { Controller, ForbiddenException, Get, Inject, Req } from "@nestjs/common";
import { intersectPermissionContexts } from "@yummyai/authz";
import { loadCurrentMembershipContext, memberships, withTenant, type DatabaseConnection } from "@yummyai/database";
import { and, eq } from "drizzle-orm";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { ApiClientMetadataRead } from "../auth/api-client-route.guard.js";
import { DATABASE_CONNECTION } from "../platform.tokens.js";
import { integrationAgentCatalog } from "./agent-capability.catalog.js";

@Controller("v1/integrations")
export class IntegrationAgentCapabilityController {
  constructor(@Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection) {}
  @Get("agent-capabilities")
  @ApiClientMetadataRead()
  catalog(@Req() request: AuthenticatedRequest) {
    const context = request.tenantContext;
    if (!context) throw new ForbiddenException("An authenticated member is required");
    return withTenant(this.database.db, context, async tx => {
      const [member] = await tx.select({ id: memberships.id }).from(memberships)
        .where(and(eq(memberships.userId, context.userId), eq(memberships.status, "active"))).limit(1).for("share");
      if (!member) throw new ForbiddenException("An active member is required");
      return integrationAgentCatalog(intersectPermissionContexts(context,
        await loadCurrentMembershipContext(tx, context, { lock: true })));
    });
  }
}
