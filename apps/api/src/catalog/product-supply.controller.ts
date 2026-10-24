import { Body, Controller, Get, Inject, Param, Post, Req } from "@nestjs/common";
import { authorize, Permission } from "@yummyai/authz";
import { CreateProductSupplyInputSchema, ReviseProductSupplyInputSchema, CreateSupplyPurchaseInputSchema } from "@yummyai/contracts/catalog/product-supply";
import { z } from "zod";
import { RequiresPermission } from "../auth/permissions.decorator.js";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { ProcurementService } from "../procurement/procurement.service.js";
import { ProductSupplyService } from "./product-supply.service.js";

@Controller("v1/product-suppliers")
export class ProductSupplyController {
  constructor(@Inject(ProductSupplyService) private readonly supply: ProductSupplyService, @Inject(ProcurementService) private readonly procurement: ProcurementService) {}

  @Get("workspace")
  @RequiresPermission(Permission.ProcurementRead)
  workspace(@Req() request: AuthenticatedRequest) { return this.supply.workspace(context(request, Permission.ProcurementRead)); }

  @Get(":id/history")
  @RequiresPermission(Permission.ProcurementRead)
  history(@Req() request: AuthenticatedRequest, @Param("id") id: string) { return this.supply.history(context(request, Permission.ProcurementRead), z.uuidv7().parse(id)); }

  @Post()
  @RequiresPermission(Permission.ProcurementWrite)
  create(@Req() request: AuthenticatedRequest, @Body() body: unknown) { return this.supply.create(context(request, Permission.ProcurementWrite), CreateProductSupplyInputSchema.parse(body)); }

  @Post(":id/revisions")
  @RequiresPermission(Permission.ProcurementWrite)
  revise(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown) { return this.supply.revise(context(request, Permission.ProcurementWrite), z.uuidv7().parse(id), ReviseProductSupplyInputSchema.parse(body)); }

  @Post(":id/purchase-drafts")
  @RequiresPermission(Permission.ProcurementWrite)
  purchase(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown) { return this.procurement.createPurchaseOrderFromSupply(context(request, Permission.ProcurementWrite), z.uuidv7().parse(id), CreateSupplyPurchaseInputSchema.parse(body)); }
}
function context(request: AuthenticatedRequest, permission: typeof Permission.ProcurementRead | typeof Permission.ProcurementWrite) {
  if (!request.tenantContext) throw new Error("Tenant context is required");
  authorize(request.tenantContext, permission);
  return request.tenantContext;
}
