import { Body, Controller, Get, Inject, Param, Post, Req } from "@nestjs/common";
import { Permission } from "@yummyai/authz";
import { EntityIdSchema } from "@yummyai/contracts";
import { z } from "zod";
import { RequiresPermission } from "../auth/permissions.decorator.js";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { ProductVisualsService } from "./product-visuals.service.js";

@Controller("v1/sales-plans/:id/launch/visuals")
export class ProductVisualsController {
  constructor(@Inject(ProductVisualsService) private readonly visuals: ProductVisualsService) {}
  @Get()
  @RequiresPermission(Permission.ProductRead)
  get(@Req() req: AuthenticatedRequest, @Param("id") id: string) {
    return this.visuals.get(context(req), EntityIdSchema.parse(id));
  }
  @Post("prepare")
  @RequiresPermission(Permission.DesignWrite)
  prepare(@Req() req: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown) {
    return this.visuals.prepare(context(req), EntityIdSchema.parse(id), body);
  }
  @Post(":groupId/generate")
  @RequiresPermission(Permission.DesignWrite)
  generate(
    @Req() req: AuthenticatedRequest,
    @Param("id") id: string,
    @Param("groupId") groupId: string,
    @Body() body: unknown,
  ) {
    return this.visuals.generate(
      context(req),
      EntityIdSchema.parse(id),
      z.uuid().parse(groupId),
      body,
    );
  }
  @Post(":groupId/collect")
  @RequiresPermission(Permission.DesignWrite)
  collect(
    @Req() req: AuthenticatedRequest,
    @Param("id") id: string,
    @Param("groupId") groupId: string,
  ) {
    return this.visuals.collect(context(req), EntityIdSchema.parse(id), z.uuid().parse(groupId));
  }
  @Post(":groupId/review")
  @RequiresPermission(Permission.DesignReview)
  review(
    @Req() req: AuthenticatedRequest,
    @Param("id") id: string,
    @Param("groupId") groupId: string,
    @Body() body: unknown,
  ) {
    return this.visuals.review(
      context(req),
      EntityIdSchema.parse(id),
      z.uuid().parse(groupId),
      body,
    );
  }
  @Post(":groupId/adopt")
  @RequiresPermission(Permission.ProductWrite)
  adopt(
    @Req() req: AuthenticatedRequest,
    @Param("id") id: string,
    @Param("groupId") groupId: string,
    @Body() body: unknown,
  ) {
    return this.visuals.adopt(
      context(req),
      EntityIdSchema.parse(id),
      z.uuid().parse(groupId),
      body,
    );
  }
}
function context(req: AuthenticatedRequest) {
  if (!req.tenantContext) throw new Error("Tenant context is required");
  return req.tenantContext;
}
