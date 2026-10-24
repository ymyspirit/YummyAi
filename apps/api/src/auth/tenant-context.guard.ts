import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  Optional,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { createHash } from "node:crypto";
import { IntegrationApiDelegationSchema, IntegrationApiScopeSchema, type TenantContext } from "@yummyai/contracts";
import {
  factoryAccessGrants,
  fulfillmentFactories,
  fulfillmentSuppliers,
  memberships,
  integrationApiClients,
  loadCurrentMembershipContext,
  withTenant,
  type DatabaseConnection,
} from "@yummyai/database";
import { intersectPermissionContexts, summarizeRoleGrants, Permission } from "@yummyai/authz";
import { and, eq, isNull, sql } from "drizzle-orm";

import { type OidcClaims, TokenVerifier } from "./oidc-jwt.strategy.js";
import { PUBLIC_ROUTE } from "./public.decorator.js";

export interface AuthenticatedRequest {
  headers: Record<string, string | string[] | undefined>;
  tenantContext?: TenantContext;
  authenticationKind?: "oidc" | "api_client";
}

export abstract class MembershipContextLoader {
  abstract load(claims: OidcClaims): Promise<TenantContext | null>;
}

export abstract class ApiClientContextLoader {
  abstract load(token: string): Promise<TenantContext | null>;
}

export class DatabaseApiClientContextLoader extends ApiClientContextLoader {
  constructor(private readonly database: DatabaseConnection) {
    super();
  }

  async load(token: string): Promise<TenantContext | null> {
    const match = /^yai_([0-9a-f-]{36})\.[A-Za-z0-9_-]{40,}$/i.exec(token);
    if (!match) return null;
    const digest = createHash("sha256").update(token).digest("hex");
    const rows = await this.database.db.transaction(async (tx) => {
      await tx.execute(sql.raw("set local role yummyai_app"));
      return tx.execute(sql<Record<string, unknown>>`
        select tenant_id, created_by, scopes, delegation
        from authenticate_integration_api_client_v2(${match[1]}::uuid, ${digest})
      `);
    });
    const client = rows[0];
    if (!client || typeof client.tenant_id !== "string" || typeof client.created_by !== "string")
      return null;
    const parsedScopes = IntegrationApiScopeSchema.array().min(1).max(9).safeParse(client.scopes);
    const parsedDelegation = IntegrationApiDelegationSchema.safeParse(client.delegation);
    if (!parsedScopes.success || !parsedDelegation.success) return null;
    const scopes = parsedScopes.data, delegation = parsedDelegation.data;
    if (new Set(scopes).size !== scopes.length || Object.keys(delegation.permissionScopes).length !== scopes.length ||
      scopes.some(scope => !delegation.permissionScopes[scope])) return null;
    const ceiling: TenantContext = { tenantId: client.tenant_id, userId: client.created_by,
      ...summarizeRoleGrants(scopes.map(scope => ({ permissions: [scope], scope: delegation.permissionScopes[scope]! }))),
      teamIds: delegation.teamIds };
    return withTenant(this.database.db, ceiling, async tx => {
      const [live] = await tx.select({ id: integrationApiClients.id }).from(integrationApiClients)
        .where(and(eq(integrationApiClients.id, match[1]!), eq(integrationApiClients.secretDigest, digest),
          eq(integrationApiClients.status, "active"), sql`(${integrationApiClients.expiresAt} is null or ${integrationApiClients.expiresAt}>clock_timestamp())`))
        .limit(1).for("share");
      if (!live) return null;
      const [member] = await tx.select({ id: memberships.id }).from(memberships)
        .where(and(eq(memberships.userId, ceiling.userId), eq(memberships.status, "active"))).limit(1).for("share");
      if (!member || member.id !== delegation.membershipId) return null;
      const current = intersectPermissionContexts(ceiling, await loadCurrentMembershipContext(tx, ceiling, { lock: true }));
      return current.permissions.length ? current : null;
    });
  }
}

export class DatabaseMembershipContextLoader extends MembershipContextLoader {
  constructor(private readonly database: DatabaseConnection) {
    super();
  }

