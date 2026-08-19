import { Body, Controller, Get, Inject, Param, Post, Req } from "@nestjs/common";
import { Permission, authorize } from "@yummyai/authz";
import {
  CreateCanvasPrintSpecVersionInputSchema,
  CreateCreativeDesignBatchInputSchema,
  CreateCreativeDesignSkuBindingsInputSchema,
  CreateMockupBatchInputSchema,
  CreateMockupListingBindingsInputSchema,
  CreateMockupTemplateInspectionInputSchema,
  CreateMockupTemplatePackVersionInputSchema,
  ReviewMockupBatchInputSchema,
  ReviewVersionInputSchema,
} from "@yummyai/contracts";
import { z } from "zod";

import { RequiresPermission } from "../auth/permissions.decorator.js";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { PodBatchWorkflowService } from "./pod-batch-workflow.service.js";
import { PodMockupBatchService } from "./pod-mockup-batch.service.js";

@Controller("v1/pod")
export class PodBatchWorkflowController {
  constructor(
    @Inject(PodBatchWorkflowService) private readonly designs: PodBatchWorkflowService,
    @Inject(PodMockupBatchService) private readonly mockups: PodMockupBatchService,
  ) {}

  @Get("batch-capabilities")
  @RequiresPermission(Permission.DesignRead)
  capabilities(@Req() request: AuthenticatedRequest) {
    const context = requirePermission(request, Permission.DesignRead);
    return this.mockups.capabilities(context);
  }

  @Get("design-batches")
  @RequiresPermission(Permission.DesignRead)
  listDesignBatches(@Req() request: AuthenticatedRequest) {
    const context = requirePermission(request, Permission.DesignRead);
    return this.designs.listDesignBatches(context);
  }

  @Get("design-batches/options")
  @RequiresPermission(Permission.DesignRead)
  designOptions(@Req() request: AuthenticatedRequest) {
    const context = requirePermission(request, Permission.DesignRead);
    return this.designs.designOptions(context);
  }

  @Post("design-batches")
  @RequiresPermission(Permission.DesignWrite)
  createDesignBatch(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const context = requirePermission(request, Permission.DesignWrite);
    return this.designs.createDesignBatch(context, CreateCreativeDesignBatchInputSchema.parse(body));
  }

  @Get("design-batches/:id")
  @RequiresPermission(Permission.DesignRead)
  getDesignBatch(@Req() request: AuthenticatedRequest, @Param("id") id: string) {
    const context = requirePermission(request, Permission.DesignRead);
    return this.designs.getDesignBatch(context, entityId(id));
  }

  @Post("design-batches/:id/cancel")
  @RequiresPermission(Permission.DesignWrite)
  cancelDesignBatch(@Req() request: AuthenticatedRequest, @Param("id") id: string) {
    const context = requirePermission(request, Permission.DesignWrite);
    return this.designs.cancelDesignBatch(context, entityId(id));
  }

  @Post("design-batches/:id/items/:itemId/retry")
  @RequiresPermission(Permission.DesignWrite)
  retryDesignItem(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Param("itemId") itemId: string) {
    const context = requirePermission(request, Permission.DesignWrite);
    return this.designs.retryDesignItem(context, entityId(id), entityId(itemId));
  }

  @Post("design-batches/:id/candidates/:candidateId/select")
  @RequiresPermission(Permission.DesignWrite)
  selectCandidate(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Param("candidateId") candidateId: string) {
    const context = requirePermission(request, Permission.DesignWrite);
    return this.designs.selectCandidate(context, entityId(id), entityId(candidateId));
  }

  @Post("creative-design-versions/:id/review")
  @RequiresPermission(Permission.DesignReview)
  reviewCreativeVersion(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown) {
    const context = requirePermission(request, Permission.DesignReview);
    return this.designs.reviewCreativeVersion(context, entityId(id), ReviewVersionInputSchema.parse(body));
  }

  @Post("creative-design-versions/:id/sku-bindings")
  @RequiresPermission(Permission.DesignWrite)
  createSkuBindings(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown) {
    const context = requirePermission(request, Permission.DesignWrite);
    return this.designs.createSkuBindings(context, entityId(id), CreateCreativeDesignSkuBindingsInputSchema.parse(body));
  }

  @Get("print-specs")
  @RequiresPermission(Permission.DesignRead)
  listPrintSpecs(@Req() request: AuthenticatedRequest) {
    const context = requirePermission(request, Permission.DesignRead);
    return this.designs.listPrintSpecs(context);
  }

  @Post("print-specs")
  @RequiresPermission(Permission.DesignWrite)
  createPrintSpec(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const context = requirePermission(request, Permission.DesignWrite);
    return this.designs.createPrintSpec(context, CreateCanvasPrintSpecVersionInputSchema.parse(body));
  }

