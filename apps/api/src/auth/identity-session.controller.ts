import {
  BadRequestException,
  Controller,
  Get,
  Header,
  Inject,
  Query,
  Req,
  UnauthorizedException,
} from "@nestjs/common";
import { erpPermissionContext } from "@yummyai/authz";
import { ErpSessionQuerySchema, ErpSessionViewSchema } from "@yummyai/contracts/auth/session";
import {
  memberships,
  users,
  organizations,
  loadCurrentMembershipContext,
  withTenant,
  type DatabaseConnection,
} from "@yummyai/database";
import { and, eq } from "drizzle-orm";
import { DATABASE_CONNECTION } from "../platform.tokens.js";
import type { AuthenticatedRequest } from "./tenant-context.guard.js";
@Controller("v1/identity")
export class IdentitySessionController {
  constructor(@Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection) {}
  @Get("session")
  @Header("Cache-Control", "private, no-store")
  async session(@Req() request: AuthenticatedRequest, @Query() query: unknown) {
    const context = request.tenantContext;
    if (!context || request.authenticationKind !== "oidc") throw new UnauthorizedException();
    if (!ErpSessionQuerySchema.safeParse(query).success)
      throw new BadRequestException("此读取不接受查询参数");
    return withTenant(this.database.db, context, async (tx) => {
      const [member] = await tx
        .select({ displayName: users.displayName, organizationName: organizations.name })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .innerJoin(organizations, eq(organizations.id, memberships.tenantId))
        .where(and(eq(memberships.userId, context.userId), eq(memberships.status, "active")))
        .limit(1);
      if (!member) throw new UnauthorizedException();
      const current = erpPermissionContext(await loadCurrentMembershipContext(tx, context)),
        permissions = current.permissions;
      return ErpSessionViewSchema.parse({
        authenticated: true,
        canUseErp: permissions.length > 0,
        userId: context.userId,
        tenantId: context.tenantId,
        displayName: member.displayName,
        organizationName: member.organizationName,
        permissions,
        dataScope: current.dataScope,
        teamIds: current.teamIds,
        teamAuthority: current.teamAuthority,
        permissionScopes: Object.fromEntries(
          permissions.map((p) => [p, current.permissionScopes![p]]),
        ),
      });
    });
  }
}
