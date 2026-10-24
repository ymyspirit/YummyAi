import { Body, Controller, Get, Inject, Param, Post, Query, Req, Res } from "@nestjs/common";
import { Permission } from "@yummyai/authz";
import { EntityIdSchema } from "@yummyai/contracts";
import { RequiresPermission } from "../auth/permissions.decorator.js";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { SalesPlanDeliveryService } from "./sales-plan-delivery.service.js";

@Controller("v1/sales-plans/:id/launch/delivery")
export class SalesPlanDeliveryController {
  constructor(
    @Inject(SalesPlanDeliveryService) private readonly delivery: SalesPlanDeliveryService,
  ) {}
  @Get()
  @RequiresPermission(Permission.ProductRead)
  get(@Req() req: AuthenticatedRequest, @Param("id") id: string, @Query() query: unknown) {
    return this.delivery.get(context(req), EntityIdSchema.parse(id), query);
  }
  @Post("review")
  @RequiresPermission(Permission.ListingReview)
  review(@Req() req: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown) {
    return this.delivery.review(context(req), EntityIdSchema.parse(id), body);
  }
  @Post("seal")
  @RequiresPermission(Permission.ListingReview)
  seal(@Req() req: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown) {
    return this.delivery.seal(context(req), EntityIdSchema.parse(id), body);
  }
  @Get("packages/:packageId/export")
  @RequiresPermission(Permission.AssetRead)
  async export(
    @Req() req: AuthenticatedRequest,
    @Param("id") id: string,
    @Param("packageId") packageId: string,
    @Query() query: unknown,
    @Res() res: { setHeader(name: string, value: string): void; send(body: Buffer): void },
  ) {
    const file = await this.delivery.export(
      context(req),
      EntityIdSchema.parse(id),
      EntityIdSchema.parse(packageId),
      query,
    );
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${file.name}"`);
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.send(file.body);
  }
}
function context(req: AuthenticatedRequest) {
  if (!req.tenantContext) throw new Error("Tenant context is required");
  return req.tenantContext;
}
