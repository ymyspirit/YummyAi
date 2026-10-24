import { BadRequestException } from "@nestjs/common";
import { HEADERS_METADATA, HTTP_CODE_METADATA } from "@nestjs/common/constants.js";
import { Permission } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { describe, expect, it, vi } from "vitest";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { FinanceCommandController } from "./finance-command.controller.js";
import type { FinanceCommandService } from "./finance-command.service.js";

const actions = ["execute", "cancel", "acknowledge"] as const;
function fixture(permission: string = Permission.FinanceWrite) {
  const context: TenantContext = { tenantId: createEntityId(), userId: createEntityId(), permissions: [permission], dataScope: "tenant" };
  const calls = { prepare: vi.fn(), list: vi.fn(), get: vi.fn(), original: vi.fn(), execute: vi.fn(), cancel: vi.fn(), acknowledge: vi.fn(),
    recordedResult: vi.fn(), recordedResultEntries: vi.fn() };
  return { calls, context, id: createEntityId(), request: { headers: {}, tenantContext: context } as AuthenticatedRequest,
    controller: new FinanceCommandController(calls as unknown as FinanceCommandService) };
}
describe("explicit finance command HTTP boundary", () => {
  it.each(actions)("rejects null, omitted or replacement %s bodies without calling the owner transport", action => {
    const f = fixture();
    for (const body of [undefined, null, [], "", { input: {} }, { approved: true }, { idempotencyKey: "replacement-key" }])
      expect(() => f.controller[action](f.request, f.id, body)).toThrow(BadRequestException);
    expect(f.calls[action]).not.toHaveBeenCalled();
  });
  it.each(actions)("passes only authenticated context and a normalized ID for empty %s", action => {
    const f = fixture(); f.controller[action](f.request, f.id.toUpperCase(), {});
    expect(f.calls[action]).toHaveBeenCalledExactlyOnceWith(f.context, f.id);
    f.calls[action].mockClear(); expect(() => f.controller[action](f.request, "caller-selected", {})).toThrow(BadRequestException);
    expect(f.calls[action]).not.toHaveBeenCalled();
  });
  it.each([Permission.FinanceWrite, Permission.FinanceReview])( "delegates current OR authority for %s without adding a FinanceRead prerequisite", permission => {
    const f = fixture(permission); f.controller.command(f.request, f.id, {}); f.controller.original(f.request, f.id, {});
    expect(f.calls.get).toHaveBeenCalledExactlyOnceWith(f.context, f.id); expect(f.calls.original).toHaveBeenCalledExactlyOnceWith(f.context, f.id);
  });
  it("leaves root query normalization to the single service parser without replacing authenticated authority", () => {
    const f = fixture(), query = { kind: "bill_record", targetId: "root" };
    f.controller.list(f.request, query); expect(f.calls.list).toHaveBeenCalledExactlyOnceWith(f.context, query);
    for (const raw of [{ targetId: null }, { targetId: ["root", f.id] }, { tenantId: createEntityId() }, { original: true }]) {
      // The service is responsible for strict list-query validation; no parsed
      // null is passed back through a string-only HTTP parser by this boundary.
      f.calls.list.mockClear(); f.controller.list(f.request, raw); expect(f.calls.list).toHaveBeenCalledExactlyOnceWith(f.context, raw);
    }
  });
  it("rejects extra detail queries and never substitutes a caller tenant for the authenticated context", () => {
    const f = fixture();
    for (const query of [{ original: "true" }, { tenantId: createEntityId() }, { before: f.id }]) {
      expect(() => f.controller.command(f.request, f.id, query)).toThrow(BadRequestException);
      expect(() => f.controller.original(f.request, f.id, query)).toThrow(BadRequestException);
    }
    expect(f.calls.get).not.toHaveBeenCalled(); expect(f.calls.original).not.toHaveBeenCalled();
    expect(() => f.controller.command({ headers: {} } as AuthenticatedRequest, f.id, {})).toThrow("Tenant context is required");
    expect(f.calls.get).not.toHaveBeenCalled();
  });
  it("pins creation201, update200 and private no-store on all seven handlers", () => {
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, FinanceCommandController.prototype.prepare)).toBe(201);
    for (const action of actions) expect(Reflect.getMetadata(HTTP_CODE_METADATA, FinanceCommandController.prototype[action])).toBe(200);
    for (const method of ["prepare", "list", "command", "original", ...actions] as const)
      expect(Reflect.getMetadata(HEADERS_METADATA, FinanceCommandController.prototype[method])).toContainEqual({ name: "Cache-Control", value: "private, no-store" });
  });
});

describe("historical finance receipt HTTP boundary", () => {
  it.each([Permission.FinanceRead, Permission.FinanceWrite, Permission.FinanceReview])("delegates recorded receipt and entries for current OR %s authority", permission => {
    const f = fixture(permission), query = { section: "cost_shares", limit: "100", cursor: "canonical-position-validated-by-owner" };
    f.controller.recordedResult(f.request, f.id.toUpperCase(), {});
    f.controller.recordedResultEntries(f.request, f.id.toUpperCase(), query);
    expect(f.calls.recordedResult).toHaveBeenCalledExactlyOnceWith(f.context, f.id);
    expect(f.calls.recordedResultEntries).toHaveBeenCalledExactlyOnceWith(f.context, f.id, query);
  });
  it("does not accept a replacement result or a query-selected tenant on the recorded header", () => {
    const f = fixture();
    for (const query of [{ resultId: createEntityId() }, { tenantId: createEntityId() }, { original: "true" }, { limit: "25" }])
      expect(() => f.controller.recordedResult(f.request, f.id, query)).toThrow(BadRequestException);
    expect(f.calls.recordedResult).not.toHaveBeenCalled();
    for (const method of ["recordedResult", "recordedResultEntries"] as const)
      expect(() => f.controller[method](f.request, "caller-result", {})).toThrow(BadRequestException);
    expect(f.calls.recordedResultEntries).not.toHaveBeenCalled();
  });
  it("requires authenticated context for both receipt reads and marks both private no-store", () => {
    const f = fixture();
    for (const method of ["recordedResult", "recordedResultEntries"] as const) {
      expect(() => f.controller[method]({ headers: {} } as AuthenticatedRequest, f.id, {})).toThrow("Tenant context is required");
      expect(f.calls[method]).not.toHaveBeenCalled();
      expect(Reflect.getMetadata(HEADERS_METADATA, FinanceCommandController.prototype[method])).toContainEqual({ name: "Cache-Control", value: "private, no-store" });
    }
  });
});
