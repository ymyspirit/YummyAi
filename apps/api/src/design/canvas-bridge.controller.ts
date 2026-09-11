import { BadRequestException, Body, Controller, Get, Header, Inject, Param, Post, Req, StreamableFile } from "@nestjs/common";
import { Permission } from "@yummyai/authz";
import { z } from "zod";
import { RequiresPermission } from "../auth/permissions.decorator.js";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { CanvasBridgeService } from "./canvas-bridge.service.js";
import { CanvasWorkflowService } from "./canvas-workflow.service.js";

const Id = { parse(value: string) { const result = z.uuidv7().safeParse(value); if (!result.success) throw new BadRequestException("需求或素材编号无效"); return result.data; } };
@Controller("v1/canvas-bridge")
export class CanvasBridgeController {
  constructor(@Inject(CanvasBridgeService) private readonly bridge: CanvasBridgeService, @Inject(CanvasWorkflowService) private readonly workflow: CanvasWorkflowService) {}
  @Get("briefs") @Header("Cache-Control", "private, no-store") @RequiresPermission(Permission.DesignRead)
  list(@Req() req: AuthenticatedRequest) { return this.bridge.list(context(req)); }
  @Get("options") @Header("Cache-Control", "private, no-store") @RequiresPermission(Permission.DesignRead, Permission.AssetRead)
  options(@Req() req: AuthenticatedRequest) { return this.bridge.options(context(req)); }
  @Post("briefs") @Header("Cache-Control", "private, no-store") @RequiresPermission(Permission.DesignRead, Permission.DesignWrite, Permission.AssetRead)
  create(@Req() req: AuthenticatedRequest, @Body() body: unknown) { return this.bridge.create(context(req), body); }
  @Get("briefs/:id") @Header("Cache-Control", "private, no-store") @RequiresPermission(Permission.DesignRead, Permission.AssetRead)
  get(@Req() req: AuthenticatedRequest, @Param("id") id: string) { return this.bridge.get(context(req), Id.parse(id)); }
  @Get("briefs/:id/assets/:assetId") @Header("Cache-Control", "private, no-store") @RequiresPermission(Permission.DesignRead, Permission.AssetRead)
  asset(@Req() req: AuthenticatedRequest, @Param("id") id: string, @Param("assetId") assetId: string) { return this.bridge.readReference(context(req), Id.parse(id), Id.parse(assetId)); }
  @Post("briefs/:id/results") @Header("Cache-Control", "private, no-store") @RequiresPermission(Permission.DesignWrite, Permission.AssetWrite, Permission.AssetRead)
  submit(@Req() req: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown) { return this.bridge.submit(context(req), Id.parse(id), body); }
  @Get("production-templates") @Header("Cache-Control", "private, no-store") @RequiresPermission(Permission.DesignRead)
  templates(@Req() req: AuthenticatedRequest) { return this.workflow.templates(context(req)); }
  @Get("briefs/:id/results") @Header("Cache-Control", "private, no-store") @RequiresPermission(Permission.DesignRead, Permission.AssetRead)
  results(@Req() req: AuthenticatedRequest, @Param("id") id: string) { return this.workflow.results(context(req), Id.parse(id)); }
  @Get("briefs/:id/results/:versionId/preview") @Header("Cache-Control", "private, no-store") @Header("X-Content-Type-Options", "nosniff") @RequiresPermission(Permission.DesignRead, Permission.AssetRead)
  async preview(@Req() req: AuthenticatedRequest, @Param("id") id: string, @Param("versionId") versionId: string) {
    return new StreamableFile(await this.workflow.preview(context(req), Id.parse(id), Id.parse(versionId)), { type: "image/webp", disposition: "inline" });
  }
  @Post("briefs/:id/review") @Header("Cache-Control", "private, no-store") @RequiresPermission(Permission.DesignRead, Permission.DesignReview, Permission.AssetRead)
  review(@Req() req: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown) { return this.workflow.review(context(req), Id.parse(id), body); }
  @Post("briefs/:id/continue") @Header("Cache-Control", "private, no-store") @RequiresPermission(Permission.DesignRead, Permission.DesignWrite, Permission.AssetRead)
  continue(@Req() req: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown) { return this.bridge.continueWorkflow(context(req), Id.parse(id), body); }
  @Post("briefs/:id/production") @Header("Cache-Control", "private, no-store") @RequiresPermission(Permission.DesignRead, Permission.DesignWrite, Permission.AssetRead)
  production(@Req() req: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown) { return this.workflow.handoff(context(req), Id.parse(id), body); }
}
function context(req: AuthenticatedRequest) { if (!req.tenantContext) throw new Error("Tenant context required"); return req.tenantContext; }
