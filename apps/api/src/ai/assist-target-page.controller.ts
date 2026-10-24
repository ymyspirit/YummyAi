import { Controller, Get, Header, Inject, Query, Req } from "@nestjs/common";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { AssistTargetPageService } from "./assist-target-page.service.js";
@Controller("v1/ai-assists")
export class AssistTargetPageController {
  constructor(@Inject(AssistTargetPageService) private readonly service: AssistTargetPageService) {}
  @Get("task-target-pages")
  @Header("Cache-Control", "private, no-store")
  page(@Req() request: AuthenticatedRequest, @Query() query: unknown) { return this.service.page(request.tenantContext!, query); }
}
