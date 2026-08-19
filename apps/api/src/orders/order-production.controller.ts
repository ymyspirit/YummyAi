import { Body, Controller, Get, Inject, Param, Post, Query, Req } from "@nestjs/common";
import { Permission, authorize } from "@yummyai/authz";
import {
  CreateProductionBatchInputSchema, CreateProductionOrderInputSchema, CreateProductionRecoveryInputSchema,
  CreateQualityStandardInputSchema, RecordProductionBatchEventInputSchema, RecordProductionMilestoneInputSchema,
  RecordProductionRecoveryEventInputSchema, RecordQualityInspectionInputSchema,
} from "@yummyai/contracts";
import { z } from "zod";

import { RequiresPermission } from "../auth/permissions.decorator.js";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { OrderProductionService } from "./order-production.service.js";

@Controller("v1/production")
export class OrderProductionController {
  constructor(@Inject(OrderProductionService) private readonly production: OrderProductionService) {}

  @Get("orders")
  @RequiresPermission(Permission.OrderRead)
  list(@Req() request: AuthenticatedRequest, @Query("orderId") orderId: unknown) { const context = requireContext(request); authorize(context, Permission.OrderRead); return this.production.list(context, orderId === undefined ? undefined : z.uuidv7().parse(orderId)); }

  @Get("orders/:productionOrderId")
  @RequiresPermission(Permission.OrderRead)
  get(@Req() request: AuthenticatedRequest, @Param("productionOrderId") productionOrderId: string) { const context = requireContext(request); authorize(context, Permission.OrderRead); return this.production.get(context, z.uuidv7().parse(productionOrderId)); }

  @Post("orders/:productionOrderId/milestones")
  @RequiresPermission(Permission.OrderWrite)
  milestone(@Req() request: AuthenticatedRequest, @Param("productionOrderId") productionOrderId: string, @Body() body: unknown) { const context = requireContext(request); authorize(context, Permission.OrderWrite); return this.production.recordMilestone(context, z.uuidv7().parse(productionOrderId), RecordProductionMilestoneInputSchema.parse(body)); }

  @Post("orders/:productionOrderId/inspections")
  @RequiresPermission(Permission.OrderWrite)
  inspect(@Req() request: AuthenticatedRequest, @Param("productionOrderId") productionOrderId: string, @Body() body: unknown) { const context = requireContext(request); authorize(context, Permission.OrderWrite); return this.production.inspect(context, z.uuidv7().parse(productionOrderId), RecordQualityInspectionInputSchema.parse(body)); }

  @Post("batches")
  @RequiresPermission(Permission.OrderWrite)
  createBatch(@Req() request: AuthenticatedRequest, @Body() body: unknown) { const context = requireContext(request); authorize(context, Permission.OrderWrite); return this.production.createBatch(context, CreateProductionBatchInputSchema.parse(body)); }

  @Get("batches/:batchId")
  @RequiresPermission(Permission.OrderRead)
  getBatch(@Req() request: AuthenticatedRequest, @Param("batchId") batchId: string) { const context = requireContext(request); authorize(context, Permission.OrderRead); return this.production.getBatch(context, z.uuidv7().parse(batchId)); }

  @Post("batches/:batchId/events")
  @RequiresPermission(Permission.OrderWrite)
  batchEvent(@Req() request: AuthenticatedRequest, @Param("batchId") batchId: string, @Body() body: unknown) { const context = requireContext(request); authorize(context, Permission.OrderWrite); return this.production.recordBatchEvent(context, z.uuidv7().parse(batchId), RecordProductionBatchEventInputSchema.parse(body)); }

  @Post("quality-standards")
  @RequiresPermission(Permission.OrderWrite)
  standard(@Req() request: AuthenticatedRequest, @Body() body: unknown) { const context = requireContext(request); authorize(context, Permission.OrderWrite); return this.production.createQualityStandard(context, CreateQualityStandardInputSchema.parse(body)); }

  @Post("recoveries")
  @RequiresPermission(Permission.OrderWrite)
  recover(@Req() request: AuthenticatedRequest, @Body() body: unknown) { const context = requireContext(request); authorize(context, Permission.OrderWrite); return this.production.recover(context, CreateProductionRecoveryInputSchema.parse(body)); }

  @Get("recoveries/:recoveryCaseId")
  @RequiresPermission(Permission.OrderRead)
  getRecovery(@Req() request: AuthenticatedRequest, @Param("recoveryCaseId") recoveryCaseId: string) { const context = requireContext(request); authorize(context, Permission.OrderRead); return this.production.getRecovery(context, z.uuidv7().parse(recoveryCaseId)); }

  @Post("recoveries/:recoveryCaseId/events")
  @RequiresPermission(Permission.OrderWrite)
  recoveryEvent(@Req() request: AuthenticatedRequest, @Param("recoveryCaseId") recoveryCaseId: string, @Body() body: unknown) { const context = requireContext(request); authorize(context, Permission.OrderWrite); return this.production.recordRecoveryEvent(context, z.uuidv7().parse(recoveryCaseId), RecordProductionRecoveryEventInputSchema.parse(body)); }
}

@Controller("v1/orders")
export class OrderProductionCommandController {
  constructor(@Inject(OrderProductionService) private readonly production: OrderProductionService) {}

  @Post(":id/production")
  @RequiresPermission(Permission.OrderWrite)
  create(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown) { const context = requireContext(request); authorize(context, Permission.OrderWrite); return this.production.create(context, z.uuidv7().parse(id), CreateProductionOrderInputSchema.parse(body)); }
}

function requireContext(request: AuthenticatedRequest) { if (!request.tenantContext) throw new Error("Tenant context is required"); return request.tenantContext; }
