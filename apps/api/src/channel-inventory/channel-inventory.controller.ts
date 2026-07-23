import { Body, Controller, Get, Inject, Param, Post, Req } from "@nestjs/common";
import { Permission, authorize } from "@yummyai/authz";
import {
  RecordChannelMutationReconciliationInputSchema,
  RecordNetworkInventorySnapshotInputSchema,
  ResolveChannelMutationReconciliationInputSchema,
  RunChannelAllocationInputSchema,
  UpsertChannelAllocationPolicyInputSchema,
} from "@yummyai/contracts/channel-inventory";
import { z } from "zod";

import { RequiresPermission } from "../auth/permissions.decorator.js";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { ChannelInventoryService } from "./channel-inventory.service.js";

@Controller("v1/channel-inventory")
export class ChannelInventoryController {
  constructor(@Inject(ChannelInventoryService) private readonly service: ChannelInventoryService) {}

  @Get("workspace")
  @RequiresPermission(Permission.ChannelInventoryRead)
  workspace(@Req() request: AuthenticatedRequest) {
    const context = requireContext(request);
    authorize(context, Permission.ChannelInventoryRead);
    return this.service.workspace(context);
  }

  @Post("snapshots")
  @RequiresPermission(Permission.ChannelInventoryWrite)
  recordSnapshot(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const context = requireContext(request);
    authorize(context, Permission.ChannelInventoryWrite);
    return this.service.recordSnapshot(context, RecordNetworkInventorySnapshotInputSchema.parse(body));
  }

  @Post("allocation-policies")
  @RequiresPermission(Permission.ChannelInventoryWrite)
  upsertPolicy(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const context = requireContext(request);
    authorize(context, Permission.ChannelInventoryWrite);
    return this.service.upsertPolicy(context, UpsertChannelAllocationPolicyInputSchema.parse(body));
  }

  @Post("allocation-runs")
  @RequiresPermission(Permission.ChannelInventoryWrite)
  runAllocation(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const context = requireContext(request);
    authorize(context, Permission.ChannelInventoryWrite);
    return this.service.runAllocation(context, RunChannelAllocationInputSchema.parse(body));
  }

  @Post("reconciliations")
  @RequiresPermission(Permission.ChannelInventoryWrite)
  recordReconciliation(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const context = requireContext(request);
    authorize(context, Permission.ChannelInventoryWrite);
    return this.service.recordReconciliation(
      context,
      RecordChannelMutationReconciliationInputSchema.parse(body),
    );
  }

  @Post("reconciliations/:reconciliationId/resolve")
  @RequiresPermission(Permission.ChannelInventoryReconcile)
  resolveReconciliation(
    @Req() request: AuthenticatedRequest,
    @Param("reconciliationId") reconciliationId: string,
    @Body() body: unknown,
  ) {
    const context = requireContext(request);
    authorize(context, Permission.ChannelInventoryReconcile);
    return this.service.resolveReconciliation(
      context,
      z.uuidv7().parse(reconciliationId),
      ResolveChannelMutationReconciliationInputSchema.parse(body),
    );
  }
}

function requireContext(request: AuthenticatedRequest) {
  if (!request.tenantContext) throw new Error("Tenant context is required");
  return request.tenantContext;
}
