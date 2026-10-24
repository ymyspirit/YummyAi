import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req } from "@nestjs/common";
import { Permission } from "@yummyai/authz";
import { EntityIdSchema } from "@yummyai/contracts";
import { RequiresPermission } from "../auth/permissions.decorator.js";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { SalesPlanService } from "./sales-plan.service.js";

@Controller("v1/sales-plans")
export class SalesPlanController {
  constructor(@Inject(SalesPlanService) private readonly plans: SalesPlanService) {}
  @Get("options")
  @RequiresPermission(Permission.ProductRead)
  options(@Req() req: AuthenticatedRequest) {
    return this.plans.options(context(req));
  }
  @Get()
  @RequiresPermission(Permission.ProductRead)
  list(@Req() req: AuthenticatedRequest, @Query() query: unknown) {
    return this.plans.list(context(req), query);
  }
  @Get(":id")
  @RequiresPermission(Permission.ProductRead)
  get(@Req() req: AuthenticatedRequest, @Param("id") id: string) {
    return this.plans.get(context(req), EntityIdSchema.parse(id));
  }
  @Post()
  @RequiresPermission(Permission.ProductWrite)
  create(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    return this.plans.create(context(req), body);
  }
  @Post(":id")
  @RequiresPermission(Permission.ProductWrite)
  save(@Req() req: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown) {
    return this.plans.save(context(req), EntityIdSchema.parse(id), body);
  }
  @Post(":id/archive")
  @RequiresPermission(Permission.ProductWrite)
  archive(@Req() req: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown) {
    return this.plans.archive(context(req), EntityIdSchema.parse(id), body);
  }
  @Post(":id/draft")
  @RequiresPermission(Permission.ListingWrite)
  draft(@Req() req: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown) {
    return this.plans.draft(context(req), EntityIdSchema.parse(id), body);
  }
  @Post(":id/reference-options")
  @HttpCode(200)
  @RequiresPermission(Permission.ProductRead)
  referenceOptions(
    @Req() req: AuthenticatedRequest,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    return this.plans.referenceOptions(context(req), EntityIdSchema.parse(id), body);
  }
}
function context(req: AuthenticatedRequest) {
  if (!req.tenantContext) throw new Error("Tenant context is required");
  return req.tenantContext;
}
