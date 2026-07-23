import { Body, Controller, Get, Inject, Param, Patch, Post, Req } from "@nestjs/common";
import { Permission, authorize } from "@yummyai/authz";
import { CreateMarketplaceAutomationRuleInputSchema, UpdateMarketplaceAutomationRuleInputSchema } from "@yummyai/contracts";
import { z } from "zod";

import { RequiresPermission } from "../auth/permissions.decorator.js";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { MarketplaceAutomationService } from "./marketplace-automation.service.js";

@Controller("v1/marketplace-automation-rules")
export class MarketplaceAutomationController {
  constructor(@Inject(MarketplaceAutomationService) private readonly automations: MarketplaceAutomationService) {}

  @Post()
  @RequiresPermission(Permission.ListingPublish)
  create(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const context = requireContext(request); authorize(context, Permission.ListingPublish);
    return this.automations.create(context, CreateMarketplaceAutomationRuleInputSchema.parse(body));
  }

  @Get()
  @RequiresPermission(Permission.ListingRead)
  list(@Req() request: AuthenticatedRequest) {
    const context = requireContext(request); authorize(context, Permission.ListingRead);
    return this.automations.list(context);
  }

  @Patch(":id")
  @RequiresPermission(Permission.ListingPublish)
  update(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown) {
    const context = requireContext(request); authorize(context, Permission.ListingPublish);
    return this.automations.update(context, z.uuidv7().parse(id), UpdateMarketplaceAutomationRuleInputSchema.parse(body));
  }

  @Get(":id/runs")
  @RequiresPermission(Permission.ListingRead)
  runs(@Req() request: AuthenticatedRequest, @Param("id") id: string) {
    const context = requireContext(request); authorize(context, Permission.ListingRead);
    return this.automations.runs(context, z.uuidv7().parse(id));
  }
}

function requireContext(request: AuthenticatedRequest) {
  if (!request.tenantContext) throw new Error("Tenant context is required");
  return request.tenantContext;
}
