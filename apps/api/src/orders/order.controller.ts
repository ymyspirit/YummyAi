import { Body, Controller, Get, Inject, NotFoundException, Param, Post, Query, Req } from "@nestjs/common";
import { Permission, authorize } from "@yummyai/authz";
import {
  AnonymizeOrderProtectedDetailsCommandSchema, CreateOrderProofInputSchema, InitializeOrderCustomizationInputSchema, ListOrdersInputSchema,
  OpenOrderExceptionCommandSchema, OrderPiiAccessPurposeSchema, OrderSideStateCommandSchema,
  RecordCustomerProofDecisionInputSchema,
  RegisterOrderCustomizationFileInputSchema,
  RemapOrderCustomizationInputSchema,
  RouteOrderLineInputSchema,
  OrderTransitionCommandSchema, ResolveOrderExceptionCommandSchema,
} from "@yummyai/contracts";
import { z } from "zod";

import { RequiresPermission } from "../auth/permissions.decorator.js";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { OrderService } from "./order.service.js";
import { OrderIngestionService } from "./order-ingestion.service.js";
import { OrderCustomizationService } from "./order-customization.service.js";
import { OrderRoutingService } from "./order-routing.service.js";

@Controller("v1/orders")
export class OrderController {
  constructor(
    @Inject(OrderService) private readonly orders: OrderService,
    @Inject(OrderIngestionService) private readonly ingestion: OrderIngestionService,
    @Inject(OrderCustomizationService) private readonly customization: OrderCustomizationService,
    @Inject(OrderRoutingService) private readonly routing: OrderRoutingService,
  ) {}

  @Get()
  @RequiresPermission(Permission.OrderRead)
  list(@Req() request: AuthenticatedRequest, @Query() query: unknown) { const context = requireContext(request); authorize(context, Permission.OrderRead); return this.orders.list(context, ListOrdersInputSchema.parse(query)); }

  @Get("ingestion/runs")
  @RequiresPermission(Permission.OrderRead)
  ingestionRuns(@Req() request: AuthenticatedRequest, @Query("limit") limit: unknown) { const context = requireContext(request); authorize(context, Permission.OrderRead); return this.ingestion.list(context, z.coerce.number().int().min(1).max(100).default(20).parse(limit)); }

  @Get("customizations")
  @RequiresPermission(Permission.OrderRead)
  customizationRequirements(@Req() request: AuthenticatedRequest, @Query("orderId") orderId: unknown) { const context = requireContext(request); authorize(context, Permission.OrderRead); return this.customization.list(context, orderId === undefined ? undefined : z.uuidv7().parse(orderId)); }

  @Get("routing")
  @RequiresPermission(Permission.OrderRead)
  routingDecisions(@Req() request: AuthenticatedRequest, @Query("orderId") orderId: unknown) { const context = requireContext(request); authorize(context, Permission.OrderRead); return this.routing.list(context, orderId === undefined ? undefined : z.uuidv7().parse(orderId)); }

  @Get("exceptions")
  @RequiresPermission(Permission.OrderRead)
  exceptionQueue(@Req() request: AuthenticatedRequest, @Query("status") status: unknown) {
    const context = requireContext(request); authorize(context, Permission.OrderRead);
    return this.orders.listExceptions(context, z.enum(["open", "resolved"]).optional().parse(status));
  }

  @Get(":id/customizations/:requirementId")
  @RequiresPermission(Permission.OrderRead)
  async customizationRequirement(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Param("requirementId") requirementId: string) { const context = requireContext(request); authorize(context, Permission.OrderRead); const orderId = z.uuidv7().parse(id); const result = await this.customization.get(context, z.uuidv7().parse(requirementId)); if (result.orderId !== orderId) throw new NotFoundException("Order customization requirement not found"); return result; }

  @Post(":id/customizations")
  @RequiresPermission(Permission.OrderWrite)
  initializeCustomization(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown) { const context = requireContext(request); authorize(context, Permission.OrderWrite); return this.customization.initialize(context, z.uuidv7().parse(id), InitializeOrderCustomizationInputSchema.parse(body)); }

  @Post(":id/customizations/:requirementId/versions")
  @RequiresPermission(Permission.OrderWrite)
  remapCustomization(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Param("requirementId") requirementId: string, @Body() body: unknown) { const context = requireContext(request); authorize(context, Permission.OrderWrite); return this.customization.remap(context, z.uuidv7().parse(id), z.uuidv7().parse(requirementId), RemapOrderCustomizationInputSchema.parse(body)); }

  @Post(":id/customizations/:requirementId/versions/:versionId/files")
  @RequiresPermission(Permission.OrderWrite)
  registerCustomizationFile(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Param("requirementId") requirementId: string, @Param("versionId") versionId: string, @Body() body: unknown) { const context = requireContext(request); authorize(context, Permission.OrderWrite); authorize(context, Permission.AssetWrite); return this.customization.registerFileForRequirement(context, z.uuidv7().parse(id), z.uuidv7().parse(requirementId), z.uuidv7().parse(versionId), RegisterOrderCustomizationFileInputSchema.parse(body)); }

