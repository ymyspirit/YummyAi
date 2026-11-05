import { Body, Controller, Get, Header, Inject, Param, Post, Req } from "@nestjs/common";
import { Permission } from "@yummyai/authz";
import { z } from "zod";
import { RequiresPermission } from "../auth/permissions.decorator.js";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { FulfillmentRoutesService } from "./fulfillment-routes.service.js";
import { OrderFlowService } from "./order-flow.service.js";

@Controller("v1/fulfillment-flow")
export class OrderFlowController {
  constructor(@Inject(FulfillmentRoutesService) private readonly routes: FulfillmentRoutesService,
    @Inject(OrderFlowService) private readonly flows: OrderFlowService) {}
  @Get("routes") @Header("Cache-Control","private, no-store") @RequiresPermission(Permission.OrderRead,Permission.OrderPiiRead)
  async list(@Req() req:AuthenticatedRequest) { return (await this.routes.workspace(context(req))).view; }
  @Post("routes") @RequiresPermission(Permission.IntegrationManage,Permission.OrderRead,Permission.OrderPiiRead)
  save(@Req() req:AuthenticatedRequest,@Body() raw:unknown) { return this.routes.save(context(req),raw); }
  @Get("orders/:id") @Header("Cache-Control","private, no-store") @RequiresPermission(Permission.OrderRead,Permission.OrderPiiRead)
  get(@Req() req:AuthenticatedRequest,@Param("id") id:string) { return this.flows.view(context(req),z.uuidv7().parse(id)); }
  @Post("orders/:id/resume") @RequiresPermission(Permission.OrderWrite,Permission.OrderRead,Permission.OrderPiiRead)
  resume(@Req() req:AuthenticatedRequest,@Param("id") id:string,@Body() raw:unknown) {
    z.object({}).strict().parse(raw);
    return this.flows.resume(context(req),z.uuidv7().parse(id));
  }
}
function context(req:AuthenticatedRequest) { if (!req.tenantContext) throw new Error("Tenant context required"); return req.tenantContext; }
