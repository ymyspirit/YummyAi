import { Body, Controller, Get, Inject, Param, Post, Req } from "@nestjs/common";
import { Permission, authorize } from "@yummyai/authz";
import type { ListingDraft, ListingPlatform } from "@yummyai/platform-rules";
import { z } from "zod";

import { RequiresPermission } from "../auth/permissions.decorator.js";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { ListingDraftSchema, ListingService } from "./listing.service.js";

@Controller("v1/listings")
export class ListingController {
  constructor(@Inject(ListingService) private readonly service: ListingService) {}

  @Get()
  @RequiresPermission(Permission.ListingRead)
  list(@Req() request: AuthenticatedRequest) { const context = requireContext(request); authorize(context, Permission.ListingRead); return this.service.list(context); }

  @Get(":id")
  @RequiresPermission(Permission.ListingRead)
  get(@Req() request: AuthenticatedRequest, @Param("id") id: string) { const context = requireContext(request); authorize(context, Permission.ListingRead); return this.service.getWorkspace(context, z.uuidv7().parse(id)); }

  @Post()
  @RequiresPermission(Permission.ListingWrite)
  create(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const context = requireContext(request); authorize(context, Permission.ListingWrite);
    const input = z.object({ spuId: z.uuidv7(), platform: z.enum(["amazon", "etsy"]), locale: z.string(), content: ListingDraftSchema }).parse(body);
    return this.service.create(context, { ...input, platform: input.platform as ListingPlatform, content: input.content as ListingDraft });
  }

  @Get(":id/versions")
  @RequiresPermission(Permission.ListingRead)
  versions(@Req() request: AuthenticatedRequest, @Param("id") id: string) { const context = requireContext(request); authorize(context, Permission.ListingRead); return this.service.listVersions(context, z.uuidv7().parse(id)); }

  @Post(":id/versions")
  @RequiresPermission(Permission.ListingWrite)
  save(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown) { const context = requireContext(request); authorize(context, Permission.ListingWrite); return this.service.saveVersion(context, z.uuidv7().parse(id), ListingDraftSchema.parse(body) as ListingDraft); }

  @Post(":id/ai-versions")
  @RequiresPermission(Permission.ListingWrite)
  ai(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown) { const context = requireContext(request); authorize(context, Permission.ListingWrite); return this.service.applyAiSuggestion(context, z.uuidv7().parse(id), ListingDraftSchema.parse(body) as ListingDraft); }

  @Post(":id/versions/:versionId/approve")
  @RequiresPermission(Permission.ListingReview)
  approve(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Param("versionId") versionId: string) { const context = requireContext(request); authorize(context, Permission.ListingReview); return this.service.approveVersion(context, z.uuidv7().parse(id), z.uuidv7().parse(versionId)); }
}

function requireContext(request: AuthenticatedRequest) { if (!request.tenantContext) throw new Error("Tenant context is required"); return request.tenantContext; }
