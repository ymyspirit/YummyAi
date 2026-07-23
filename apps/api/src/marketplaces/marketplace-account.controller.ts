import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Req } from "@nestjs/common";
import { Permission, authorize } from "@yummyai/authz";
import {
  AmazonPrivateAuthorizationInputSchema,
  CreateMarketplaceAccountInputSchema,
  MarketplaceOAuthCompleteInputSchema,
  SyncMarketplaceCapabilitiesInputSchema,
  UpdateMarketplaceAccountInputSchema,
} from "@yummyai/contracts";
import { z } from "zod";

import { RequiresPermission } from "../auth/permissions.decorator.js";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { MarketplaceAuthorizationService } from "./marketplace-authorization.service.js";
import { MarketplaceCapabilityService } from "./marketplace-capability.service.js";
import { MarketplaceAccountService } from "./marketplace-account.service.js";

@Controller("v1/marketplace-accounts")
export class MarketplaceAccountController {
  constructor(
    @Inject(MarketplaceAccountService) private readonly accounts: MarketplaceAccountService,
    @Inject(MarketplaceAuthorizationService) private readonly authorization: MarketplaceAuthorizationService,
    @Inject(MarketplaceCapabilityService) private readonly capability: MarketplaceCapabilityService,
  ) {}

  @Get()
  @RequiresPermission(Permission.StoreRead)
  list(@Req() request: AuthenticatedRequest) {
    const context = requireContext(request);
    authorize(context, Permission.StoreRead);
    return this.accounts.list(context);
  }

  @Get(":id")
  @RequiresPermission(Permission.StoreRead)
  get(@Req() request: AuthenticatedRequest, @Param("id") id: string) {
    const context = requireContext(request);
    authorize(context, Permission.StoreRead);
    return this.accounts.get(context, z.uuidv7().parse(id));
  }

  @Post()
  @RequiresPermission(Permission.StoreManage)
  create(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const context = requireContext(request);
    authorize(context, Permission.StoreManage);
    return this.accounts.create(context, CreateMarketplaceAccountInputSchema.parse(body));
  }

  @Patch(":id")
  @RequiresPermission(Permission.StoreManage)
  update(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown) {
    const context = requireContext(request);
    authorize(context, Permission.StoreManage);
    return this.accounts.update(context, z.uuidv7().parse(id), UpdateMarketplaceAccountInputSchema.parse(body));
  }

  @Post(":id/authorization/private")
  @RequiresPermission(Permission.StoreAuthorize)
  authorizePrivate(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown) {
    const context = requireContext(request);
    authorize(context, Permission.StoreAuthorize);
    return this.authorization.authorizeAmazonPrivate(
      context,
      z.uuidv7().parse(id),
      AmazonPrivateAuthorizationInputSchema.parse(body),
    );
  }

  @Post(":id/authorization/oauth/start")
  @RequiresPermission(Permission.StoreAuthorize)
  startOAuth(@Req() request: AuthenticatedRequest, @Param("id") id: string) {
    const context = requireContext(request);
    authorize(context, Permission.StoreAuthorize);
    return this.authorization.startOAuth(context, z.uuidv7().parse(id));
  }

  @Post(":id/authorization/oauth/complete")
  @RequiresPermission(Permission.StoreAuthorize)
  completeOAuth(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown) {
    const context = requireContext(request);
    authorize(context, Permission.StoreAuthorize);
    return this.authorization.completeOAuth(
      context,
      z.uuidv7().parse(id),
      MarketplaceOAuthCompleteInputSchema.parse(body),
    );
  }

  @Delete(":id/authorization")
  @RequiresPermission(Permission.StoreAuthorize)
  revokeAuthorization(@Req() request: AuthenticatedRequest, @Param("id") id: string) {
    const context = requireContext(request);
    authorize(context, Permission.StoreAuthorize);
    return this.authorization.revoke(context, z.uuidv7().parse(id));
  }

  @Get(":id/capabilities")
  @RequiresPermission(Permission.StoreRead)
  latestCapabilities(@Req() request: AuthenticatedRequest, @Param("id") id: string) {
    const context = requireContext(request);
    authorize(context, Permission.StoreRead);
    return this.capability.latest(context, z.uuidv7().parse(id));
  }

  @Post(":id/capabilities/sync")
  @RequiresPermission(Permission.StoreManage)
  syncCapabilities(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown) {
    const context = requireContext(request);
    authorize(context, Permission.StoreManage);
    return this.capability.sync(
      context,
      z.uuidv7().parse(id),
      SyncMarketplaceCapabilitiesInputSchema.parse(body ?? {}),
    );
  }
}

function requireContext(request: AuthenticatedRequest) {
  if (!request.tenantContext) throw new Error("Tenant context is required");
  return request.tenantContext;
}
