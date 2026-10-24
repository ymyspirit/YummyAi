import { Body, Controller, Get, Header, Inject, Param, Post, Query, Req, Res, StreamableFile } from "@nestjs/common";
import { Permission } from "@yummyai/authz";
import { z } from "zod";
import { RequiresPermission } from "../auth/permissions.decorator.js";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { LogisticsService } from "./logistics.service.js";
@Controller("v1/logistics")
export class LogisticsController {
  constructor(@Inject(LogisticsService) private readonly logistics: LogisticsService) {}
  @Get("connections") @Header("Cache-Control","private, no-store") @RequiresPermission(Permission.IntegrationRead)
  connections(@Req() req: AuthenticatedRequest) { return this.logistics.connections(context(req)); }
  @Post("connections") @RequiresPermission(Permission.IntegrationManage)
  save(@Req() req: AuthenticatedRequest,@Body() raw: unknown) { return this.logistics.saveConnection(context(req),raw); }
  @Post("connections/:id/verify") @RequiresPermission(Permission.IntegrationManage)
  verify(@Req() req: AuthenticatedRequest,@Param("id") id: string,@Body() raw: unknown) { return this.logistics.verify(context(req),z.uuidv7().parse(id),raw); }
  @Post("rules") @RequiresPermission(Permission.IntegrationManage)
  rule(@Req() req: AuthenticatedRequest,@Body() raw: unknown) { return this.logistics.saveRule(context(req),raw); }
  @Get("options") @Header("Cache-Control","private, no-store") @RequiresPermission(Permission.OrderRead,Permission.OrderPiiRead)
  options(@Req() req: AuthenticatedRequest,@Query() query: unknown) {return this.logistics.options(context(req),query);}
  @Get("tasks") @Header("Cache-Control","private, no-store") @RequiresPermission(Permission.OrderRead,Permission.OrderPiiRead)
  workspace(@Req() req: AuthenticatedRequest,@Query() query: unknown) { return this.logistics.workspace(context(req),query); }
  @Post("tasks") @RequiresPermission(Permission.OrderWrite,Permission.OrderPiiRead)
  create(@Req() req: AuthenticatedRequest,@Body() raw: unknown) { return this.logistics.createTask(context(req),raw); }
  @Get("tasks/:id") @Header("Cache-Control","private, no-store") @RequiresPermission(Permission.OrderRead,Permission.OrderPiiRead)
  get(@Req() req: AuthenticatedRequest,@Param("id") id: string) { return this.logistics.get(context(req),z.uuidv7().parse(id)); }
  @Post("tasks/:id/dispatch") @RequiresPermission(Permission.OrderWrite,Permission.OrderPiiRead)
  dispatch(@Req() req: AuthenticatedRequest,@Param("id") id: string,@Body() raw: unknown) { return this.logistics.dispatch(context(req),z.uuidv7().parse(id),raw); }
  @Post("tasks/:id/cancel") @RequiresPermission(Permission.OrderWrite,Permission.OrderPiiRead)
  cancel(@Req() req: AuthenticatedRequest,@Param("id") id: string,@Body() raw: unknown) { return this.logistics.cancel(context(req),z.uuidv7().parse(id),raw); }
  @Get("tasks/:id/labels/:label") @RequiresPermission(Permission.OrderRead,Permission.OrderPiiRead)
  async label(@Req() req: AuthenticatedRequest,@Param("id") id: string,@Param("label") label: string,@Res({passthrough:true}) response: {setHeader(name:string,value:string):void}) {
    const result=await this.logistics.label(context(req),z.uuidv7().parse(id),z.uuidv7().parse(label));
    for(const [name,value] of Object.entries({"Cache-Control":"private, no-store","Content-Disposition":`attachment; filename="${result.name}"`,"X-Content-Type-Options":"nosniff","Content-Security-Policy":"default-src 'none'; sandbox","Referrer-Policy":"no-referrer"}))response.setHeader(name,value);
    return new StreamableFile(result.body,{type:"application/pdf",length:result.body.byteLength});
  }
}
function context(req: AuthenticatedRequest) { if(!req.tenantContext) throw new Error("Tenant context required");return req.tenantContext; }
