import {
  Body,
  Controller,
  Get,
  Header,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
  StreamableFile,
} from "@nestjs/common";
import { z } from "zod";
import { AssistKindSchema } from "@yummyai/contracts/ai/assist";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { AssistService } from "./assist.service.js";

@Controller("v1/ai-assists")
export class AssistController {
  constructor(@Inject(AssistService) private readonly service: AssistService) {}
  @Get("models") models(@Req() r: AuthenticatedRequest) {
    return this.service.models(r.tenantContext!);
  }
  @Post("models") addModel(@Req() r: AuthenticatedRequest, @Body() body: unknown) {
    return this.service.addModel(r.tenantContext!, body);
  }
  @Post("runs")
  @Header("Cache-Control", "private, no-store")
  async create(@Req() r: AuthenticatedRequest, @Body() body: unknown, @Res({ passthrough: true }) response: { setHeader(name: string, value: string): void }) {
    const view = await this.service.create(r.tenantContext!, body);
    const reuse = this.service.automaticAuditReuseProof(body, view);
    if (reuse) response.setHeader("x-yummyai-assist-reuse-proof", JSON.stringify(reuse));
    return view;
  }
  @Post("basis")
  @Header("Cache-Control", "private, no-store")
  basis(@Req() r: AuthenticatedRequest, @Body() body: unknown) {
    return this.service.previewBusiness(r.tenantContext!, body);
  }
  @Get("runs")
  @Header("Cache-Control", "private, no-store")
  list(@Req() r: AuthenticatedRequest, @Query() raw: unknown) {
    const query = z
      .object({
        kind: AssistKindSchema,
        automaticAudit: z.literal("1").optional(),
        scope: z.string().regex(/^(?:(creative|order|template|listing|finance|case|knowledge):[0-9a-f-]{36}|procurement:[0-9a-f-]{36}:[0-9a-f-]{36})$/i),
      })
      .strict()
      .parse(raw);
    return this.service.list(r.tenantContext!, query.kind, query.scope, query.automaticAudit === "1");
  }
  @Get("receipts")
  @Header("Cache-Control", "private, no-store")
  receipt(@Req() r: AuthenticatedRequest, @Query() raw: unknown) {
    return this.service.receipt(r.tenantContext!, raw);
  }
  @Get("runs/:id")
  @Header("Cache-Control", "private, no-store")
  get(@Req() r: AuthenticatedRequest, @Param("id") id: string) {
    return this.service.get(r.tenantContext!, z.uuidv7().parse(id));
  }
  @Get("runs/:id/images/:index")
  @Header("Cache-Control", "private, no-store")
  @Header("Content-Security-Policy", "default-src 'none'; sandbox")
  @Header("X-Content-Type-Options", "nosniff")
  async image(
    @Req() r: AuthenticatedRequest,
    @Param("id") id: string,
    @Param("index") index: string,
  ) {
    return new StreamableFile(
      await this.service.image(
        r.tenantContext!,
        z.uuidv7().parse(id),
        z.coerce.number().int().min(0).max(15).parse(index),
      ),
      { type: "image/jpeg" },
    );
  }
}
