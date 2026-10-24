import { Body, Controller, Get, Header, Inject, Param, Post, Query, Req, Res, StreamableFile } from "@nestjs/common";
import { Permission } from "@yummyai/authz";
import { z } from "zod";
import { RequiresPermission } from "../auth/permissions.decorator.js";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { OrderProductionDeliveryService } from "./order-production-delivery.service.js";

const Id = z.uuidv7();
@Controller("v1/order-centers/deliveries")
export class OrderProductionDeliveryController {
  constructor(@Inject(OrderProductionDeliveryService) private readonly delivery: OrderProductionDeliveryService) {}
  @Get() @Header("Cache-Control", "private, no-store") @RequiresPermission(Permission.OrderRead, Permission.OrderPiiRead, Permission.DesignRead, Permission.AssetRead)
  workspace(@Req() request: AuthenticatedRequest, @Query() query: unknown) { return this.delivery.workspace(context(request), query); }
  @Post() @Header("Cache-Control", "private, no-store") @RequiresPermission(Permission.OrderWrite, Permission.OrderPiiRead, Permission.DesignRead, Permission.AssetRead)
  create(@Req() request: AuthenticatedRequest, @Body() body: unknown) { return this.delivery.create(context(request), body); }
  @Get(":id") @Header("Cache-Control", "private, no-store") @RequiresPermission(Permission.OrderRead, Permission.OrderPiiRead, Permission.DesignRead, Permission.AssetRead)
  get(@Req() request: AuthenticatedRequest, @Param("id") id: string) { return this.delivery.get(context(request), Id.parse(id)); }
  @Get(":id/file") @RequiresPermission(Permission.OrderRead, Permission.OrderPiiRead, Permission.DesignRead, Permission.AssetRead)
  async download(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Res({ passthrough: true }) response: { setHeader(name: string, value: string): void }) {
    response.setHeader("Cache-Control", "private, no-store"); response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Content-Security-Policy", "default-src 'none'; sandbox"); response.setHeader("Referrer-Policy", "no-referrer");
    const file = await this.delivery.download(context(request), Id.parse(id));
    response.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`);
    return new StreamableFile(file.body, { type: file.mediaType, length: file.body.byteLength });
  }
  @Post(":id/items/:itemId/feedback") @Header("Cache-Control", "private, no-store") @RequiresPermission(Permission.OrderWrite, Permission.OrderPiiRead, Permission.DesignRead, Permission.AssetRead)
  feedback(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Param("itemId") itemId: string, @Body() body: unknown) {
    return this.delivery.recordFeedback(context(request), Id.parse(id), Id.parse(itemId), body);
  }
}
function context(request: AuthenticatedRequest) { if (!request.tenantContext) throw new Error("Tenant context required"); return request.tenantContext; }
