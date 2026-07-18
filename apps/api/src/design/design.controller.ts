import { Body, Controller, Get, Inject, Param, Post, Req } from "@nestjs/common";
import { Permission, authorize } from "@yummyai/authz";
import {
  ApproveAssetRightsInputSchema,
  CreateDesignTaskInputSchema,
  ReviewDesignVersionInputSchema,
  UploadDesignVersionInputSchema,
} from "@yummyai/contracts";
import { z } from "zod";

import { RequiresPermission } from "../auth/permissions.decorator.js";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { DesignService } from "./design.service.js";

@Controller("v1/design")
export class DesignController {
  constructor(@Inject(DesignService) private readonly designs: DesignService) {}

  @Get("tasks")
  @RequiresPermission(Permission.DesignRead)
  listTasks(@Req() request: AuthenticatedRequest) {
    const context = requireContext(request);
    authorize(context, Permission.DesignRead);
    return this.designs.listTasks(context);
  }

  @Post("tasks")
  @RequiresPermission(Permission.DesignWrite)
  createTask(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const context = requireContext(request);
    authorize(context, Permission.DesignWrite);
    return this.designs.createTask(context, CreateDesignTaskInputSchema.parse(body));
  }

  @Get("tasks/:id/versions")
  @RequiresPermission(Permission.DesignRead)
  listVersions(@Req() request: AuthenticatedRequest, @Param("id") id: string) {
    const context = requireContext(request);
    authorize(context, Permission.DesignRead);
    return this.designs.listVersions(context, z.uuidv7().parse(id));
  }

  @Post("tasks/:id/versions")
  @RequiresPermission(Permission.DesignWrite)
  uploadVersion(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown) {
    const context = requireContext(request);
    authorize(context, Permission.DesignWrite);
    return this.designs.uploadVersion(context, z.uuidv7().parse(id), UploadDesignVersionInputSchema.parse(body));
  }

  @Post("versions/:id/review")
  @RequiresPermission(Permission.DesignReview)
  reviewVersion(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown) {
    const context = requireContext(request);
    authorize(context, Permission.DesignReview);
    return this.designs.reviewVersion(context, z.uuidv7().parse(id), ReviewDesignVersionInputSchema.parse(body));
  }

  @Post("tasks/:taskId/primary/:versionId")
  @RequiresPermission(Permission.DesignReview)
  setPrimary(@Req() request: AuthenticatedRequest, @Param("taskId") taskId: string, @Param("versionId") versionId: string) {
    const context = requireContext(request);
    authorize(context, Permission.DesignReview);
    return this.designs.setPrimaryVersion(context, z.uuidv7().parse(taskId), z.uuidv7().parse(versionId));
  }

  @Post("assets/:id/rights")
  @RequiresPermission(Permission.AssetPromote)
  approveRights(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown) {
    const context = requireContext(request);
    authorize(context, Permission.AssetPromote);
    const input = ApproveAssetRightsInputSchema.parse(body);
    return this.designs.approveAssetRights(context, z.uuidv7().parse(id), input.rightsSource);
  }

  @Post("assets/:id/promote")
  @RequiresPermission(Permission.AssetPromote)
  promoteAsset(@Req() request: AuthenticatedRequest, @Param("id") id: string) {
    const context = requireContext(request);
    authorize(context, Permission.AssetPromote);
    return this.designs.promoteAsset(context, z.uuidv7().parse(id));
  }

  @Post("versions/:versionId/files/:fileId/read-url")
  @RequiresPermission(Permission.AssetRead)
  signFile(@Req() request: AuthenticatedRequest, @Param("versionId") versionId: string, @Param("fileId") fileId: string) {
    const context = requireContext(request);
    authorize(context, Permission.AssetRead);
    return this.designs.signVersionFile(context, z.uuidv7().parse(versionId), z.uuidv7().parse(fileId));
  }
}

function requireContext(request: AuthenticatedRequest) {
  if (!request.tenantContext) throw new Error("Tenant context is required");
  return request.tenantContext;
}
