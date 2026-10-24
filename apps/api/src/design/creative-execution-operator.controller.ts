import { Body, Controller, Get, Header, Inject, Param, Post, Query, Req } from "@nestjs/common";
import { z } from "zod";
import { Permission } from "@yummyai/authz";
import { CreativeHistoryScopeSchema } from "@yummyai/contracts/harness/creative-operator";
import { RequiresPermission } from "../auth/permissions.decorator.js";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { CreativeExecutionOperatorService } from "./creative-execution-operator.service.js";

@Controller("v1/creative-executions")
export class CreativeExecutionOperatorController {
  constructor(@Inject(CreativeExecutionOperatorService) private readonly service: CreativeExecutionOperatorService) {}

  @Get("history/:scope/:id")
  @Header("Cache-Control", "private, no-store")
  @RequiresPermission(Permission.DesignRead)
  history(@Req() request: AuthenticatedRequest, @Param("scope") scope: string, @Param("id") id: string, @Query() query: unknown) {
    return this.service.history(request.tenantContext!, CreativeHistoryScopeSchema.parse(scope), z.uuidv7().parse(id), query);
  }

  @Post(":id/actions")
  @Header("Cache-Control", "private, no-store")
  @RequiresPermission(Permission.DesignRead)
  act(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown) {
    return this.service.act(request.tenantContext!, z.uuidv7().parse(id), body);
  }
}
