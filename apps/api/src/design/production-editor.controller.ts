import { Body, Controller, Delete, Get, Header, Inject, Param, Post, Query, Req, Res, StreamableFile, UnprocessableEntityException } from "@nestjs/common";
import { Permission } from "@yummyai/authz";
import { ReviewProductionEditorVersionInputSchema } from "@yummyai/contracts";
import { z } from "zod";
import { RequiresPermission } from "../auth/permissions.decorator.js";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { ProductionEditorService } from "./production-editor.service.js";

const Id = z.uuidv7();
const Upload = z.object({ name: z.string().min(1).max(200), contentBase64: z.string().min(4).max(90 * 1024 * 1024).regex(/^[A-Za-z0-9+/]+={0,2}$/) }).strict();
type ResponseHeaders = { setHeader(name: string, value: string): void };

@Controller("v1/production-editor/projects")
export class ProductionEditorController {
  constructor(@Inject(ProductionEditorService) private readonly editor: ProductionEditorService) {}
  @Get() @Header("Cache-Control", "private, no-store") @RequiresPermission(Permission.DesignRead)
  list(@Req() request: AuthenticatedRequest) { return this.editor.list(context(request)); }
  @Post() @Header("Cache-Control", "private, no-store") @RequiresPermission(Permission.DesignWrite)
  create(@Req() request: AuthenticatedRequest, @Body() body: unknown) { return this.editor.create(context(request), body); }
  @Get(":id") @Header("Cache-Control", "private, no-store") @RequiresPermission(Permission.DesignRead)
  get(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Query("versionId") versionId?: string) { return this.editor.get(context(request), Id.parse(id), Id.optional().parse(versionId)); }
  @Delete(":id") @Header("Cache-Control", "private, no-store") @RequiresPermission(Permission.DesignWrite)
  remove(@Req() request: AuthenticatedRequest, @Param("id") id: string) { return this.editor.remove(context(request), Id.parse(id)); }
  @Post(":id/versions") @Header("Cache-Control", "private, no-store") @RequiresPermission(Permission.DesignWrite)
  save(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown) { return this.editor.save(context(request), Id.parse(id), body); }
  @Post(":id/review") @Header("Cache-Control", "private, no-store") @RequiresPermission(Permission.DesignReview)
  review(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown) { return this.editor.review(context(request), Id.parse(id), ReviewProductionEditorVersionInputSchema.parse(body).expectedVersionId); }
  @Get(":id/images") @Header("Cache-Control", "private, no-store") @RequiresPermission(Permission.DesignRead)
  async images(@Req() request: AuthenticatedRequest, @Param("id") id: string) { return { images: (await this.editor.get(context(request), Id.parse(id))).images }; }
  @Get(":id/fonts") @Header("Cache-Control", "private, no-store") @RequiresPermission(Permission.DesignRead)
  async fonts(@Req() request: AuthenticatedRequest, @Param("id") id: string) { return { fonts: (await this.editor.get(context(request), Id.parse(id))).fonts }; }
  @Get(":id/images/:imageId/cutout") @Header("Cache-Control", "private, no-store") @RequiresPermission(Permission.DesignRead, Permission.AssetRead)
  cutout(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Param("imageId") imageId: string) { return this.editor.cutoutEditor(context(request), Id.parse(id), Id.parse(imageId)); }
  @Post(":id/images/:imageId/segment") @Header("Cache-Control", "private, no-store") @RequiresPermission(Permission.DesignWrite, Permission.AssetRead)
  segment(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Param("imageId") imageId: string, @Body() body: unknown) { return this.editor.segmentImage(context(request), Id.parse(id), Id.parse(imageId), body); }
  @Post(":id/images/:imageId/cutout") @Header("Cache-Control", "private, no-store") @RequiresPermission(Permission.DesignWrite, Permission.AssetRead)
  applyCutout(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Param("imageId") imageId: string, @Body() body: unknown) { return this.editor.applyCutout(context(request), Id.parse(id), Id.parse(imageId), body); }
  @Post(":id/images/:imageId/refine") @Header("Cache-Control", "private, no-store") @RequiresPermission(Permission.DesignWrite, Permission.AssetRead)
  refine(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Param("imageId") imageId: string, @Body() body: unknown) { return this.editor.refineImage(context(request), Id.parse(id), Id.parse(imageId), body); }
  @Post(":id/images") @Header("Cache-Control", "private, no-store") @RequiresPermission(Permission.DesignWrite)
  imageUpload(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown) { const input = decodeUpload(body); return this.editor.upload(context(request), Id.parse(id), input.name, input.bytes, "image"); }
  @Post(":id/fonts") @Header("Cache-Control", "private, no-store") @RequiresPermission(Permission.DesignWrite)
  fontUpload(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown) { const input = decodeUpload(body); return this.editor.upload(context(request), Id.parse(id), input.name, input.bytes, "font"); }
  @Get(":id/images/:imageId") @RequiresPermission(Permission.DesignRead, Permission.AssetRead)
  async image(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Param("imageId") imageId: string, @Query("kind") kind: unknown, @Res({ passthrough: true }) response: ResponseHeaders) { return sendFile(response, await this.editor.image(context(request), Id.parse(id), Id.parse(imageId), z.enum(["preview", "original"]).default("preview").parse(kind))); }
  @Get(":id/fonts/:fontId") @RequiresPermission(Permission.DesignRead, Permission.AssetRead)
  async font(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Param("fontId") fontId: string, @Res({ passthrough: true }) response: ResponseHeaders) { return sendFile(response, await this.editor.font(context(request), Id.parse(id), z.union([z.literal("geist_regular"), Id]).parse(fontId))); }
  @Post(":id/preflight") @Header("Cache-Control", "private, no-store") @RequiresPermission(Permission.DesignRead)
  preflight(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown) { return this.editor.preflight(context(request), Id.parse(id), body); }
  @Post(":id/renders") @Header("Cache-Control", "private, no-store") @RequiresPermission(Permission.DesignWrite)
  render(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown) { return this.editor.render(context(request), Id.parse(id), body); }
  @Get(":id/renders/:renderId") @Header("Cache-Control", "private, no-store") @RequiresPermission(Permission.DesignRead)
  getRender(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Param("renderId") renderId: string) { return this.editor.getRender(context(request), Id.parse(id), Id.parse(renderId)); }
  @Get(":id/renders/:renderId/files/:key") @RequiresPermission(Permission.DesignRead, Permission.AssetRead)
  async file(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Param("renderId") renderId: string, @Param("key") key: string, @Res({ passthrough: true }) response: ResponseHeaders) { return sendFile(response, await this.editor.renderFile(context(request), Id.parse(id), Id.parse(renderId), z.string().regex(/^[a-zA-Z0-9_.-]{1,100}$/).parse(key))); }
}
function context(request: AuthenticatedRequest) { if (!request.tenantContext) throw new Error("Tenant context required"); return request.tenantContext; }
function decodeUpload(body: unknown) { const input = Upload.parse(body), bytes = Buffer.from(input.contentBase64, "base64"); if (bytes.toString("base64") !== input.contentBase64) throw new UnprocessableEntityException("文件编码无效"); return { name: input.name, bytes }; }
function sendFile(response: ResponseHeaders, file: { body: Uint8Array; name: string; mediaType: string; inline: boolean }) {
  response.setHeader("Cache-Control", "private, no-store"); response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
  response.setHeader("Content-Disposition", `${file.inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(file.name).replace(/'/g, "%27")}`);
  return new StreamableFile(file.body, { type: file.mediaType, length: file.body.byteLength });
}
