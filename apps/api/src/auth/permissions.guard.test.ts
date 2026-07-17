import {
  type ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { Permission } from "@yummyai/authz";
import type { TenantContext } from "@yummyai/contracts";
import { describe, expect, it, vi } from "vitest";

import { PermissionsGuard } from "./permissions.guard.js";
import { type OidcClaims, TokenVerifier } from "./oidc-jwt.strategy.js";
import {
  type AuthenticatedRequest,
  MembershipContextLoader,
  TenantContextGuard,
} from "./tenant-context.guard.js";

const context: TenantContext = {
  tenantId: "019b0000-0000-7000-8000-000000000001",
  userId: "019b0000-0000-7000-8000-000000000002",
  permissions: [Permission.CaptureWrite],
  dataScope: "tenant",
};

class FakeVerifier extends TokenVerifier {
  verify = vi.fn<(_token: string) => Promise<OidcClaims>>();
}

class FakeMemberships extends MembershipContextLoader {
  load = vi.fn<(_claims: OidcClaims) => Promise<TenantContext | null>>();
}

function executionContext(request: AuthenticatedRequest): ExecutionContext {
  return {
    getClass: () => class TestController {},
    getHandler: () => () => undefined,
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => ({}),
      getNext: () => undefined,
    }),
  } as unknown as ExecutionContext;
}

const claims = {
  sub: "keycloak-user",
  tenant_id: context.tenantId,
  iss: "http://localhost:8081/realms/yummyai",
  aud: "yummyai-api",
  exp: Math.floor(Date.now() / 1000) + 300,
} satisfies OidcClaims;

describe("authentication and permission guards", () => {
  it("rejects a missing token", async () => {
    const guard = new TenantContextGuard(new FakeVerifier(), new FakeMemberships());
    await expect(guard.canActivate(executionContext({ headers: {} }))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it.each(["expired token", "wrong audience"])("rejects an %s", async () => {
    const verifier = new FakeVerifier();
    verifier.verify.mockRejectedValue(new Error("JWT verification failed"));
    const guard = new TenantContextGuard(verifier, new FakeMemberships());

    await expect(
      guard.canActivate(executionContext({ headers: { authorization: "Bearer bad" } })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("rejects a disabled membership", async () => {
    const verifier = new FakeVerifier();
    verifier.verify.mockResolvedValue(claims);
    const memberships = new FakeMemberships();
    memberships.load.mockResolvedValue(null);
    const guard = new TenantContextGuard(verifier, memberships);

    await expect(
      guard.canActivate(executionContext({ headers: { authorization: "Bearer valid" } })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("constructs tenant context for a valid request", async () => {
    const verifier = new FakeVerifier();
    verifier.verify.mockResolvedValue(claims);
    const memberships = new FakeMemberships();
    memberships.load.mockResolvedValue(context);
    const request: AuthenticatedRequest = { headers: { authorization: "Bearer valid" } };
    const guard = new TenantContextGuard(verifier, memberships);

    await expect(guard.canActivate(executionContext(request))).resolves.toBe(true);
    expect(request.tenantContext).toEqual(context);
  });

  it("rejects a missing permission", () => {
    const reflector = new Reflector();
    vi.spyOn(reflector, "getAllAndOverride").mockReturnValue([Permission.ListingReview]);
    const guard = new PermissionsGuard(reflector);

    expect(() =>
      guard.canActivate(executionContext({ headers: {}, tenantContext: context })),
    ).toThrow(ForbiddenException);
  });
});
