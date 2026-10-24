import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  Inject,
  Param,
  Post,
  Req,
  Query,
} from "@nestjs/common";
import { Permission } from "@yummyai/authz";
import { z } from "zod";
import { RequiresPermission } from "../auth/permissions.decorator.js";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { MethodGovernanceService } from "./method-governance.service.js";

@Controller("v1/agent-methods")
export class MethodGovernanceController {
  constructor(@Inject(MethodGovernanceService) private readonly methods: MethodGovernanceService) {}
  @Get("workspace")
  @Header("Cache-Control", "private, no-store")
  @RequiresPermission(Permission.WorkflowRead)
  workspace(@Req() request: AuthenticatedRequest) {
    return this.methods.workspace(context(request));
  }
  @Get(":id/history")
  @Header("Cache-Control", "private, no-store")
  @RequiresPermission(Permission.WorkflowRead)
  history(@Req() request: AuthenticatedRequest, @Param("id") id: string) {
    return this.methods.history(context(request), methodId(id));
  }
  @Get("sources")
  @Header("Cache-Control", "private, no-store")
  @RequiresPermission(Permission.WorkflowRead)
  sources(@Req() request: AuthenticatedRequest, @Query() query: unknown) {
    return this.methods.sources(context(request), query);
  }
  @Post("save")
  @RequiresPermission(Permission.WorkflowRead, Permission.WorkflowManage)
  save(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    return this.methods.save(context(request), body);
  }
  @Post(":id/submit")
  @RequiresPermission(Permission.WorkflowRead, Permission.WorkflowManage)
  submit(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown) {
    return this.methods.transition(context(request), methodId(id), "submit", body);
  }
  @Post(":id/publish")
  @RequiresPermission(Permission.WorkflowRead, Permission.WorkflowApprove)
  publish(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown) {
    return this.methods.transition(context(request), methodId(id), "publish", body);
  }
  @Post(":id/reject")
  @RequiresPermission(Permission.WorkflowRead, Permission.WorkflowApprove)
  reject(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown) {
    return this.methods.transition(context(request), methodId(id), "reject", body);
  }
  @Post(":id/disable")
  @RequiresPermission(Permission.WorkflowRead, Permission.WorkflowApprove)
  disable(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown) {
    return this.methods.transition(context(request), methodId(id), "disable", body);
  }
}
function methodId(value: string) {
  const parsed = z.uuidv7().safeParse(value);
  if (!parsed.success) throw new BadRequestException("方法编号格式无效");
  return parsed.data;
}
function context(request: AuthenticatedRequest) {
  if (!request.tenantContext) throw new Error("Tenant context required");
  return request.tenantContext;
}
