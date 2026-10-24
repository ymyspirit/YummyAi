import type { ExecutionContext } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import type { TenantContext } from "@yummyai/contracts";
import { TenantContextGuard, type AuthenticatedRequest } from "./tenant-context.guard.js";

const actor: TenantContext = {
  tenantId: "019f0000-0000-7000-8000-000000000001",
  userId: "019f0000-0000-7000-8000-000000000002",
  permissions: ["product:read"],
  dataScope: "self",
};
function context(request: AuthenticatedRequest) {
  return { switchToHttp: () => ({ getRequest: () => request }) } as unknown as ExecutionContext;
}
describe("authenticated credential kind", () => {
  it("marks a verified OIDC member and ignores caller identity headers", async () => {
    const verify = vi
        .fn()
        .mockResolvedValue({ sub: "synthetic-subject", tenant_id: actor.tenantId }),
      load = vi.fn().mockResolvedValue(actor),
      apiLoad = vi.fn();
    const guard = new TenantContextGuard({ verify }, { load }, { load: apiLoad });
    const request: AuthenticatedRequest = {
      headers: {
        authorization: "Bearer synthetic-oidc-token",
        "x-tenant-id": "untrusted-tenant",
        "x-authentication-kind": "api_client",
      },
    };
    expect(await guard.canActivate(context(request))).toBe(true);
    expect(request.authenticationKind).toBe("oidc");
    expect(request.tenantContext).toEqual(actor);
    expect(apiLoad).not.toHaveBeenCalled();
  });
  it("never presents a scoped integration API client as a personal OIDC identity", async () => {
    const verify = vi.fn(),
      load = vi.fn(),
      apiLoad = vi.fn().mockResolvedValue(actor);
    const guard = new TenantContextGuard({ verify }, { load }, { load: apiLoad });
    const request: AuthenticatedRequest = {
      headers: { authorization: "Bearer yai_synthetic-client" },
    };
    expect(await guard.canActivate(context(request))).toBe(true);
    expect(request.authenticationKind).toBe("api_client");
    expect(verify).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
  });
});
