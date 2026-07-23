import { Body, Controller, Get, Inject, Param, Post, Query, Req } from "@nestjs/common";
import { Permission, authorize } from "@yummyai/authz";
import {
  AppendShipmentVersionInputSchema, CreateShipmentInputSchema, RecordShipmentWritebackEventInputSchema,
  RecordTrackingEventInputSchema, RequestShipmentWritebackInputSchema, ReviewShipmentVersionInputSchema,
} from "@yummyai/contracts";
import { z } from "zod";

import { RequiresPermission } from "../auth/permissions.decorator.js";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { OrderShipmentService } from "./order-shipment.service.js";

@Controller("v1/shipments")
export class OrderShipmentController {
  constructor(@Inject(OrderShipmentService) private readonly shipment: OrderShipmentService) {}

  @Get()
  @RequiresPermission(Permission.OrderRead)
  list(@Req() request: AuthenticatedRequest, @Query("orderId") orderId: unknown) { const context = requireContext(request); authorize(context, Permission.OrderRead); return this.shipment.list(context, orderId === undefined ? undefined : z.uuidv7().parse(orderId)); }

  @Get("writebacks/:requestId")
  @RequiresPermission(Permission.OrderRead)
  getWriteback(@Req() request: AuthenticatedRequest, @Param("requestId") requestId: string) { const context = requireContext(request); authorize(context, Permission.OrderRead); return this.shipment.getWriteback(context, z.uuidv7().parse(requestId)); }

  @Post("writebacks/:requestId/events")
  @RequiresPermission(Permission.OrderWrite)
  writebackEvent(@Req() request: AuthenticatedRequest, @Param("requestId") requestId: string, @Body() body: unknown) { const context = requireContext(request); authorize(context, Permission.OrderWrite); return this.shipment.recordWritebackEvent(context, z.uuidv7().parse(requestId), RecordShipmentWritebackEventInputSchema.parse(body)); }

  @Get(":shipmentId")
  @RequiresPermission(Permission.OrderRead)
  get(@Req() request: AuthenticatedRequest, @Param("shipmentId") shipmentId: string) { const context = requireContext(request); authorize(context, Permission.OrderRead); return this.shipment.get(context, z.uuidv7().parse(shipmentId)); }

  @Post(":shipmentId/versions")
  @RequiresPermission(Permission.OrderWrite)
  version(@Req() request: AuthenticatedRequest, @Param("shipmentId") shipmentId: string, @Body() body: unknown) { const context = requireContext(request); authorize(context, Permission.OrderWrite); return this.shipment.appendVersion(context, z.uuidv7().parse(shipmentId), AppendShipmentVersionInputSchema.parse(body)); }

  @Post(":shipmentId/versions/:versionId/reviews")
  @RequiresPermission(Permission.OrderWrite)
  review(@Req() request: AuthenticatedRequest, @Param("shipmentId") shipmentId: string, @Param("versionId") versionId: string, @Body() body: unknown) { const context = requireContext(request); authorize(context, Permission.OrderWrite); return this.shipment.reviewVersion(context, z.uuidv7().parse(shipmentId), z.uuidv7().parse(versionId), ReviewShipmentVersionInputSchema.parse(body)); }

  @Post(":shipmentId/writebacks")
  @RequiresPermission(Permission.OrderWrite)
  writeback(@Req() request: AuthenticatedRequest, @Param("shipmentId") shipmentId: string, @Body() body: unknown) { const context = requireContext(request); authorize(context, Permission.OrderWrite); return this.shipment.requestWriteback(context, z.uuidv7().parse(shipmentId), RequestShipmentWritebackInputSchema.parse(body)); }

  @Post(":shipmentId/tracking-events")
  @RequiresPermission(Permission.OrderWrite)
  tracking(@Req() request: AuthenticatedRequest, @Param("shipmentId") shipmentId: string, @Body() body: unknown) { const context = requireContext(request); authorize(context, Permission.OrderWrite); return this.shipment.recordTrackingEvent(context, z.uuidv7().parse(shipmentId), RecordTrackingEventInputSchema.parse(body)); }
}

@Controller("v1/orders")
export class OrderShipmentCommandController {
  constructor(@Inject(OrderShipmentService) private readonly shipment: OrderShipmentService) {}

  @Post(":id/shipments")
  @RequiresPermission(Permission.OrderWrite)
  create(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown) { const context = requireContext(request); authorize(context, Permission.OrderWrite); return this.shipment.create(context, z.uuidv7().parse(id), CreateShipmentInputSchema.parse(body)); }
}

function requireContext(request: AuthenticatedRequest) { if (!request.tenantContext) throw new Error("Tenant context is required"); return request.tenantContext; }
