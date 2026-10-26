import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Header, HttpCode, Inject, Param, Post, Query, Req, Res, StreamableFile } from "@nestjs/common";
import { erpPermissionContext, Permission } from "@yummyai/authz";
import { erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { CREATIVE_RESPONSE_ADOPTION_ARTIFACT_HEADER, CREATIVE_RESPONSE_ADOPTION_BASIS_HEADER, CREATIVE_RESPONSE_ADOPTION_CHECKSUM_HEADER } from "@yummyai/contracts/harness/creative-response-adoption";
import { z } from "zod";
import { RequiresPermission } from "../auth/permissions.decorator.js";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { CreativeResponseAdoptionService } from "./creative-response-adoption.service.js";

type Reply = { setHeader(name: string, value: string): void };
const Id = z.uuidv7(), RequestId = z.uuid(), Empty = z.object({}).strict();

@Controller("v1/creative-executions")
export class CreativeResponseAdoptionController {
  constructor(@Inject(CreativeResponseAdoptionService) private readonly service: CreativeResponseAdoptionService) {}

  private context(request: AuthenticatedRequest, response: Reply) {
    if (request.authenticationKind !== "oidc" || !request.tenantContext)
      throw new ForbiddenException({ code: "creative_adoption_personal_session_required" });
    const authority = erpSessionAuthority(erpPermissionContext(request.tenantContext));
    if (request.headers["x-yummyai-context-authority"] !== authority)
      throw new ConflictException({ code: "authority_changed" });
    response.setHeader("x-yummyai-context-authority", authority);
    return request.tenantContext;
  }
  private empty(raw: unknown) {
    if (!Empty.safeParse(raw).success) throw new BadRequestException({ code: "creative_adoption_input_invalid" });
  }

  @Get(":id/response-adoption")
  @HttpCode(200)
  @Header("Cache-Control", "private, no-store")
  @RequiresPermission(Permission.DesignRead, Permission.AssetRead)
  workspace(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Query() query: unknown, @Res({ passthrough: true }) response: Reply) {
    this.empty(query); return this.service.workspace(this.context(request, response), Id.parse(id));
  }

  @Get(":id/response-adoption/preview")
  @HttpCode(200)
  @Header("Cache-Control", "private, no-store")
  @RequiresPermission(Permission.DesignRead, Permission.AssetRead)
  async preview(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Query() query: unknown, @Res({ passthrough: true }) response: Reply) {
    const parsed = z.object({ basis: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(query);
    const value = await this.service.preview(this.context(request, response), Id.parse(id), parsed.basis);
    response.setHeader(CREATIVE_RESPONSE_ADOPTION_BASIS_HEADER, value.basis);
    response.setHeader(CREATIVE_RESPONSE_ADOPTION_CHECKSUM_HEADER, value.responseChecksum);
    response.setHeader(CREATIVE_RESPONSE_ADOPTION_ARTIFACT_HEADER, value.artifactChecksum);
    response.setHeader("X-Content-Type-Options", "nosniff");
    return new StreamableFile(Buffer.from(value.bytes), { type: value.mediaType, length: value.bytes.byteLength });
  }

  @Post(":id/response-adoptions")
  @HttpCode(200)
  @Header("Cache-Control", "private, no-store")
  @RequiresPermission(Permission.DesignRead, Permission.AssetRead)
  adopt(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Query() query: unknown, @Body() body: unknown, @Res({ passthrough: true }) response: Reply) {
    this.empty(query); return this.service.adopt(this.context(request, response), Id.parse(id), body);
  }

  @Get(":id/response-adoptions/by-request/:requestId")
  @HttpCode(200)
  @Header("Cache-Control", "private, no-store")
  @RequiresPermission(Permission.DesignRead, Permission.AssetRead)
  lookup(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Param("requestId") requestId: string,
    @Query() query: unknown, @Res({ passthrough: true }) response: Reply) {
    this.empty(query); return this.service.lookup(this.context(request, response), Id.parse(id), RequestId.parse(requestId));
  }

  @Post(":id/response-adoptions/:adoptionId/cancel")
  @HttpCode(200)
  @Header("Cache-Control", "private, no-store")
  @RequiresPermission(Permission.DesignRead, Permission.AssetRead)
  cancel(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Param("adoptionId") adoptionId: string,
    @Query() query: unknown, @Body() body: unknown, @Res({ passthrough: true }) response: Reply) {
    this.empty(query); return this.service.cancel(this.context(request, response), Id.parse(id), Id.parse(adoptionId), body);
  }
}
