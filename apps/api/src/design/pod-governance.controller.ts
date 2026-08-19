import { Body, Controller, Get, Inject, Param, Post, Req } from "@nestjs/common";
import { Permission, authorize } from "@yummyai/authz";
import {
  CreateDesignRecipeVersionInputSchema,
  CreateListingArtifactBindingInputSchema,
  CreateRightsAssessmentInputSchema,
  CreateVisualFingerprintInputSchema,
  VisualSearchInputSchema,
} from "@yummyai/contracts";
import { z } from "zod";

import { RequiresPermission } from "../auth/permissions.decorator.js";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { PodGovernanceService } from "./pod-governance.service.js";

@Controller("v1/pod")
export class PodGovernanceController {
  constructor(@Inject(PodGovernanceService) private readonly governance: PodGovernanceService) {}

  @Get("recipes")
  @RequiresPermission(Permission.DesignRead)
  listRecipes(@Req() request: AuthenticatedRequest) {
    const context = requireContext(request);
    authorize(context, Permission.DesignRead);
    return this.governance.listRecipes(context);
  }

  @Post("recipes")
  @RequiresPermission(Permission.DesignWrite)
  createRecipe(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const context = requireContext(request);
    authorize(context, Permission.DesignWrite);
    return this.governance.createRecipe(context, CreateDesignRecipeVersionInputSchema.parse(body));
  }

  @Get("rights-assessments/:assetId")
  @RequiresPermission(Permission.DesignRead)
  listRightsAssessments(@Req() request: AuthenticatedRequest, @Param("assetId") assetId: string) {
    const context = requireContext(request);
    authorize(context, Permission.DesignRead);
    return this.governance.listRightsAssessments(context, z.uuidv7().parse(assetId));
  }

  @Post("rights-assessments")
  @RequiresPermission(Permission.DesignReview)
  createRightsAssessment(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const context = requireContext(request);
    authorize(context, Permission.DesignReview);
    return this.governance.createRightsAssessment(context, CreateRightsAssessmentInputSchema.parse(body));
  }

  @Post("visual-fingerprints")
  @RequiresPermission(Permission.DesignWrite)
  registerFingerprint(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const context = requireContext(request);
    authorize(context, Permission.DesignWrite);
    return this.governance.registerFingerprint(context, CreateVisualFingerprintInputSchema.parse(body));
  }

  @Post("visual-search")
  @RequiresPermission(Permission.DesignRead)
  visualSearch(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const context = requireContext(request);
    authorize(context, Permission.DesignRead);
    return this.governance.visualSearch(context, VisualSearchInputSchema.parse(body));
  }

  @Get("listing-artifacts/:listingVersionId")
  @RequiresPermission(Permission.DesignRead)
  listListingArtifacts(@Req() request: AuthenticatedRequest, @Param("listingVersionId") listingVersionId: string) {
    const context = requireContext(request);
    authorize(context, Permission.DesignRead);
    return this.governance.listListingArtifactBindings(context, z.uuidv7().parse(listingVersionId));
  }

  @Get("listing-options")
  @RequiresPermission(Permission.DesignRead)
  listingOptions(@Req() request: AuthenticatedRequest) {
    const context = requireContext(request);
    authorize(context, Permission.DesignRead);
    return this.governance.listingOptions(context);
  }

  @Post("listing-artifacts")
  @RequiresPermission(Permission.DesignWrite)
  createListingArtifact(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const context = requireContext(request);
    authorize(context, Permission.DesignWrite);
    return this.governance.createListingArtifactBinding(context, CreateListingArtifactBindingInputSchema.parse(body));
  }

  @Get("trace/assets/:assetId")
  @RequiresPermission(Permission.DesignRead)
  traceAsset(@Req() request: AuthenticatedRequest, @Param("assetId") assetId: string) {
    const context = requireContext(request);
    authorize(context, Permission.DesignRead);
    return this.governance.traceAsset(context, z.uuidv7().parse(assetId));
  }
}

function requireContext(request: AuthenticatedRequest) {
  if (!request.tenantContext) throw new Error("Tenant context is required");
  return request.tenantContext;
}
