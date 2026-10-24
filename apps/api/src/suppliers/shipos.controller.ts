import { Body, Controller, Get, Header, Inject, Param, Post, Req, Res, StreamableFile } from "@nestjs/common";
import { Permission } from "@yummyai/authz";
import { z } from "zod";
import { RequiresPermission } from "../auth/permissions.decorator.js";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { ShiposService } from "./shipos.service.js";

@Controller("v1/sourcing/suppliers/:supplier/shipos")
export class ShiposController {
  constructor(@Inject(ShiposService) private readonly shipos: ShiposService) {}
  @Get() @Header("Cache-Control", "private, no-store") @RequiresPermission(Permission.OrderRead)
  workspace(@Req() request: AuthenticatedRequest, @Param("supplier") supplier: string) { return this.shipos.workspace(context(request), z.uuidv7().parse(supplier)); }
  @Post("connection") @Header("Cache-Control", "private, no-store") @RequiresPermission(Permission.IntegrationManage)
  save(@Req() request: AuthenticatedRequest, @Param("supplier") supplier: string, @Body() body: unknown) { return this.shipos.save(context(request), z.uuidv7().parse(supplier), body); }
  @Post("test") @Header("Cache-Control", "private, no-store") @RequiresPermission(Permission.IntegrationManage)
  test(@Req() request: AuthenticatedRequest, @Param("supplier") supplier: string, @Body() body: unknown) { return this.shipos.test(context(request), z.uuidv7().parse(supplier), body); }
  @Post("sync") @Header("Cache-Control", "private, no-store") @RequiresPermission(Permission.IntegrationManage)
  sync(@Req() request: AuthenticatedRequest, @Param("supplier") supplier: string, @Body() body: unknown) { return this.shipos.sync(context(request), z.uuidv7().parse(supplier), body); }
  @Get("records/:record/label") @RequiresPermission(Permission.OrderPiiRead)
  async label(@Req() request: AuthenticatedRequest, @Param("supplier") supplier: string, @Param("record") record: string, @Res({ passthrough: true }) response: { setHeader(name: string, value: string): void }) {
    const bytes = await this.shipos.label(context(request), z.uuidv7().parse(supplier), z.uuidv7().parse(record));
    for (const [name, value] of Object.entries({ "Content-Disposition": `attachment; filename="shipos-${record}.pdf"`, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox", "Referrer-Policy": "no-referrer" })) response.setHeader(name, value);
    return new StreamableFile(bytes, { type: "application/pdf", length: bytes.byteLength });
  }
}
function context(request: AuthenticatedRequest) { if (!request.tenantContext) throw new Error("Tenant context is required"); return request.tenantContext; }
