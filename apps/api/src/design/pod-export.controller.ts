import { Body, Controller, Get, Inject, Param, Post, Req } from "@nestjs/common";
import { Permission, authorize } from "@yummyai/authz";
import { CreatePodExportInputSchema } from "@yummyai/contracts";
import { z } from "zod";

import { RequiresPermission } from "../auth/permissions.decorator.js";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { PodExportService } from "./pod-export.service.js";

@Controller("v1/pod")
export class PodExportController {
  constructor(@Inject(PodExportService) private readonly exports: PodExportService) {}

  @Post("tasks/:taskId/exports")
  @RequiresPermission(Permission.DesignReview)
  requestExport(@Req() request: AuthenticatedRequest, @Param("taskId") taskId: string, @Body() body: unknown) {
    const context = requireContext(request);
    authorize(context, Permission.DesignReview);
    return this.exports.request(context, z.uuidv7().parse(taskId), CreatePodExportInputSchema.parse(body));
  }

  @Get("tasks/:taskId/exports")
  @RequiresPermission(Permission.DesignRead)
  listExports(@Req() request: AuthenticatedRequest, @Param("taskId") taskId: string) {
    const context = requireContext(request);
    authorize(context, Permission.DesignRead);
    return this.exports.listForTask(context, z.uuidv7().parse(taskId));
  }

  @Get("exports/:id")
  @RequiresPermission(Permission.DesignRead)
  getExport(@Req() request: AuthenticatedRequest, @Param("id") id: string) {
    const context = requireContext(request);
    authorize(context, Permission.DesignRead);
    return this.exports.get(context, z.uuidv7().parse(id));
  }

  @Post("exports/:id/read-url")
  @RequiresPermission(Permission.AssetRead)
  signDownload(@Req() request: AuthenticatedRequest, @Param("id") id: string) {
    const context = requireContext(request);
    authorize(context, Permission.AssetRead);
    return this.exports.signDownload(context, z.uuidv7().parse(id));
  }
}

function requireContext(request: AuthenticatedRequest) {
  if (!request.tenantContext) throw new Error("Tenant context is required");
  return request.tenantContext;
}
