import { Body, Controller, Get, Inject, Param, Post, Req } from "@nestjs/common";
import { Permission, authorize } from "@yummyai/authz";
import {
  CreatePersonalizationTemplateVersionInputSchema,
  ClonePersonalizationTemplateInputSchema,
  CreateProductionManifestInputSchema,
  CreateSkuTemplateBindingInputSchema,
  CreateTemplateSourceInspectionInputSchema,
  ConfirmTemplateSourceInspectionInputSchema,
  PodReviewDecisionInputSchema,
} from "@yummyai/contracts";
import { z } from "zod";

import { RequiresPermission } from "../auth/permissions.decorator.js";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { PodPersonalizationService } from "./pod-personalization.service.js";

@Controller("v1/pod")
export class PodPersonalizationController {
  constructor(@Inject(PodPersonalizationService) private readonly personalization: PodPersonalizationService) {}

  @Get("personalization-templates")
  @RequiresPermission(Permission.DesignRead)
  listTemplates(@Req() request: AuthenticatedRequest) {
    const context = requireContext(request);
    authorize(context, Permission.DesignRead);
    return this.personalization.listTemplates(context);
  }

  @Get("personalization-template-source-inspections")
  @RequiresPermission(Permission.DesignRead)
  listTemplateSourceInspections(@Req() request: AuthenticatedRequest) {
    const context = requireContext(request);
    authorize(context, Permission.DesignRead);
    return this.personalization.listTemplateSourceInspections(context);
  }

  @Post("personalization-template-source-inspections")
  @RequiresPermission(Permission.DesignWrite)
  createTemplateSourceInspection(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const context = requireContext(request);
    authorize(context, Permission.DesignWrite);
    return this.personalization.createTemplateSourceInspection(context, CreateTemplateSourceInspectionInputSchema.parse(body));
  }

  @Get("personalization-template-source-inspections/:id")
  @RequiresPermission(Permission.DesignRead)
  getTemplateSourceInspection(@Req() request: AuthenticatedRequest, @Param("id") id: string) {
    const context = requireContext(request);
    authorize(context, Permission.DesignRead);
    return this.personalization.getTemplateSourceInspection(context, z.uuidv7().parse(id));
  }

  @Post("personalization-template-source-inspections/:id/confirm")
  @RequiresPermission(Permission.DesignWrite)
  confirmTemplateSourceInspection(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown) {
    const context = requireContext(request);
    authorize(context, Permission.DesignWrite);
    return this.personalization.confirmTemplateSourceInspection(
      context,
      z.uuidv7().parse(id),
      ConfirmTemplateSourceInspectionInputSchema.parse(body),
    );
  }

  @Post("personalization-templates")
  @RequiresPermission(Permission.DesignWrite)
  createTemplate(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const context = requireContext(request);
    authorize(context, Permission.DesignWrite);
    return this.personalization.createTemplate(context, CreatePersonalizationTemplateVersionInputSchema.parse(body));
  }

  @Get("personalization-options")
  @RequiresPermission(Permission.DesignRead)
  personalizationOptions(@Req() request: AuthenticatedRequest) {
    const context = requireContext(request);
    authorize(context, Permission.DesignRead);
    return this.personalization.personalizationOptions(context);
  }

  @Post("personalization-templates/:id/clone")
  @RequiresPermission(Permission.DesignWrite)
  cloneTemplate(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown) {
    const context = requireContext(request);
    authorize(context, Permission.DesignWrite);
    return this.personalization.cloneTemplate(
      context,
      z.uuidv7().parse(id),
      ClonePersonalizationTemplateInputSchema.parse(body),
    );
  }

  @Post("personalization-templates/:id/review")
  @RequiresPermission(Permission.DesignReview)
  reviewTemplate(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown) {
    const context = requireContext(request);
    authorize(context, Permission.DesignReview);
    return this.personalization.reviewTemplate(context, z.uuidv7().parse(id), PodReviewDecisionInputSchema.parse(body));
  }

  @Get("template-bindings/:skuId")
  @RequiresPermission(Permission.DesignRead)
  listBindings(@Req() request: AuthenticatedRequest, @Param("skuId") skuId: string) {
    const context = requireContext(request);
    authorize(context, Permission.DesignRead);
    return this.personalization.listBindings(context, z.uuidv7().parse(skuId));
  }

  @Post("template-bindings")
  @RequiresPermission(Permission.DesignWrite)
  createBinding(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const context = requireContext(request);
    authorize(context, Permission.DesignWrite);
    return this.personalization.createBinding(context, CreateSkuTemplateBindingInputSchema.parse(body));
  }

  @Get("production-manifests")
  @RequiresPermission(Permission.DesignRead)
  listProductionManifests(@Req() request: AuthenticatedRequest) {
    const context = requireContext(request);
    authorize(context, Permission.DesignRead);
    return this.personalization.listProductionManifests(context);
  }

  @Post("production-manifests")
  @RequiresPermission(Permission.DesignWrite)
  createProductionManifest(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const context = requireContext(request);
    authorize(context, Permission.DesignWrite);
    return this.personalization.createProductionManifest(context, CreateProductionManifestInputSchema.parse(body));
  }

  @Post("production-manifests/:id/review")
  @RequiresPermission(Permission.DesignReview)
  reviewProductionManifest(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown) {
    const context = requireContext(request);
    authorize(context, Permission.DesignReview);
    return this.personalization.reviewProductionManifest(context, z.uuidv7().parse(id), PodReviewDecisionInputSchema.parse(body));
  }
}

function requireContext(request: AuthenticatedRequest) {
  if (!request.tenantContext) throw new Error("Tenant context is required");
  return request.tenantContext;
}
