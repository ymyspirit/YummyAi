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
import { IntegrationApiScopeSchema, type TenantContext } from "@yummyai/contracts";
import type { DatabaseConnection } from "@yummyai/database";
import { sql } from "drizzle-orm";

import { type OidcClaims, TokenVerifier } from "./oidc-jwt.strategy.js";
import { PUBLIC_ROUTE } from "./public.decorator.js";

export interface AuthenticatedRequest {
  headers: Record<string, string | string[] | undefined>;
  tenantContext?: TenantContext;
}

export abstract class MembershipContextLoader {
  abstract load(claims: OidcClaims): Promise<TenantContext | null>;
}

export abstract class ApiClientContextLoader {
  abstract load(token: string): Promise<TenantContext | null>;
}

export class DatabaseApiClientContextLoader extends ApiClientContextLoader {
  constructor(private readonly database: DatabaseConnection) { super(); }

  async load(token: string): Promise<TenantContext | null> {
    const match = /^yai_([0-9a-f-]{36})\.[A-Za-z0-9_-]{40,}$/i.exec(token);
    if (!match) return null;
    const digest = createHash("sha256").update(token).digest("hex");
    const rows = await this.database.db.transaction(async (tx) => {
      await tx.execute(sql.raw("set local role yummyai_app"));
      return tx.execute(sql<Record<string, unknown>>`
        select tenant_id, created_by, scopes
        from authenticate_integration_api_client(${match[1]}::uuid, ${digest})
      `);
    });
    const client = rows[0];
    if (!client || typeof client.tenant_id !== "string" || typeof client.created_by !== "string") return null;
    const scopes = Array.isArray(client.scopes) ? client.scopes.flatMap((scope) => {
      const parsed = IntegrationApiScopeSchema.safeParse(scope);
      return parsed.success ? [parsed.data] : [];
    }) : [];
    if (!scopes.length) return null;
    return { tenantId: client.tenant_id, userId: client.created_by, permissions: scopes.sort(), dataScope: "tenant" };
  }
}

interface MembershipRow {
  data_scopes: string[] | null;
  permissions: string[] | null;
  status: string;
  tenant_id: string;
  user_id: string;
}

export class DatabaseMembershipContextLoader extends MembershipContextLoader {
  constructor(private readonly database: DatabaseConnection) {
    super();
  }

  async load(claims: OidcClaims): Promise<TenantContext | null> {
    const rows = await this.database.client.unsafe<MembershipRow[]>(
      `select
         m.tenant_id,
         m.user_id,
         m.status,
         coalesce(array_agg(distinct permission.value) filter (where permission.value is not null), '{}') as permissions,
         coalesce(array_agg(distinct r.data_scope) filter (where r.data_scope is not null), '{}') as data_scopes
       from app_users u
       join memberships m on m.user_id = u.id
       left join membership_roles mr on mr.membership_id = m.id and mr.tenant_id = m.tenant_id
       left join roles r on r.id = mr.role_id and r.tenant_id = m.tenant_id
       left join lateral jsonb_array_elements_text(coalesce(r.permissions, '[]'::jsonb)) permission(value) on true
       where u.oidc_subject = $1 and m.tenant_id = $2
       group by m.tenant_id, m.user_id, m.status`,
      [claims.sub, claims.tenant_id],
    );
    const membership = rows[0];

    if (!membership || membership.status !== "active") {
      return null;
    }

    const dataScope = membership.data_scopes?.includes("tenant")
      ? "tenant"
      : membership.data_scopes?.includes("team")
        ? "team"
        : "self";

    return {
      tenantId: membership.tenant_id,
      userId: membership.user_id,
      permissions: [...(membership.permissions ?? [])].sort(),
      dataScope,
    };
  }
}

@Injectable()
export class TenantContextGuard implements CanActivate {
  constructor(
    @Inject(TokenVerifier) private readonly verifier: TokenVerifier,
    @Inject(MembershipContextLoader) private readonly memberships: MembershipContextLoader,
    @Optional() @Inject(ApiClientContextLoader) private readonly apiClients?: ApiClientContextLoader,
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
      if (!tenantContext) throw new UnauthorizedException("The API client token is invalid, expired, or revoked");
      request.tenantContext = tenantContext;
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
    return true;
  }
}

function bearerToken(authorization: string | string[] | undefined): string | null {
  if (typeof authorization !== "string") return null;
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  return match?.[1] ?? null;
}