  @Post("print-specs/:versionId/review")
  @RequiresPermission(Permission.DesignReview)
  reviewPrintSpec(@Req() request: AuthenticatedRequest, @Param("versionId") versionId: string, @Body() body: unknown) {
    const context = requirePermission(request, Permission.DesignReview);
    return this.designs.reviewPrintSpec(context, entityId(versionId), ReviewVersionInputSchema.parse(body));
  }

  @Get("mockup-template-inspections")
  @RequiresPermission(Permission.DesignRead)
  listInspections(@Req() request: AuthenticatedRequest) {
    const context = requirePermission(request, Permission.DesignRead);
    return this.mockups.listInspections(context);
  }

  @Post("mockup-template-inspections")
  @RequiresPermission(Permission.DesignWrite)
  createInspection(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const context = requirePermission(request, Permission.DesignWrite);
    return this.mockups.createInspection(context, CreateMockupTemplateInspectionInputSchema.parse(body));
  }

  @Post("mockup-template-inspections/:id/confirm")
  @RequiresPermission(Permission.DesignReview)
  confirmInspection(@Req() request: AuthenticatedRequest, @Param("id") id: string) {
    const context = requirePermission(request, Permission.DesignReview);
    return this.mockups.confirmInspection(context, entityId(id));
  }

  @Get("mockup-template-packs")
  @RequiresPermission(Permission.DesignRead)
  listTemplatePacks(@Req() request: AuthenticatedRequest) {
    const context = requirePermission(request, Permission.DesignRead);
    return this.mockups.listTemplatePacks(context);
  }

  @Post("mockup-template-packs")
  @RequiresPermission(Permission.DesignWrite)
  createTemplatePack(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const context = requirePermission(request, Permission.DesignWrite);
    return this.mockups.createTemplatePack(context, CreateMockupTemplatePackVersionInputSchema.parse(body));
  }

  @Post("mockup-template-packs/:versionId/review")
  @RequiresPermission(Permission.DesignReview)
  reviewTemplatePack(@Req() request: AuthenticatedRequest, @Param("versionId") versionId: string, @Body() body: unknown) {
    const context = requirePermission(request, Permission.DesignReview);
    return this.mockups.reviewTemplatePack(context, entityId(versionId), ReviewVersionInputSchema.parse(body));
  }

  @Get("mockup-batches")
  @RequiresPermission(Permission.DesignRead)
  listMockupBatches(@Req() request: AuthenticatedRequest) {
    const context = requirePermission(request, Permission.DesignRead);
    return this.mockups.listBatches(context);
  }

  @Get("mockup-batches/options")
  @RequiresPermission(Permission.DesignRead)
  mockupOptions(@Req() request: AuthenticatedRequest) {
    const context = requirePermission(request, Permission.DesignRead);
    return this.mockups.batchOptions(context);
  }

  @Post("mockup-batches")
  @RequiresPermission(Permission.DesignWrite)
  createMockupBatch(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const context = requirePermission(request, Permission.DesignWrite);
    return this.mockups.createBatch(context, CreateMockupBatchInputSchema.parse(body));
  }

  @Get("mockup-batches/:id")
  @RequiresPermission(Permission.DesignRead)
  getMockupBatch(@Req() request: AuthenticatedRequest, @Param("id") id: string) {
    const context = requirePermission(request, Permission.DesignRead);
    return this.mockups.getBatch(context, entityId(id));
  }

  @Post("mockup-batches/:id/cancel")
  @RequiresPermission(Permission.DesignWrite)
  cancelMockupBatch(@Req() request: AuthenticatedRequest, @Param("id") id: string) {
    const context = requirePermission(request, Permission.DesignWrite);
    return this.mockups.cancelBatch(context, entityId(id));
  }

  @Post("mockup-batches/:id/outputs/:outputId/retry")
  @RequiresPermission(Permission.DesignWrite)
  retryMockupOutput(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Param("outputId") outputId: string) {
    const context = requirePermission(request, Permission.DesignWrite);
    return this.mockups.retryOutput(context, entityId(id), entityId(outputId));
  }

  @Post("mockup-batches/:id/review")
  @RequiresPermission(Permission.DesignReview)
  reviewMockupBatch(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown) {
    const context = requirePermission(request, Permission.DesignReview);
    return this.mockups.reviewBatch(context, entityId(id), ReviewMockupBatchInputSchema.parse(body));
  }

  @Post("mockup-batches/:id/listing-bindings")
  @RequiresPermission(Permission.DesignWrite)
  createListingBindings(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown) {
    const context = requirePermission(request, Permission.DesignWrite);
    return this.mockups.createListingBindings(context, entityId(id), CreateMockupListingBindingsInputSchema.parse(body));
  }
}

function requirePermission(request: AuthenticatedRequest, permission: Permission) {
  if (!request.tenantContext) throw new Error("Tenant context is required");
  authorize(request.tenantContext, permission);
  return request.tenantContext;
}

function entityId(value: string) {
  return z.uuidv7().parse(value);
}
