import { Body, Controller, Get, Header, Inject, Param, Post, Query, Req } from "@nestjs/common";
import { Permission } from "@yummyai/authz";
import { z } from "zod";
import { RequiresPermission } from "../auth/permissions.decorator.js";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { FactoryDirectoryService } from "./factory-directory.service.js";

@Controller("v1/sourcing")
export class FactoryDirectoryController {
  constructor(@Inject(FactoryDirectoryService) private readonly factories: FactoryDirectoryService) {}
  @Get("factories") @Header("Cache-Control", "private, no-store") @RequiresPermission(Permission.OrderRead)
  directory(@Req() request: AuthenticatedRequest, @Query() query: unknown) { return this.factories.directory(context(request), query); }
  @Post("factories") @RequiresPermission(Permission.OrderWrite)
  create(@Req() request: AuthenticatedRequest, @Body() body: unknown) { return this.factories.create(context(request), body); }
  @Post("factories/:id/revisions") @RequiresPermission(Permission.OrderWrite)
  revise(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown) { return this.factories.revise(context(request), z.uuidv7().parse(id), body); }
  @Get("factories/:id/history") @Header("Cache-Control", "private, no-store") @RequiresPermission(Permission.OrderRead)
  history(@Req() request: AuthenticatedRequest, @Param("id") id: string) { return this.factories.history(context(request), z.uuidv7().parse(id)); }
  @Post("factories/:id/capabilities") @RequiresPermission(Permission.OrderWrite)
  capability(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown) { return this.factories.createCapability(context(request), z.uuidv7().parse(id), body); }
  @Post("factory-capabilities/:id/revisions") @RequiresPermission(Permission.OrderWrite)
  reviseCapability(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown) { return this.factories.reviseCapability(context(request), z.uuidv7().parse(id), body); }
}
function context(request: AuthenticatedRequest) { if (!request.tenantContext) throw new Error("Tenant context is required"); return request.tenantContext; }
