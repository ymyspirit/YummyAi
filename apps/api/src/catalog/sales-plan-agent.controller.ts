import { Body, Controller, Get, Header, Inject, Param, Post, Req } from "@nestjs/common";
import { Permission } from "@yummyai/authz";
import { EntityIdSchema } from "@yummyai/contracts";
import { RequiresPermission } from "../auth/permissions.decorator.js";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { SalesPlanPreparationService } from "./sales-plan-agent.service.js";

@Controller("v1/sales-plans/:id/launch/agent")
export class SalesPlanPreparationController {
  constructor(@Inject(SalesPlanPreparationService) private readonly agent: SalesPlanPreparationService) {}
  @Get() @Header("Cache-Control", "private, no-store") @RequiresPermission(Permission.ProductRead)
  list(@Req() req: AuthenticatedRequest, @Param("id") id: string) { return this.agent.list(context(req), EntityIdSchema.parse(id)); }
  @Get(":run") @Header("Cache-Control", "private, no-store") @RequiresPermission(Permission.ProductRead)
  get(@Req() req: AuthenticatedRequest, @Param("id") id: string, @Param("run") run: string) { return this.agent.get(context(req), EntityIdSchema.parse(id), EntityIdSchema.parse(run)); }
  @Post() @Header("Cache-Control", "private, no-store") @RequiresPermission(Permission.ProductWrite)
  start(@Req() req: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown) { return this.agent.start(context(req), EntityIdSchema.parse(id), body); }
  @Post(":run/resume") @Header("Cache-Control", "private, no-store") @RequiresPermission(Permission.ProductWrite)
  resume(@Req() req: AuthenticatedRequest, @Param("id") id: string, @Param("run") run: string, @Body() body: unknown) { return this.agent.resume(context(req), EntityIdSchema.parse(id), EntityIdSchema.parse(run), body); }
  @Post(":run/cancel") @Header("Cache-Control", "private, no-store") @RequiresPermission(Permission.ProductWrite)
  cancel(@Req() req: AuthenticatedRequest, @Param("id") id: string, @Param("run") run: string, @Body() body: unknown) { return this.agent.cancel(context(req), EntityIdSchema.parse(id), EntityIdSchema.parse(run), body); }
  @Post(":run/basis") @Header("Cache-Control", "private, no-store") @RequiresPermission(Permission.ProductWrite)
  basis(@Req() req: AuthenticatedRequest, @Param("id") id: string, @Param("run") run: string, @Body() body: unknown) { return this.agent.basis(context(req), EntityIdSchema.parse(id), EntityIdSchema.parse(run), body); }
  @Post(":run/analyze") @Header("Cache-Control", "private, no-store") @RequiresPermission(Permission.ProductWrite)
  analyze(@Req() req: AuthenticatedRequest, @Param("id") id: string, @Param("run") run: string, @Body() body: unknown) { return this.agent.analyze(context(req), EntityIdSchema.parse(id), EntityIdSchema.parse(run), body); }
}
function context(req: AuthenticatedRequest) { if (!req.tenantContext) throw new Error("Tenant context required"); return req.tenantContext; }
