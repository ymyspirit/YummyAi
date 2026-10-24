import { Body, Controller, Get, Inject, Param, Post, Query, Req } from "@nestjs/common";
import { Permission } from "@yummyai/authz";
import { z } from "zod";
import { RequiresPermission } from "../auth/permissions.decorator.js";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { ManufacturingService } from "./manufacturing.service.js";

@Controller("v1/manufacturing-recipes")
export class ManufacturingController {
  constructor(@Inject(ManufacturingService) private readonly manufacturing: ManufacturingService) {}
  @Get()
  @RequiresPermission(Permission.ProductRead)
  list(@Req() request: AuthenticatedRequest, @Query() query: unknown) { return this.manufacturing.list(context(request), query, true); }
  @Get("references")
  @RequiresPermission(Permission.ProductRead)
  references(@Req() request: AuthenticatedRequest, @Query("spuId") spuId: string) { return this.manufacturing.references(context(request), z.uuidv7().parse(spuId), true); }
  @Get("material-options")
  @RequiresPermission(Permission.InventoryRead)
  materials(@Req() request: AuthenticatedRequest, @Query() query: unknown) { return this.manufacturing.materialOptions(context(request), query, true); }
  @Get(":id")
  @RequiresPermission(Permission.ProductRead)
  get(@Req() request: AuthenticatedRequest, @Param("id") id: string) { return this.manufacturing.get(context(request), z.uuidv7().parse(id), undefined, true); }
  @Get(":id/versions/:versionId")
  @RequiresPermission(Permission.ProductRead)
  version(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Param("versionId") versionId: string) {
    return this.manufacturing.get(context(request), z.uuidv7().parse(id), z.uuidv7().parse(versionId), true);
  }
  @Get(":id/history")
  @RequiresPermission(Permission.ProductRead)
  history(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Query() query: unknown) { return this.manufacturing.history(context(request), z.uuidv7().parse(id), query, true); }
  @Post()
  @RequiresPermission(Permission.ProductWrite)
  create(@Req() request: AuthenticatedRequest, @Body() body: unknown) { return this.manufacturing.create(context(request), body, true); }
  @Post(":id/versions")
  @RequiresPermission(Permission.ProductWrite)
  revise(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown) { return this.manufacturing.revise(context(request), z.uuidv7().parse(id), body, true); }
  @Post(":id/reviews")
  @RequiresPermission(Permission.ManufacturingReview)
  review(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown) { return this.manufacturing.review(context(request), z.uuidv7().parse(id), body, true); }
  @Post(":id/material-demands")
  @RequiresPermission(Permission.ProductRead)
  demand(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown) { return this.manufacturing.estimate(context(request), z.uuidv7().parse(id), body, true); }
}
function context(request: AuthenticatedRequest) {
  if (!request.tenantContext) throw new Error("Tenant context is required");
  return request.tenantContext;
}
