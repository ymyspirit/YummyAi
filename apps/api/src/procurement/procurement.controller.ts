import { BadRequestException, Body, Controller, Get, Inject, Param, Post, Query, Req } from "@nestjs/common";
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
  ArchiveRecordInputSchema,
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
  workspace(@Req() request: AuthenticatedRequest, @Query("includeArchived") includeArchived?: string) {
    const context = requireContext(request);
    authorize(context, Permission.ProcurementRead);
    return this.service.workspace(context, parsed(z.enum(["true", "false"]).optional(), includeArchived) === "true");
  }

  @Post("requisitions")
  @RequiresPermission(Permission.ProcurementWrite)
  createRequisition(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const context = requireContext(request);
    authorize(context, Permission.ProcurementWrite);
    return this.service.createRequisition(context, parsed(CreateProcurementRequisitionInputSchema, body));
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
      parsed(z.uuidv7(), requisitionId),
      parsed(CreateProcurementRfqInputSchema, body),
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
      parsed(z.uuidv7(), rfqId),
      parsed(RecordProcurementSupplierQuoteInputSchema, body),
    );
  }

  @Post("purchase-orders/:id/archive")
  @RequiresPermission(Permission.ProcurementWrite)
  archivePurchaseOrder(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown) {
    const context = requireContext(request);
    authorize(context, Permission.ProcurementWrite);
    return this.service.archivePurchaseOrder(context, parsed(z.uuidv7(), id), parsed(ArchiveRecordInputSchema, body));
  }

  @Post("purchase-orders")
  @RequiresPermission(Permission.ProcurementWrite)
  createPurchaseOrder(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const context = requireContext(request);
    authorize(context, Permission.ProcurementWrite);
    return this.service.createPurchaseOrder(context, parsed(CreateInventoryPurchaseOrderInputSchema, body));
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
      parsed(z.uuidv7(), purchaseOrderId),
      parsed(ReviseInventoryPurchaseOrderInputSchema, body),
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
      parsed(z.uuidv7(), purchaseOrderId),
      parsed(ReviewInventoryPurchaseOrderInputSchema, body),
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
      parsed(z.uuidv7(), purchaseOrderId),
      parsed(RecordProcurementReceiptInputSchema, body),
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
      parsed(z.uuidv7(), purchaseOrderId),
      parsed(RecordProcurementInvoiceInputSchema, body),
    );
  }

  @Post("replenishment-policies")
  @RequiresPermission(Permission.ProcurementWrite)
  upsertPolicy(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const context = requireContext(request);
    authorize(context, Permission.ProcurementWrite);
    return this.service.upsertReplenishmentPolicy(
      context,
      parsed(UpsertReplenishmentPolicyInputSchema, body),
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
      parsed(z.uuidv7(), policyId),
      parsed(CreateReplenishmentSuggestionInputSchema, body),
    );
  }
}

function requireContext(request: AuthenticatedRequest) {
  if (!request.tenantContext) throw new Error("Tenant context is required");
  return request.tenantContext;
}

function parsed<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const result = schema.safeParse(value);
  if (!result.success) throw new BadRequestException("请求参数无效 请核对填写与当前版本");
  return result.data;
}
