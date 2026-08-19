import { Body, Controller, Get, Inject, Param, Patch, Post, Req } from "@nestjs/common";
import { Permission, authorize } from "@yummyai/authz";
import {
  CreateSkuInputSchema,
  CreateSpuInputSchema,
  ProductPlanInputSchema,
  ProductStatusSchema,
  UpdateProductPlanCustomizationInputSchema,
} from "@yummyai/contracts";
import { z } from "zod";

import { RequiresPermission } from "../auth/permissions.decorator.js";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { ProductService } from "./product.service.js";

@Controller("v1/products")
export class ProductController {
  constructor(@Inject(ProductService) private readonly products: ProductService) {}

  @Get("plans")
  @RequiresPermission(Permission.ProductRead)
  list(@Req() request: AuthenticatedRequest) {
    const context = requireContext(request);
    authorize(context, Permission.ProductRead);
    return this.products.listPlans(context);
  }

  @Post("plans")
  @RequiresPermission(Permission.ProductWrite)
  createPlan(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const context = requireContext(request);
    authorize(context, Permission.ProductWrite);
    return this.products.createPlan(context, ProductPlanInputSchema.parse(body));
  }

  @Patch("plans/:id/customization")
  @RequiresPermission(Permission.ProductWrite)
  updateCustomization(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const context = requireContext(request);
    authorize(context, Permission.ProductWrite);
    return this.products.updateCustomization(
      context,
      z.uuidv7().parse(id),
      UpdateProductPlanCustomizationInputSchema.parse(body),
    );
  }

  @Post("plans/:id/transitions")
  @RequiresPermission(Permission.ProductWrite)
  transition(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown) {
    const context = requireContext(request);
    authorize(context, Permission.ProductWrite);
    const input = z.object({ status: ProductStatusSchema }).parse(body);
    return this.products.transition(context, z.uuidv7().parse(id), input.status);
  }

  @Post("plans/:id/spu")
  @RequiresPermission(Permission.ProductWrite)
  createSpu(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown) {
    const context = requireContext(request);
    authorize(context, Permission.ProductWrite);
    return this.products.createSpu(context, z.uuidv7().parse(id), CreateSpuInputSchema.parse(body));
  }

  @Post("skus")
  @RequiresPermission(Permission.ProductWrite)
  createSku(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const context = requireContext(request);
    authorize(context, Permission.ProductWrite);
    return this.products.createSku(context, CreateSkuInputSchema.parse(body));
  }
}

function requireContext(request: AuthenticatedRequest) {
  if (!request.tenantContext) throw new Error("Tenant context is required");
  return request.tenantContext;
}
