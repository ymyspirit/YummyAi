import { Body, Controller, Get, Inject, Param, Post, Query, Req } from "@nestjs/common";
import { Permission, authorize } from "@yummyai/authz";
import { CreateMarketplaceListingSyncInputSchema, ListMarketplaceListingSyncsInputSchema } from "@yummyai/contracts";
import { z } from "zod";

import { RequiresPermission } from "../auth/permissions.decorator.js";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { MarketplaceListingSyncService } from "./marketplace-listing-sync.service.js";

@Controller("v1/marketplace-listing-syncs")
export class MarketplaceListingSyncController {
  constructor(@Inject(MarketplaceListingSyncService) private readonly service: MarketplaceListingSyncService) {}

  @Post()
  @RequiresPermission(Permission.ListingPublish)
  create(@Req() request: AuthenticatedRequest, @Body() body: unknown) { const context = requireContext(request); authorize(context, Permission.ListingPublish); return this.service.create(context, CreateMarketplaceListingSyncInputSchema.parse(body)); }

  @Get()
  @RequiresPermission(Permission.ListingRead)
  list(@Req() request: AuthenticatedRequest, @Query() query: unknown) { const context = requireContext(request); authorize(context, Permission.ListingRead); return this.service.list(context, ListMarketplaceListingSyncsInputSchema.parse(query)); }

  @Get(":id")
  @RequiresPermission(Permission.ListingRead)
  get(@Req() request: AuthenticatedRequest, @Param("id") id: string) { const context = requireContext(request); authorize(context, Permission.ListingRead); return this.service.get(context, z.uuidv7().parse(id)); }

  @Get(":id/events")
  @RequiresPermission(Permission.ListingRead)
  events(@Req() request: AuthenticatedRequest, @Param("id") id: string) { const context = requireContext(request); authorize(context, Permission.ListingRead); return this.service.events(context, z.uuidv7().parse(id)); }
}

function requireContext(request: AuthenticatedRequest) { if (!request.tenantContext) throw new Error("Tenant context is required"); return request.tenantContext; }
