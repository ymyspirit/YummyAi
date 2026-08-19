import {
  Controller,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
  StreamableFile,
  Body,
} from "@nestjs/common";
import { Permission, authorize } from "@yummyai/authz";
import {
  CustomProductPackageExportModeSchema,
  GenerateProvisionalCustomProductProfileInputSchema,
  SaveCustomProductProfileInputSchema,
} from "@yummyai/contracts/catalog/custom-product-package";
import { z } from "zod";

import { RequiresPermission } from "../auth/permissions.decorator.js";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { CustomProductPackageService } from "./custom-product-package.service.js";
import { AmazonCustomListingMaterialsService } from "./amazon-custom-listing-materials.service.js";

@Controller("v1/products/plans/:planId/custom-package")
export class CustomProductPackageController {
  constructor(
    @Inject(CustomProductPackageService) private readonly packages: CustomProductPackageService,
    @Inject(AmazonCustomListingMaterialsService)
    private readonly listingMaterials: AmazonCustomListingMaterialsService,
  ) {}

  @Get("listing-materials/readiness")
  @RequiresPermission(Permission.ProductRead)
  listingMaterialsReadiness(@Req() request: AuthenticatedRequest, @Param("planId") planId: string) {
    const context = requireContext(request);
    authorize(context, Permission.ProductRead);
    return this.listingMaterials.readiness(context, z.uuidv7().parse(planId));
  }

  @Get("listing-materials")
  @RequiresPermission(Permission.ProductRead)
  async exportListingMaterials(
    @Req() request: AuthenticatedRequest,
    @Param("planId") planId: string,
  ) {
    const context = requireContext(request);
    authorize(context, Permission.ProductRead);
    const result = await this.listingMaterials.export(context, z.uuidv7().parse(planId));
    return new StreamableFile(Buffer.from(result.bytes), {
      type: "application/zip",
      disposition: `attachment; filename="${result.fileName}"`,
      length: result.bytes.byteLength,
    });
  }

  @Post("provisional")
  @RequiresPermission(Permission.ProductWrite)
  provisional(
    @Req() request: AuthenticatedRequest,
    @Param("planId") planId: string,
    @Body() body: unknown,
  ) {
    const context = requireContext(request);
    authorize(context, Permission.ProductWrite);
    authorize(context, Permission.ResearchRead);
    return this.packages.generateProvisionalProfile(
      context,
      z.uuidv7().parse(planId),
      GenerateProvisionalCustomProductProfileInputSchema.parse(body),
    );
  }

  @Patch("profile")
  @RequiresPermission(Permission.ProductWrite)
  saveProfile(
    @Req() request: AuthenticatedRequest,
    @Param("planId") planId: string,
    @Body() body: unknown,
  ) {
    const context = requireContext(request);
    authorize(context, Permission.ProductWrite);
    return this.packages.saveProfile(
      context,
      z.uuidv7().parse(planId),
      SaveCustomProductProfileInputSchema.parse(body),
    );
  }

  @Get("completeness")
  @RequiresPermission(Permission.ProductRead)
  completeness(@Req() request: AuthenticatedRequest, @Param("planId") planId: string) {
    const context = requireContext(request);
    authorize(context, Permission.ProductRead);
    return this.packages.completeness(context, z.uuidv7().parse(planId));
  }

  @Get()
  @RequiresPermission(Permission.ProductRead)
  async export(
    @Req() request: AuthenticatedRequest,
    @Param("planId") planId: string,
    @Query("mode") rawMode?: string,
  ) {
    const context = requireContext(request);
    authorize(context, Permission.ProductRead);
    const mode = CustomProductPackageExportModeSchema.parse(rawMode ?? "draft");
    const result = await this.packages.export(context, z.uuidv7().parse(planId), mode);
    return new StreamableFile(Buffer.from(result.bytes), {
      type: "application/zip",
      disposition: `attachment; filename="${result.fileName}"`,
      length: result.bytes.byteLength,
    });
  }
}

function requireContext(request: AuthenticatedRequest) {
  if (!request.tenantContext) throw new Error("Tenant context is required");
  return request.tenantContext;
}
