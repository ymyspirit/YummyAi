import { Body, Controller, Get, Header, Inject, Param, Post, Req } from "@nestjs/common";
import { Permission } from "@yummyai/authz";
import { z } from "zod";
import { RequiresPermission } from "../auth/permissions.decorator.js";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { RuleCenterService } from "./rule-center.service.js";

@Controller("v1/rules")
export class RuleCenterController {
  constructor(@Inject(RuleCenterService) private readonly rules: RuleCenterService) {}
  @Get("workspace") @Header("Cache-Control", "private, no-store") @RequiresPermission(Permission.WorkflowRead)
  workspace(@Req() request: AuthenticatedRequest) { return this.rules.workspace(context(request)); }
  @Get(":id/history") @Header("Cache-Control", "private, no-store") @RequiresPermission(Permission.WorkflowRead)
  history(@Req() request: AuthenticatedRequest, @Param("id") id: string) { return this.rules.history(context(request), z.uuidv7().parse(id)); }
  @Post("initialize") @RequiresPermission(Permission.WorkflowManage)
  initialize(@Req() request: AuthenticatedRequest, @Body() body: unknown) { z.object({}).strict().parse(body); return this.rules.initialize(context(request)); }
  @Post("create") @RequiresPermission(Permission.WorkflowManage)
  create(@Req() request: AuthenticatedRequest, @Body() body: unknown) { return this.rules.save(context(request), null, body); }
  @Post(":id/revise") @RequiresPermission(Permission.WorkflowManage)
  revise(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown) { return this.rules.save(context(request), z.uuidv7().parse(id), body); }
  @Post(":id/publish") @RequiresPermission(Permission.WorkflowApprove)
  publish(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown) { return this.rules.changeState(context(request), z.uuidv7().parse(id), "publish", body); }
  @Post(":id/disable") @RequiresPermission(Permission.WorkflowApprove)
  disable(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown) { return this.rules.changeState(context(request), z.uuidv7().parse(id), "disable", body); }
}
function context(request: AuthenticatedRequest) { if (!request.tenantContext) throw new Error("Tenant context required"); return request.tenantContext; }
