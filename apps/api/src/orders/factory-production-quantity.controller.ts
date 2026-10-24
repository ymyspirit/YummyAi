import { Body, Controller, Get, Header, Inject, Param, Post, Query, Req } from "@nestjs/common";
import { Permission } from "@yummyai/authz";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import { FactoryQuantityHistoryQuerySchema, FactoryQuantityReportInputSchema } from "@yummyai/contracts/suppliers/factory-quantity";
import { z } from "zod";
import { RequiresPermission } from "../auth/permissions.decorator.js";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { parseRequestSchema } from "../request-schema.js";
import { FactoryProductionQuantityService } from "./factory-production-quantity.service.js";

const EmptyQuery = z.object({}).strict();

@Controller("v1/factory-portal/work-items/:id/quantity")
export class FactoryProductionQuantityController {
  constructor(@Inject(FactoryProductionQuantityService) private readonly quantities: FactoryProductionQuantityService) {}

  @Get()
  @Header("Cache-Control", "private, no-store")
  @RequiresPermission(Permission.FactoryTaskRead)
  workspace(@Req() request: AuthenticatedRequest, @Param("id") assignmentId: string, @Query() query: unknown) {
    return this.quantities.workspace(context(request), parseRequestSchema(EntityIdSchema, assignmentId),
      parseRequestSchema(FactoryQuantityHistoryQuerySchema, query));
  }

  @Get("access")
  @Header("Cache-Control", "private, no-store")
  @RequiresPermission(Permission.FactoryTaskRead)
  access(@Req() request: AuthenticatedRequest, @Param("id") assignmentId: string, @Query() query: unknown) {
    parseRequestSchema(EmptyQuery, query);
    return this.quantities.access(context(request), parseRequestSchema(EntityIdSchema, assignmentId));
  }

  @Post("reports")
  @Header("Cache-Control", "private, no-store")
  @RequiresPermission(Permission.FactoryTaskRespond)
  report(@Req() request: AuthenticatedRequest, @Param("id") assignmentId: string, @Body() body: unknown, @Query() query: unknown) {
    parseRequestSchema(EmptyQuery, query);
    return this.quantities.recordReport(context(request), parseRequestSchema(EntityIdSchema, assignmentId),
      parseRequestSchema(FactoryQuantityReportInputSchema, body));
  }
}

function context(request: AuthenticatedRequest) {
  if (!request.tenantContext) throw new Error("Authenticated tenant required");
  return request.tenantContext;
}
