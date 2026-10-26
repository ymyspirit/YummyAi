import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Header, HttpCode, Inject, Param, Post, Query, Req, Res } from "@nestjs/common";
import { erpPermissionContext, Permission } from "@yummyai/authz";
import { EntityIdSchema } from "@yummyai/contracts";
import { erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { z } from "zod";
import { RequiresPermission } from "../auth/permissions.decorator.js";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { ProductVisualsService } from "./product-visuals.service.js";

type Reply = { setHeader(name: string, value: string): void };

@Controller("v1/sales-plans/:id/launch/visuals")
export class ProductVisualsController {
  constructor(@Inject(ProductVisualsService) private readonly visuals: ProductVisualsService) {}
  private personal(request: AuthenticatedRequest, response: Reply) {
    if (request.authenticationKind !== "oidc" || !request.tenantContext)
      throw new ForbiddenException({ code: "studio_personal_session_required" });
    const authority = erpSessionAuthority(erpPermissionContext(request.tenantContext));
    if (request.headers["x-yummyai-context-authority"] !== authority) throw new ConflictException({ code: "authority_changed" });
    response.setHeader("x-yummyai-context-authority", authority);
    response.setHeader("Cache-Control", "private, no-store");
    return request.tenantContext;
  }
  private empty(query: unknown) {
    if (!z.object({}).strict().safeParse(query).success) throw new BadRequestException({ code: "studio_paid_image_invalid" });
  }
  @Get()
  @RequiresPermission(Permission.ProductRead)
  get(@Req() req: AuthenticatedRequest, @Param("id") id: string) {
    return this.visuals.get(context(req), EntityIdSchema.parse(id));
  }
  @Post("prepare")
  @RequiresPermission(Permission.DesignWrite)
  prepare(@Req() req: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown) {
    return this.visuals.prepare(context(req), EntityIdSchema.parse(id), body);
  }
  @Post(":groupId/generate")
  @RequiresPermission(Permission.DesignWrite)
  generate(
    @Req() req: AuthenticatedRequest,
    @Param("id") id: string,
    @Param("groupId") groupId: string,
    @Body() body: unknown,
  ) {
    return this.visuals.generate(
      context(req),
      EntityIdSchema.parse(id),
      z.uuid().parse(groupId),
      body,
    );
  }
  @Post(":groupId/images/prepare")
  @HttpCode(200)
  @Header("Cache-Control", "private, no-store")
  @RequiresPermission(Permission.DesignWrite)
  prepareImage(@Req() req: AuthenticatedRequest, @Param("id") id: string, @Param("groupId") groupId: string,
    @Query() query: unknown, @Body() body: unknown, @Res({ passthrough: true }) response: Reply) {
    this.empty(query);
    return this.visuals.prepareImage(this.personal(req, response), EntityIdSchema.parse(id), z.uuid().parse(groupId), body);
  }
  @Post(":groupId/images/commit")
  @HttpCode(200)
  @Header("Cache-Control", "private, no-store")
  @RequiresPermission(Permission.DesignWrite)
  commitImage(@Req() req: AuthenticatedRequest, @Param("id") id: string, @Param("groupId") groupId: string,
    @Query() query: unknown, @Body() body: unknown, @Res({ passthrough: true }) response: Reply) {
    this.empty(query);
    return this.visuals.commitImage(this.personal(req, response), EntityIdSchema.parse(id), z.uuid().parse(groupId), body);
  }
  @Get(":groupId/images/by-request/:requestId")
  @HttpCode(200)
  @Header("Cache-Control", "private, no-store")
  @RequiresPermission(Permission.DesignRead)
  lookupImage(@Req() req: AuthenticatedRequest, @Param("id") id: string, @Param("groupId") groupId: string,
    @Param("requestId") requestId: string, @Query() query: unknown, @Res({ passthrough: true }) response: Reply) {
    return this.visuals.lookupImage(this.personal(req, response), EntityIdSchema.parse(id), z.uuid().parse(groupId), z.uuid().parse(requestId), query);
  }
  @Get(":groupId/images")
  @HttpCode(200)
  @Header("Cache-Control", "private, no-store")
  @RequiresPermission(Permission.DesignRead)
  imageRequests(@Req() req: AuthenticatedRequest, @Param("id") id: string, @Param("groupId") groupId: string,
    @Query() query: unknown, @Res({ passthrough: true }) response: Reply) {
    return this.visuals.imageRequests(this.personal(req, response), EntityIdSchema.parse(id), z.uuid().parse(groupId), query);
  }
  @Post(":groupId/images/cancel")
  @HttpCode(200)
  @Header("Cache-Control", "private, no-store")
  @RequiresPermission(Permission.DesignWrite)
  cancelImage(@Req() req: AuthenticatedRequest, @Param("id") id: string, @Param("groupId") groupId: string,
    @Query() query: unknown, @Body() body: unknown, @Res({ passthrough: true }) response: Reply) {
    this.empty(query);
    return this.visuals.cancelImage(this.personal(req, response), EntityIdSchema.parse(id), z.uuid().parse(groupId), body);
  }
  @Post(":groupId/images/abandon")
  @HttpCode(200)
  @Header("Cache-Control", "private, no-store")
  @RequiresPermission(Permission.DesignWrite)
  abandonImage(@Req() req: AuthenticatedRequest, @Param("id") id: string, @Param("groupId") groupId: string,
    @Query() query: unknown, @Body() body: unknown, @Res({ passthrough: true }) response: Reply) {
    this.empty(query);
    return this.visuals.abandonImage(this.personal(req, response), EntityIdSchema.parse(id), z.uuid().parse(groupId), body);
  }
  @Post(":groupId/prepare-original")
  @HttpCode(200)
  @Header("Cache-Control", "private, no-store")
  @RequiresPermission(Permission.DesignRead)
  prepareImageOriginal(@Req() req: AuthenticatedRequest, @Param("id") id: string, @Param("groupId") groupId: string,
    @Query() query: unknown, @Body() body: unknown, @Res({ passthrough: true }) response: Reply) {
    this.empty(query);
    return this.visuals.prepareImageOriginal(this.personal(req, response), EntityIdSchema.parse(id), z.uuid().parse(groupId), body);
  }
  @Post(":groupId/collect")
  @RequiresPermission(Permission.DesignWrite)
  collect(
    @Req() req: AuthenticatedRequest,
    @Param("id") id: string,
    @Param("groupId") groupId: string,
  ) {
    return this.visuals.collect(context(req), EntityIdSchema.parse(id), z.uuid().parse(groupId));
  }
  @Post(":groupId/review")
  @RequiresPermission(Permission.DesignReview)
  review(
    @Req() req: AuthenticatedRequest,
    @Param("id") id: string,
    @Param("groupId") groupId: string,
    @Body() body: unknown,
  ) {
    return this.visuals.review(
      context(req),
      EntityIdSchema.parse(id),
      z.uuid().parse(groupId),
      body,
    );
  }
  @Post(":groupId/adopt")
  @RequiresPermission(Permission.ProductWrite)
  adopt(
    @Req() req: AuthenticatedRequest,
    @Param("id") id: string,
    @Param("groupId") groupId: string,
    @Body() body: unknown,
  ) {
    return this.visuals.adopt(
      context(req),
      EntityIdSchema.parse(id),
      z.uuid().parse(groupId),
      body,
    );
  }
}
function context(req: AuthenticatedRequest) {
  if (!req.tenantContext) throw new Error("Tenant context is required");
  return req.tenantContext;
}
