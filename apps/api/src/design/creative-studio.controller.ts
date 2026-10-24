import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Header, HttpCode, Inject, Post, Query, Req, Res } from "@nestjs/common";
import { erpPermissionContext, Permission } from "@yummyai/authz";
import { erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { StudioPersonalInvokeSchema } from "@yummyai/contracts/pod/studio-personal";
import { z } from "zod";
import { RequiresPermission } from "../auth/permissions.decorator.js";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { CreativeStudioPersonalService } from "./creative-studio-personal.service.js";
import { CreativeStudioService } from "./creative-studio.service.js";
import { StudioGenerationService } from "./studio-generation.service.js";

const EmptyQuery = z.object({}).strict();
type StudioResponse = { setHeader(name: string, value: string): void };

@Controller("v1/creative-studio")
export class CreativeStudioController {
  constructor(@Inject(CreativeStudioService) private readonly studio: CreativeStudioService,
    @Inject(StudioGenerationService) private readonly generation: StudioGenerationService,
    @Inject(CreativeStudioPersonalService) private readonly personal: CreativeStudioPersonalService) {}
  @Get("workspace")
  @HttpCode(200)
  @Header("Cache-Control", "private, no-store")
  @RequiresPermission(Permission.DesignRead, Permission.AssetRead)
  async workspace(@Req() request: AuthenticatedRequest, @Query() query: unknown,
    @Res({ passthrough: true }) response: StudioResponse) {
    const context = this.personalContext(request);
    const result = await this.personal.workspace(context, query);
    this.replyAuthority(request, result.contextAuthority, response);
    return result;
  }
  @Post("invoke")
  @HttpCode(200)
  @Header("Cache-Control", "private, no-store")
  @RequiresPermission(Permission.DesignRead, Permission.AssetRead)
  async invokePersonal(@Req() request: AuthenticatedRequest, @Body() body: unknown, @Query() query: unknown,
    @Res({ passthrough: true }) response: StudioResponse) {
    const context = this.personalContext(request);
    if (!EmptyQuery.safeParse(query).success) throw new BadRequestException({ code: "studio_personal_input_invalid" });
    const parsed = StudioPersonalInvokeSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException({ code: "studio_personal_input_invalid" });
    const expected = request.headers["x-yummyai-context-authority"];
    if (expected !== undefined && expected !== parsed.data.contextAuthority) throw new ConflictException({ code: "authority_changed" });
    const result = await this.personal.invoke(context, parsed.data);
    this.replyAuthority(request, result.contextAuthority, response);
    return result;
  }
  @Post("rpc")
  @RequiresPermission(Permission.DesignRead)
  invoke(@Req() request: AuthenticatedRequest, @Body() body: unknown) { return this.studio.invoke(request.tenantContext!, body); }
  @Post("models")
  @RequiresPermission(Permission.ModelConfigure)
  addModel(@Req() request: AuthenticatedRequest, @Body() body: unknown) { return this.generation.addModel(request.tenantContext!, body); }

  private personalContext(request: AuthenticatedRequest) {
    if (request.authenticationKind !== "oidc" || !request.tenantContext)
      throw new ForbiddenException({ code: "studio_personal_session_required", message: "需要有效的本人会员会话" });
    const expected = request.headers["x-yummyai-context-authority"];
    if (expected !== undefined && (typeof expected !== "string" || expected !== erpSessionAuthority(erpPermissionContext(request.tenantContext))))
      throw new ConflictException({ code: "authority_changed" });
    return request.tenantContext;
  }

  private replyAuthority(request: AuthenticatedRequest, authority: string, response: StudioResponse) {
    const expected = request.headers["x-yummyai-context-authority"];
    if (expected !== undefined && expected !== authority) throw new ConflictException({ code: "authority_changed" });
    response.setHeader("x-yummyai-context-authority", authority);
  }
}
