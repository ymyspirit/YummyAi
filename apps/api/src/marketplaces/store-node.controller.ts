import { BadRequestException, Body, Controller, Get, HttpCode, Inject, Param, Post, Req } from "@nestjs/common";
import type { ZodType } from "zod";
import { Permission } from "@yummyai/authz";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import { BindStoreNodeInputSchema, CreateStoreNodeEnrollmentInputSchema, StoreNodeEnrollInputSchema, StoreNodeGenerationFenceSchema } from "@yummyai/contracts/marketplace/store-node";
import { RequiresPermission } from "../auth/permissions.decorator.js";
import { Public } from "../auth/public.decorator.js";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { StoreNodeService } from "./store-node.service.js";

@Controller("v1/marketplace-accounts/:id/nodes")
export class StoreNodeController {
  constructor(@Inject(StoreNodeService) private readonly service: StoreNodeService) {}
  @Get() @RequiresPermission(Permission.StoreRead)
  workspace(@Req() req: AuthenticatedRequest, @Param("id") id: string) { return this.service.workspace(context(req), parse(EntityIdSchema, id)); }
  @Post("enrollments") @RequiresPermission(Permission.StoreRead, Permission.StoreManage, Permission.StoreAuthorize)
  create(@Req() req: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown) { return this.service.createEnrollment(context(req), parse(EntityIdSchema, id), parse(CreateStoreNodeEnrollmentInputSchema, body)); }
  @Post(":nodeId/enrollment") @RequiresPermission(Permission.StoreRead, Permission.StoreManage, Permission.StoreAuthorize)
  reissue(@Req() req: AuthenticatedRequest, @Param("id") id: string, @Param("nodeId") nodeId: string, @Body() body: unknown) { return this.service.reissueEnrollment(context(req), parse(EntityIdSchema, id), parse(EntityIdSchema, nodeId), parse(StoreNodeGenerationFenceSchema, body)); }
  @Post("binding") @HttpCode(200) @RequiresPermission(Permission.StoreRead, Permission.StoreManage, Permission.StoreAuthorize)
  bind(@Req() req: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown) { return this.service.bind(context(req), parse(EntityIdSchema, id), parse(BindStoreNodeInputSchema, body)); }
  @Post(":nodeId/revoke") @HttpCode(200) @RequiresPermission(Permission.StoreRead, Permission.StoreManage, Permission.StoreAuthorize)
  revoke(@Req() req: AuthenticatedRequest, @Param("id") id: string, @Param("nodeId") nodeId: string, @Body() body: unknown) { return this.service.revoke(context(req), parse(EntityIdSchema, id), parse(EntityIdSchema, nodeId), parse(StoreNodeGenerationFenceSchema, body)); }
}
@Controller("v1/store-nodes")
export class StoreNodeEnrollmentController {
  constructor(@Inject(StoreNodeService) private readonly service: StoreNodeService) {}
  @Public() @Post("enroll")
  enroll(@Body() body: unknown) { return this.service.enroll(parse(StoreNodeEnrollInputSchema, body)); }
}
function context(req: AuthenticatedRequest) { if (!req.tenantContext) throw new Error("Tenant context is required"); return req.tenantContext; }

function parse<T>(schema: ZodType<T>, raw: unknown): T { const result = schema.safeParse(raw); if (!result.success) throw new BadRequestException({ code: "store_node_input_invalid" }); return result.data; }