  @Post(":id/customizations/:requirementId/files/:intakeId/scan")
  @RequiresPermission(Permission.OrderWrite)
  queueCustomizationFileScan(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Param("requirementId") requirementId: string, @Param("intakeId") intakeId: string) { const context = requireContext(request); authorize(context, Permission.OrderWrite); authorize(context, Permission.AssetWrite); return this.customization.queueFileScan(context, z.uuidv7().parse(id), z.uuidv7().parse(requirementId), z.uuidv7().parse(intakeId)); }

  @Post(":id/customizations/:requirementId/files/:intakeId/promote")
  @RequiresPermission(Permission.OrderWrite)
  promoteCustomizationFile(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Param("requirementId") requirementId: string, @Param("intakeId") intakeId: string) { const context = requireContext(request); authorize(context, Permission.OrderWrite); authorize(context, Permission.AssetPromote); return this.customization.promoteFileForRequirement(context, z.uuidv7().parse(id), z.uuidv7().parse(requirementId), z.uuidv7().parse(intakeId)); }

  @Post(":id/customizations/:requirementId/proofs")
  @RequiresPermission(Permission.OrderWrite)
  createProof(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Param("requirementId") requirementId: string, @Body() body: unknown) { const context = requireContext(request); authorize(context, Permission.OrderWrite); return this.customization.createProof(context, z.uuidv7().parse(id), z.uuidv7().parse(requirementId), CreateOrderProofInputSchema.parse(body)); }

  @Post(":id/proofs/:proofId/decisions")
  @RequiresPermission(Permission.OrderWrite)
  recordProofDecision(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Param("proofId") proofId: string, @Body() body: unknown) { const context = requireContext(request); authorize(context, Permission.OrderWrite); return this.customization.recordDecision(context, z.uuidv7().parse(id), z.uuidv7().parse(proofId), RecordCustomerProofDecisionInputSchema.parse(body)); }

  @Post(":id/routing")
  @RequiresPermission(Permission.OrderWrite)
  route(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown) { const context = requireContext(request); authorize(context, Permission.OrderWrite); return this.routing.route(context, z.uuidv7().parse(id), RouteOrderLineInputSchema.parse(body)); }

  @Get(":id")
  @RequiresPermission(Permission.OrderRead)
  get(@Req() request: AuthenticatedRequest, @Param("id") id: string) { const context = requireContext(request); authorize(context, Permission.OrderRead); return this.orders.get(context, z.uuidv7().parse(id)); }

  @Get(":id/events")
  @RequiresPermission(Permission.OrderRead)
  events(@Req() request: AuthenticatedRequest, @Param("id") id: string) { const context = requireContext(request); authorize(context, Permission.OrderRead); return this.orders.events(context, z.uuidv7().parse(id)); }

  @Get(":id/exceptions")
  @RequiresPermission(Permission.OrderRead)
  exceptions(@Req() request: AuthenticatedRequest, @Param("id") id: string) { const context = requireContext(request); authorize(context, Permission.OrderRead); return this.orders.exceptions(context, z.uuidv7().parse(id)); }

  @Get(":id/fulfillment")
  @RequiresPermission(Permission.OrderPiiRead)
  fulfillment(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Query("purpose") purpose: unknown) { const context = requireContext(request); authorize(context, Permission.OrderPiiRead); return this.orders.fulfillmentDetails(context, z.uuidv7().parse(id), OrderPiiAccessPurposeSchema.parse(purpose)); }

  @Post(":id/protected-details/anonymize")
  @RequiresPermission(Permission.OrderPiiAnonymize)
  anonymizeProtectedDetails(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown) { const context = requireContext(request); authorize(context, Permission.OrderPiiAnonymize); return this.orders.anonymizeProtectedDetails(context, z.uuidv7().parse(id), AnonymizeOrderProtectedDetailsCommandSchema.parse(body)); }

  @Post(":id/transitions")
  @RequiresPermission(Permission.OrderWrite)
  transition(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown) { const context = requireContext(request); authorize(context, Permission.OrderWrite); return this.orders.transition(context, z.uuidv7().parse(id), OrderTransitionCommandSchema.parse(body)); }

  @Post(":id/side-state")
  @RequiresPermission(Permission.OrderWrite)
  sideState(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown) { const context = requireContext(request); authorize(context, Permission.OrderWrite); return this.orders.changeSideState(context, z.uuidv7().parse(id), OrderSideStateCommandSchema.parse(body)); }

  @Post(":id/exceptions")
  @RequiresPermission(Permission.OrderWrite)
  openException(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown) { const context = requireContext(request); authorize(context, Permission.OrderWrite); return this.orders.openException(context, z.uuidv7().parse(id), OpenOrderExceptionCommandSchema.parse(body)); }

  @Post(":id/exceptions/:exceptionId/resolve")
  @RequiresPermission(Permission.OrderWrite)
  resolveException(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Param("exceptionId") exceptionId: string, @Body() body: unknown) { const context = requireContext(request); authorize(context, Permission.OrderWrite); return this.orders.resolveException(context, z.uuidv7().parse(id), z.uuidv7().parse(exceptionId), ResolveOrderExceptionCommandSchema.parse(body)); }
}

function requireContext(request: AuthenticatedRequest) { if (!request.tenantContext) throw new Error("Tenant context is required"); return request.tenantContext; }
