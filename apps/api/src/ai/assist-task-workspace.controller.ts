import { Body, Controller, Get, Header, Inject, Post, Query, Req } from "@nestjs/common";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { AssistTaskWorkspaceService } from "./assist-task-workspace.service.js";

@Controller("v1/ai-assists")
export class AssistTaskWorkspaceController {
  constructor(
    @Inject(AssistTaskWorkspaceService) private readonly service: AssistTaskWorkspaceService,
  ) {}
  @Get("task-workspace")
  @Header("Cache-Control", "private, no-store")
  workspace(@Req() request: AuthenticatedRequest, @Query() query: unknown) {
    return this.service.workspace(request.tenantContext!, query);
  }
  @Get("task-targets")
  @Header("Cache-Control", "private, no-store")
  targets(@Req() request: AuthenticatedRequest, @Query() query: unknown) {
    return this.service.targets(request.tenantContext!, query);
  }
  @Post("task-basis")
  @Header("Cache-Control", "private, no-store")
  basis(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    return this.service.basis(request.tenantContext!, body);
  }
}
