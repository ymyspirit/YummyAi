import { Body, Controller, Get, Inject, Param, Post, Req } from "@nestjs/common";
import { Permission, authorize } from "@yummyai/authz";
import {
  CreateFulfillmentSupplierInputSchema, CreateRoutingPolicyInputSchema,
  CreateSupplierCapacityWindowInputSchema, CreateSupplierCapabilitySnapshotInputSchema,
  CreateSupplierQuoteInputSchema, ManualRoutingOverrideInputSchema, ReviewRoutingDecisionInputSchema,
} from "@yummyai/contracts";
import { z } from "zod";

import { RequiresPermission } from "../auth/permissions.decorator.js";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { OrderRoutingService } from "./order-routing.service.js";

@Controller("v1/sourcing")
export class SupplierRoutingController {
  constructor(@Inject(OrderRoutingService) private readonly routing: OrderRoutingService) {}

  @Get("suppliers")
  @RequiresPermission(Permission.OrderRead)
  suppliers(@Req() request: AuthenticatedRequest) { const context = requireContext(request); authorize(context, Permission.OrderRead); return this.routing.listSuppliers(context); }

  @Post("suppliers")
  @RequiresPermission(Permission.OrderWrite)
  createSupplier(@Req() request: AuthenticatedRequest, @Body() body: unknown) { const context = requireContext(request); authorize(context, Permission.OrderWrite); return this.routing.createSupplier(context, CreateFulfillmentSupplierInputSchema.parse(body)); }

  @Post("capability-snapshots")
  @RequiresPermission(Permission.OrderWrite)
  capability(@Req() request: AuthenticatedRequest, @Body() body: unknown) { const context = requireContext(request); authorize(context, Permission.OrderWrite); return this.routing.addCapability(context, CreateSupplierCapabilitySnapshotInputSchema.parse(body)); }

  @Post("quotes")
  @RequiresPermission(Permission.OrderWrite)
  quote(@Req() request: AuthenticatedRequest, @Body() body: unknown) { const context = requireContext(request); authorize(context, Permission.OrderWrite); return this.routing.addQuote(context, CreateSupplierQuoteInputSchema.parse(body)); }

  @Post("capacity-windows")
  @RequiresPermission(Permission.OrderWrite)
  capacity(@Req() request: AuthenticatedRequest, @Body() body: unknown) { const context = requireContext(request); authorize(context, Permission.OrderWrite); return this.routing.addCapacity(context, CreateSupplierCapacityWindowInputSchema.parse(body)); }

  @Post("routing-policies")
  @RequiresPermission(Permission.OrderWrite)
  policy(@Req() request: AuthenticatedRequest, @Body() body: unknown) { const context = requireContext(request); authorize(context, Permission.OrderWrite); return this.routing.createPolicy(context, CreateRoutingPolicyInputSchema.parse(body)); }

  @Get("routing-decisions/:decisionId")
  @RequiresPermission(Permission.OrderRead)
  decision(@Req() request: AuthenticatedRequest, @Param("decisionId") decisionId: string) { const context = requireContext(request); authorize(context, Permission.OrderRead); return this.routing.get(context, z.uuidv7().parse(decisionId)); }

  @Post("routing-decisions/:decisionId/override")
  @RequiresPermission(Permission.OrderWrite)
  override(@Req() request: AuthenticatedRequest, @Param("decisionId") decisionId: string, @Body() body: unknown) { const context = requireContext(request); authorize(context, Permission.OrderWrite); return this.routing.override(context, z.uuidv7().parse(decisionId), ManualRoutingOverrideInputSchema.parse(body)); }

  @Post("routing-decisions/:decisionId/review")
  @RequiresPermission(Permission.OrderWrite)
  review(@Req() request: AuthenticatedRequest, @Param("decisionId") decisionId: string, @Body() body: unknown) { const context = requireContext(request); authorize(context, Permission.OrderWrite); return this.routing.review(context, z.uuidv7().parse(decisionId), ReviewRoutingDecisionInputSchema.parse(body)); }
}

function requireContext(request: AuthenticatedRequest) { if (!request.tenantContext) throw new Error("Tenant context is required"); return request.tenantContext; }
