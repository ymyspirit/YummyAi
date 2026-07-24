import { Body, Controller, Get, Inject, Param, Post, Query, Req } from "@nestjs/common";
import { Permission, authorize } from "@yummyai/authz";
import {
  CancelMarketplacePublicationInputSchema,
  CreateMarketplacePublicationBatchInputSchema,
  ListMarketplacePublicationBatchesInputSchema,
} from "@yummyai/contracts";
import { z } from "zod";

import { RequiresPermission } from "../auth/permissions.decorator.js";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { MarketplacePublicationBatchService } from "./marketplace-publication-batch.service.js";

@Controller("v1/marketplace-publication-batches")
export class MarketplacePublicationBatchController {
  constructor(@Inject(MarketplacePublicationBatchService) private readonly batches: MarketplacePublicationBatchService) {}

  @Post()
  @RequiresPermission(Permission.ListingPublish)
  create(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const context = requireContext(request);
    authorize(context, Permission.ListingPublish);
    return this.batches.create(context, CreateMarketplacePublicationBatchInputSchema.parse(body));
  }

  @Post(":id/continue")
  @RequiresPermission(Permission.ListingPublish)
  continue(@Req() request: AuthenticatedRequest, @Param("id") id: string) {
    const context = requireContext(request);
    authorize(context, Permission.ListingPublish);
    return this.batches.continue(context, z.uuidv7().parse(id));
  }

  @Post(":id/cancel")
  @RequiresPermission(Permission.ListingPublish)
  cancel(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown) {
    const context = requireContext(request);
    authorize(context, Permission.ListingPublish);
    return this.batches.cancel(context, z.uuidv7().parse(id), CancelMarketplacePublicationInputSchema.parse(body));
  }

  @Get()
  @RequiresPermission(Permission.ListingRead)
  list(@Req() request: AuthenticatedRequest, @Query() query: unknown) {
    const context = requireContext(request);
    authorize(context, Permission.ListingRead);
    return this.batches.list(context, ListMarketplacePublicationBatchesInputSchema.parse(query));
  }

  @Get(":id")
  @RequiresPermission(Permission.ListingRead)
  get(@Req() request: AuthenticatedRequest, @Param("id") id: string) {
    const context = requireContext(request);
    authorize(context, Permission.ListingRead);
    return this.batches.get(context, z.uuidv7().parse(id));
  }
}

function requireContext(request: AuthenticatedRequest) {
  if (!request.tenantContext) throw new Error("Tenant context is required");
  return request.tenantContext;
}