  async load(claims: OidcClaims): Promise<TenantContext | null> {
    // Only the global subject lookup precedes tenant context. Memberships,
    // role grants and factory assignments are read under the ordinary RLS role.
    const [user] = await this.database.client.unsafe<{ id: string }[]>(
      "select id from app_users where oidc_subject = $1 limit 1",
      [claims.sub],
    );
    if (!user) return null;
    const seed: TenantContext = {
      tenantId: claims.tenant_id,
      userId: user.id,
      permissions: [],
      dataScope: "self",
    };
    return withTenant(this.database.db, seed, async (tx) => {
      const [member] = await tx
        .select({ id: memberships.id })
        .from(memberships)
        .where(and(eq(memberships.userId, user.id), eq(memberships.status, "active")))
        .limit(1)
        .for("share");
      if (!member) return null;
      const base = await loadCurrentMembershipContext(tx, seed, { lock: true });
      // Factory grants supply only portal rights. Every task still verifies the
      // current member, grant and individual file assignment at its owning entry.
      const factoryRights = await tx
        .select({ canRespond: factoryAccessGrants.canRespond })
        .from(factoryAccessGrants)
        .innerJoin(
          memberships,
          and(
            eq(memberships.id, factoryAccessGrants.membershipId),
            eq(memberships.tenantId, factoryAccessGrants.tenantId),
          ),
        )
        .innerJoin(
          fulfillmentFactories,
          and(
            eq(fulfillmentFactories.id, factoryAccessGrants.factoryId),
            eq(fulfillmentFactories.tenantId, factoryAccessGrants.tenantId),
          ),
        )
        .innerJoin(
          fulfillmentSuppliers,
          and(
            eq(fulfillmentSuppliers.id, fulfillmentFactories.supplierId),
            eq(fulfillmentSuppliers.tenantId, fulfillmentFactories.tenantId),
          ),
        )
        .where(
          and(
            eq(memberships.userId, base.userId),
            eq(memberships.status, "active"),
            isNull(factoryAccessGrants.revokedAt),
            sql`${factoryAccessGrants.expiresAt}>clock_timestamp()`,
            eq(fulfillmentFactories.status, "active"),
            eq(fulfillmentSuppliers.status, "active"),
          ),
        );
      const extra = [
        ...(factoryRights.length ? [Permission.FactoryTaskRead] : []),
        ...(factoryRights.some((right) => right.canRespond) ? [Permission.FactoryTaskRespond] : []),
      ];
      return {
        ...base,
        permissions: [...new Set([...base.permissions, ...extra])].sort(),
        permissionScopes: {
          ...base.permissionScopes,
          ...Object.fromEntries(extra.map((p) => [p, "self" as const])),
        },
      };
    });
  }
}

@Injectable()
export class TenantContextGuard implements CanActivate {
  constructor(
    @Inject(TokenVerifier) private readonly verifier: TokenVerifier,
    @Inject(MembershipContextLoader) private readonly memberships: MembershipContextLoader,
    @Optional()
    @Inject(ApiClientContextLoader)
    private readonly apiClients?: ApiClientContextLoader,
    @Optional() @Inject(Reflector) private readonly reflector?: Reflector,
  ) {}

  async canActivate(executionContext: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector?.getAllAndOverride<boolean>(PUBLIC_ROUTE, [
      executionContext.getHandler(),
      executionContext.getClass(),
    ]);
    if (isPublic) return true;

    const request = executionContext.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = bearerToken(request.headers.authorization);

    if (!token) {
      throw new UnauthorizedException("A bearer token is required");
    }

    if (token.startsWith("yai_")) {
      const tenantContext = await this.apiClients?.load(token);
      if (!tenantContext)
        throw new UnauthorizedException("The API client token is invalid, expired, or revoked");
      request.tenantContext = tenantContext;
      request.authenticationKind = "api_client";
      return true;
    }

    let claims: OidcClaims;
    try {
      claims = await this.verifier.verify(token);
    } catch {
      throw new UnauthorizedException("The bearer token is invalid or expired");
    }

    const tenantContext = await this.memberships.load(claims);
    if (!tenantContext) {
      throw new ForbiddenException("No active membership exists for this tenant");
    }

    request.tenantContext = tenantContext;
    request.authenticationKind = "oidc";
    return true;
  }
}

function bearerToken(authorization: string | string[] | undefined): string | null {
  if (typeof authorization !== "string") return null;
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  return match?.[1] ?? null;
}
