import { BadRequestException } from "@nestjs/common";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { describe, expect, it, vi } from "vitest";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { ProcurementController } from "./procurement.controller.js";
import type { ProcurementService } from "./procurement.service.js";

const context: TenantContext = { tenantId: createEntityId(), userId: createEntityId(), dataScope: "tenant",
  permissions: ["procurement:read", "procurement:write", "procurement:approve"] };
const request: AuthenticatedRequest = { headers: {}, tenantContext: context };

describe("procurement HTTP input boundary", () => {
  it("rejects malformed bodies, paths and query flags as 400 before any business call", () => {
    const createRequisition = vi.fn(), createRfq = vi.fn(), recordSupplierQuote = vi.fn(), workspace = vi.fn(), createPurchaseOrder = vi.fn();
    const service = { createRequisition, createRfq, recordSupplierQuote, workspace, createPurchaseOrder };
    const controller = new ProcurementController(service as unknown as ProcurementService);
    for (const execute of [() => controller.createRequisition(request, {}), () => controller.createRfq(request, "invalid", {}),
      () => controller.recordQuote(request, createEntityId(), { supplierId: "invalid" }), () => controller.workspace(request, "truthy"),
      () => controller.createPurchaseOrder(request, { tenantId: createEntityId() })]) {
      expect(execute).toThrow(BadRequestException);
    }
    for (const handler of Object.values(service)) expect(handler).not.toHaveBeenCalled();
  });

  it("checks permission before inspecting private input fields", () => {
    const createRequisition = vi.fn();
    const controller = new ProcurementController({ createRequisition } as unknown as ProcurementService);
    try { controller.createRequisition({ headers: {}, tenantContext: { ...context, permissions: [] } }, {}); throw new Error("permission was not checked"); }
    catch (error) { expect(error).toMatchObject({ status: 403 }); }
    expect(createRequisition).not.toHaveBeenCalled();
  });
});
