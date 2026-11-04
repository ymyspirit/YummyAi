import { Body, Controller, Get, Header, Inject, Param, Post, Query, Req, Res, StreamableFile } from "@nestjs/common";
import { Permission } from "@yummyai/authz";
import { z } from "zod";
import { RequiresPermission } from "../auth/permissions.decorator.js";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { LogisticsDocumentsService } from "./logistics-documents.service.js";
import { LogisticsDocumentLabelsService } from "./logistics-document-labels.service.js";

@Controller("v1/logistics/documents")
export class LogisticsDocumentsController {
  constructor(@Inject(LogisticsDocumentsService) private readonly documents: LogisticsDocumentsService,
    @Inject(LogisticsDocumentLabelsService) private readonly labels: LogisticsDocumentLabelsService) {}
  @Get("options") @Header("Cache-Control", "private, no-store") @RequiresPermission(Permission.OrderRead, Permission.OrderPiiRead)
  options(@Req() req: AuthenticatedRequest, @Query() query: unknown) { return this.documents.options(context(req), query); }
  @Post("profiles") @RequiresPermission(Permission.OrderRead, Permission.OrderPiiRead, Permission.IntegrationManage)
  save(@Req() req: AuthenticatedRequest, @Body() body: unknown) { return this.documents.saveProfile(context(req), body); }
  @Post("preview") @Header("Cache-Control", "private, no-store") @RequiresPermission(Permission.OrderRead, Permission.OrderPiiRead)
  preview(@Req() req: AuthenticatedRequest, @Body() body: unknown) { return this.documents.preview(context(req), body); }
  @Post("generate") @RequiresPermission(Permission.OrderRead, Permission.OrderWrite, Permission.OrderPiiRead)
  generate(@Req() req: AuthenticatedRequest, @Body() body: unknown) { return this.documents.generate(context(req), body); }
  @Get("exports") @Header("Cache-Control", "private, no-store") @RequiresPermission(Permission.OrderRead, Permission.OrderPiiRead)
  history(@Req() req: AuthenticatedRequest, @Query() query: unknown) { return this.documents.history(context(req), query); }
  @Get("exports/:id/label-basis") @Header("Cache-Control", "private, no-store") @RequiresPermission(Permission.OrderRead, Permission.OrderPiiRead)
  basis(@Req() req: AuthenticatedRequest, @Param("id") id: string, @Query() raw: unknown) {
    const query = z.object({ orderId: z.uuidv7() }).strict().parse(raw);
    return this.labels.basis(context(req), z.uuidv7().parse(id), query.orderId);
  }
  @Get("labels") @Header("Cache-Control", "private, no-store") @RequiresPermission(Permission.OrderRead, Permission.OrderPiiRead)
  listLabels(@Req() req: AuthenticatedRequest, @Query() raw: unknown) { return this.labels.list(context(req), raw); }
  @Post("labels") @RequiresPermission(Permission.OrderRead, Permission.OrderWrite, Permission.OrderPiiRead)
  register(@Req() req: AuthenticatedRequest, @Body() raw: unknown) { return this.labels.register(context(req), raw); }
  @Get("labels/:id/file") @RequiresPermission(Permission.OrderRead, Permission.OrderPiiRead)
  async labelFile(@Req() req: AuthenticatedRequest, @Param("id") id: string, @Res({ passthrough: true }) response: FileResponse) {
    return stream(await this.labels.download(context(req), z.uuidv7().parse(id)), response);
  }
  @Post("labels/:id/handoff") @RequiresPermission(Permission.OrderRead, Permission.OrderPiiRead, Permission.DesignRead, Permission.AssetRead)
  async handoff(@Req() req: AuthenticatedRequest, @Param("id") id: string, @Body() raw: unknown, @Res({ passthrough: true }) response: FileResponse) {
    const body = z.object({ deliveryPackageIds: z.array(z.uuidv7()).min(1).max(20) }).strict().parse(raw);
    return stream(await this.labels.handoff(context(req), { ...body, labelId: z.uuidv7().parse(id) }), response);
  }
  @Get("exports/:id/file") @RequiresPermission(Permission.OrderRead, Permission.OrderPiiRead)
  async download(@Req() req: AuthenticatedRequest, @Param("id") id: string, @Res({ passthrough: true }) response: { setHeader(name: string, value: string): void }) {
    const result = await this.documents.download(context(req), z.uuidv7().parse(id));
    for (const [name, value] of Object.entries({ "Cache-Control": "private, no-store", "Content-Disposition": `attachment; filename="${result.name}"`,
      "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox", "Referrer-Policy": "no-referrer" })) response.setHeader(name, value);
    return new StreamableFile(result.body, { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", length: result.body.byteLength });
  }
}
function context(req: AuthenticatedRequest) { if (!req.tenantContext) throw new Error("Tenant context required"); return req.tenantContext; }
type FileResponse = { setHeader(name: string, value: string): void };
function stream(file: { body: Buffer; name: string; mediaType: string }, response: FileResponse) {
  for (const [name, value] of Object.entries({ "Cache-Control": "private, no-store", "Content-Disposition": `attachment; filename="${file.name}"`,
    "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox", "Referrer-Policy": "no-referrer" })) response.setHeader(name, value);
  return new StreamableFile(file.body, { type: file.mediaType, length: file.body.byteLength });
}
