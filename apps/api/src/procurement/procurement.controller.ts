import { Body, Controller, Get, Inject, Param, Post, Req } from "@nestjs/common";
import { Permission, authorize } from "@yummyai/authz";
import {
  CreateInventoryPurchaseOrderInputSchema,
  CreateProcurementRequisitionInputSchema,
  CreateProcurementRfqInputSchema,
  CreateReplenishmentSuggestionInputSchema,
  RecordProcurementInvoiceInputSchema,
  RecordProcurementReceiptInputSchema,
  RecordProcurementSupplierQuoteInputSchema,
  ReviewInventoryPurchaseOrderInputSchema,
  ReviseInventoryPurchaseOrderInputSchema,
  UpsertReplenishmentPolicyInputSchema,
} from "@yummyai/contracts";
import { z } from "zod";

import { RequiresPermission } from "../auth/permissions.decorator.js";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { ProcurementService } from "./procurement.service.js";

@Controller("v1/procurement")
export class ProcurementController {
  constructor(@Inject(ProcurementService) private readonly service: ProcurementService) {}

  @Get("workspace")
  @RequiresPermission(Permission.ProcurementRead)
  workspace(@Req() request: AuthenticatedRequest) {
    const context = requireContext(request);
    authorize(context, Permission.ProcurementRead);
    return this.service.workspace(context);
  }

  @Post("requisitions")
  @RequiresPermission(Permission.ProcurementWrite)
  createRequisition(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const context = requireContext(request);
    authorize(context, Permission.ProcurementWrite);
    return this.service.createRequisition(context, CreateProcurementRequisitionInputSchema.parse(body));
  }

  @Post("requisitions/:requisitionId/rfqs")
  @RequiresPermission(Permission.ProcurementWrite)
  createRfq(
    @Req() request: AuthenticatedRequest,
    @Param("requisitionId") requisitionId: string,
    @Body() body: unknown,
  ) {
    const context = requireContext(request);
    authorize(context, Permission.ProcurementWrite);
    return this.service.createRfq(
      context,
      z.uuidv7().parse(requisitionId),
      CreateProcurementRfqInputSchema.parse(body),
    );
  }

  @Post("rfqs/:rfqId/quotes")
  @RequiresPermission(Permission.ProcurementWrite)
  recordQuote(
    @Req() request: AuthenticatedRequest,
    @Param("rfqId") rfqId: string,
    @Body() body: unknown,
  ) {
    const context = requireContext(request);
    authorize(context, Permission.ProcurementWrite);
    return this.service.recordSupplierQuote(
      context,
      z.uuidv7().parse(rfqId),
      RecordProcurementSupplierQuoteInputSchema.parse(body),
    );
  }

  @Post("purchase-orders")
  @RequiresPermission(Permission.ProcurementWrite)
  createPurchaseOrder(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const context = requireContext(request);
    authorize(context, Permission.ProcurementWrite);
    return this.service.createPurchaseOrder(context, CreateInventoryPurchaseOrderInputSchema.parse(body));
  }

  @Post("purchase-orders/:purchaseOrderId/revisions")
  @RequiresPermission(Permission.ProcurementWrite)
  revisePurchaseOrder(
    @Req() request: AuthenticatedRequest,
    @Param("purchaseOrderId") purchaseOrderId: string,
    @Body() body: unknown,
  ) {
    const context = requireContext(request);
    authorize(context, Permission.ProcurementWrite);
    return this.service.revisePurchaseOrder(
      context,
      z.uuidv7().parse(purchaseOrderId),
      ReviseInventoryPurchaseOrderInputSchema.parse(body),
    );
  }

  @Post("purchase-orders/:purchaseOrderId/reviews")
  @RequiresPermission(Permission.ProcurementApprove)
  reviewPurchaseOrder(
    @Req() request: AuthenticatedRequest,
    @Param("purchaseOrderId") purchaseOrderId: string,
    @Body() body: unknown,
  ) {
    const context = requireContext(request);
    authorize(context, Permission.ProcurementApprove);
    return this.service.reviewPurchaseOrder(
      context,
      z.uuidv7().parse(purchaseOrderId),
      ReviewInventoryPurchaseOrderInputSchema.parse(body),
    );
  }

  @Post("purchase-orders/:purchaseOrderId/receipts")
  @RequiresPermission(Permission.ProcurementWrite)
  recordReceipt(
    @Req() request: AuthenticatedRequest,
    @Param("purchaseOrderId") purchaseOrderId: string,
    @Body() body: unknown,
  ) {
    const context = requireContext(request);
    authorize(context, Permission.ProcurementWrite);
    return this.service.recordReceipt(
      context,
      z.uuidv7().parse(purchaseOrderId),
      RecordProcurementReceiptInputSchema.parse(body),
    );
  }

  @Post("purchase-orders/:purchaseOrderId/invoices")
  @RequiresPermission(Permission.ProcurementWrite)
  recordInvoice(
    @Req() request: AuthenticatedRequest,
    @Param("purchaseOrderId") purchaseOrderId: string,
    @Body() body: unknown,
  ) {
    const context = requireContext(request);
    authorize(context, Permission.ProcurementWrite);
    return this.service.recordInvoice(
      context,
      z.uuidv7().parse(purchaseOrderId),
      RecordProcurementInvoiceInputSchema.parse(body),
    );
  }

  @Post("replenishment-policies")
  @RequiresPermission(Permission.ProcurementWrite)
  upsertPolicy(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const context = requireContext(request);
    authorize(context, Permission.ProcurementWrite);
    return this.service.upsertReplenishmentPolicy(
      context,
      UpsertReplenishmentPolicyInputSchema.parse(body),
    );
  }

  @Post("replenishment-policies/:policyId/suggestions")
  @RequiresPermission(Permission.ProcurementWrite)
  createSuggestion(
    @Req() request: AuthenticatedRequest,
    @Param("policyId") policyId: string,
    @Body() body: unknown,
  ) {
    const context = requireContext(request);
    authorize(context, Permission.ProcurementWrite);
    return this.service.createReplenishmentSuggestion(
      context,
      z.uuidv7().parse(policyId),
      CreateReplenishmentSuggestionInputSchema.parse(body),
    );
  }
}

function requireContext(request: AuthenticatedRequest) {
  if (!request.tenantContext) throw new Error("Tenant context is required");
  return request.tenantContext;
}
