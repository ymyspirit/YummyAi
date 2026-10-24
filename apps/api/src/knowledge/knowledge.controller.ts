import { Body, Controller, Get, Header, Inject, Param, Post, Req } from "@nestjs/common";
import { Permission } from "@yummyai/authz";
import { z } from "zod";
import { RequiresPermission } from "../auth/permissions.decorator.js";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { KnowledgeService } from "./knowledge.service.js";
const context = (request: AuthenticatedRequest) => {
  if (!request.tenantContext) throw new Error("Tenant context required");
  return request.tenantContext;
};
@Controller("v1/knowledge")
export class KnowledgeController {
  constructor(@Inject(KnowledgeService) private readonly knowledge: KnowledgeService) {}
  @Get("workspace")
  @Header("Cache-Control", "private, no-store")
  @RequiresPermission(Permission.WorkflowRead)
  workspace(@Req() request: AuthenticatedRequest) {
    return this.knowledge.workspace(context(request));
  }
  @Get(":id/history")
  @Header("Cache-Control", "private, no-store")
  @RequiresPermission(Permission.WorkflowRead)
  history(@Req() request: AuthenticatedRequest, @Param("id") id: string) {
    return this.knowledge.history(context(request), z.uuidv7().parse(id));
  }
  @Post("search")
  @Header("Cache-Control", "private, no-store")
  @RequiresPermission(Permission.WorkflowRead)
  search(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    return this.knowledge.search(context(request), body);
  }
  @Post("create")
  @RequiresPermission(Permission.WorkflowManage)
  create(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    return this.knowledge.save(context(request), null, body);
  }
  @Post(":id/revise")
  @RequiresPermission(Permission.WorkflowManage)
  revise(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown) {
    return this.knowledge.save(context(request), z.uuidv7().parse(id), body);
  }
  @Post(":id/submit")
  @RequiresPermission(Permission.WorkflowManage)
  submit(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown) {
    return this.knowledge.change(context(request), z.uuidv7().parse(id), "submit", body);
  }
  @Post(":id/publish")
  @RequiresPermission(Permission.WorkflowApprove)
  publish(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown) {
    return this.knowledge.change(context(request), z.uuidv7().parse(id), "publish", body);
  }
  @Post(":id/reject")
  @RequiresPermission(Permission.WorkflowApprove)
  reject(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown) {
    return this.knowledge.change(context(request), z.uuidv7().parse(id), "reject", body);
  }
  @Post(":id/disable")
  @RequiresPermission(Permission.WorkflowApprove)
  disable(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown) {
    return this.knowledge.change(context(request), z.uuidv7().parse(id), "disable", body);
  }
  @Post(":id/archive")
  @RequiresPermission(Permission.WorkflowManage)
  archive(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown) {
    return this.knowledge.change(context(request), z.uuidv7().parse(id), "archive", body);
  }
}
