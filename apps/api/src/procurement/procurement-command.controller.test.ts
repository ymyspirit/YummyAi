import { BadRequestException } from "@nestjs/common";
import { ForbiddenError, Permission } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { describe, expect, it, vi } from "vitest";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { ProcurementCommandController } from "./procurement-command.controller.js";
import type { ProcurementCommandService } from "./procurement-command.service.js";

const actions = ["execute", "cancel", "acknowledge"] as const;
function fixture(permissions: string[] = [Permission.ProcurementRead]) {
  const context: TenantContext = { tenantId: createEntityId(), userId: createEntityId(), permissions, dataScope: "tenant" };
  const request: AuthenticatedRequest = { headers: {}, tenantContext: context };
  const calls = { prepare: vi.fn(), list: vi.fn(), get: vi.fn(), execute: vi.fn(), cancel: vi.fn(), acknowledge: vi.fn() };
  const controller = new ProcurementCommandController(calls as unknown as ProcurementCommandService);
  return { controller, calls, context, request, id: createEntityId() };
}

describe("strict procurement command HTTP boundary", () => {
  it.each(actions)("rejects missing, null or replacement bodies for %s before calling the service", action => {
    const f = fixture();
    for (const body of [undefined, null, [], "", { decision: "approved" }, { input: {} }, { idempotencyKey: "new-request-key" }])
      expect(() => f.controller[action](f.request, f.id, body)).toThrow(BadRequestException);
    expect(f.calls[action]).not.toHaveBeenCalled();
  });

  it.each(actions)("accepts only an empty body and a normalized command identity for %s", action => {
    const f = fixture();
    f.controller[action](f.request, f.id.toUpperCase(), {});
    expect(f.calls[action]).toHaveBeenCalledExactlyOnceWith(f.context, f.id);
    f.calls[action].mockClear();
    expect(() => f.controller[action](f.request, "invalid-command-id", {})).toThrow(BadRequestException);
    expect(f.calls[action]).not.toHaveBeenCalled();
  });

  it.each(actions)("checks procurement read rights before parsing private %s input", action => {
    const f = fixture([]);
    expect(() => f.controller[action](f.request, "invalid-command-id", null)).toThrow(ForbiddenError);
    expect(f.calls[action]).not.toHaveBeenCalled();
  });

  it("refuses unauthorized prepare, list and get before forwarding any private request", () => {
    const f = fixture([]);
    expect(() => f.controller.prepare(f.request, { tenantId: createEntityId(), authoritySnapshot: "synthetic-expansion" })).toThrow(ForbiddenError);
    expect(() => f.controller.list(f.request, { before: "invalid-cursor" })).toThrow(ForbiddenError);
    expect(() => f.controller.command(f.request, "invalid-command-id")).toThrow(ForbiddenError);
    for (const call of Object.values(f.calls)) expect(call).not.toHaveBeenCalled();
  });
});
