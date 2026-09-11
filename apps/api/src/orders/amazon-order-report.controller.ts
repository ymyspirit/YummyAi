import { Body, Controller, Get, Header, Inject, Param, Post, Query, Req, Res, StreamableFile, UnprocessableEntityException } from "@nestjs/common";
import { Permission } from "@yummyai/authz";
import { AmazonReportImportInputSchema, AmazonReportRetryInputSchema, AmazonReportReviewInputSchema } from "@yummyai/contracts";
import { z } from "zod";

import { RequiresPermission } from "../auth/permissions.decorator.js";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { AmazonOrderReportService } from "./amazon-order-report.service.js";

const QuerySchema = z.object({ accountId: z.uuidv7().optional(), batchId: z.uuidv7().optional() }).strict();
const UploadSchema = AmazonReportRetryInputSchema.extend({
  fileName: z.string().min(1).max(200),
  contentBase64: z.string().min(4).max(28 * 1024 * 1024).regex(/^[A-Za-z0-9+/]+={0,2}$/),
});

@Controller("v1/orders/reports")
export class AmazonOrderReportController {
  constructor(@Inject(AmazonOrderReportService) private readonly reports: AmazonOrderReportService) {}

  @Get("workspace")
  @Header("Cache-Control", "private, no-store")
  @RequiresPermission(Permission.OrderRead)
  workspace(@Req() request: AuthenticatedRequest, @Query() query: unknown) { return this.reports.workspace(context(request), QuerySchema.parse(query)); }

  @Post("import")
  @Header("Cache-Control", "private, no-store")
  @RequiresPermission(Permission.OrderWrite)
  importReport(@Req() request: AuthenticatedRequest, @Body() body: unknown) { return this.reports.importReport(context(request), AmazonReportImportInputSchema.parse(body)); }

  @Get("lines/:id")
  @Header("Cache-Control", "private, no-store")
  @RequiresPermission(Permission.OrderPiiRead)
  detail(@Req() request: AuthenticatedRequest, @Param("id") id: string) { return this.reports.detail(context(request), z.uuidv7().parse(id)); }

  @Post("lines/:id/process")
  @Header("Cache-Control", "private, no-store")
  @RequiresPermission(Permission.OrderWrite)
  process(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown) { return this.reports.process(context(request), z.uuidv7().parse(id), AmazonReportRetryInputSchema.parse(body).expectedVersionId); }

  @Post("lines/:id/upload")
  @Header("Cache-Control", "private, no-store")
  @RequiresPermission(Permission.OrderWrite)
  upload(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown) {
    const input = UploadSchema.parse(body);
    const bytes = Buffer.from(input.contentBase64, "base64");
    if (bytes.toString("base64") !== input.contentBase64) throw new UnprocessableEntityException("ZIP 编码无效");
    return this.reports.process(context(request), z.uuidv7().parse(id), input.expectedVersionId, bytes);
  }

  @Post("lines/:id/review")
  @Header("Cache-Control", "private, no-store")
  @RequiresPermission(Permission.OrderWrite)
  review(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown) { return this.reports.review(context(request), z.uuidv7().parse(id), AmazonReportReviewInputSchema.parse(body).expectedVersionId); }

  @Get("lines/:id/files/:key")
  @RequiresPermission(Permission.OrderPiiRead)
  async file(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Param("key") key: string, @Query("versionId") versionId: unknown,
    @Res({ passthrough: true }) response: { setHeader(name: string, value: string): void }) {
    const file = await this.reports.file(context(request), z.uuidv7().parse(id), z.string().regex(/^[A-Za-z0-9._-]{1,200}$/).parse(key), z.uuidv7().parse(versionId));
    response.setHeader("Cache-Control", "private, no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
    response.setHeader("Content-Disposition", `${file.inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(file.name).replace(/'/g, "%27")}`);
    return new StreamableFile(file.body, { type: file.inline ? "image/png" : "application/octet-stream", length: file.body.byteLength });
  }
}

function context(request: AuthenticatedRequest) { if (!request.tenantContext) throw new Error("Tenant context is required"); return request.tenantContext; }
