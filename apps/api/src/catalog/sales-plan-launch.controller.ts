import { Body, Controller, Get, Inject, Param, Post, Req } from "@nestjs/common";
import { Permission } from "@yummyai/authz";
import { EntityIdSchema } from "@yummyai/contracts";
import { RequiresPermission } from "../auth/permissions.decorator.js";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { SalesPlanLaunchService } from "./sales-plan-launch.service.js";

@Controller("v1/sales-plans/:id/launch")
export class SalesPlanLaunchController {
  constructor(@Inject(SalesPlanLaunchService) private readonly launch: SalesPlanLaunchService) {}
  @Get()
  @RequiresPermission(Permission.ProductRead)
  get(@Req() req: AuthenticatedRequest, @Param("id") id: string) {
    return this.launch.get(context(req), EntityIdSchema.parse(id));
  }
  @Post("basis")
  @RequiresPermission(Permission.ProductRead)
  basis(@Req() req: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown) {
    return this.launch.basis(context(req), EntityIdSchema.parse(id), body);
  }
  @Post("adopt")
  @RequiresPermission(Permission.ProductWrite)
  adopt(@Req() req: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown) {
    return this.launch.adopt(context(req), EntityIdSchema.parse(id), body);
  }
}
function context(req: AuthenticatedRequest) {
  if (!req.tenantContext) throw new Error("Tenant context is required");
  return req.tenantContext;
}
