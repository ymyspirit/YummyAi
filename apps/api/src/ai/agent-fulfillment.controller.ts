import { BadRequestException, Body, Controller, ForbiddenException, Get, Header, HttpCode, Inject, Post, Query, Req } from "@nestjs/common";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { AgentFulfillmentService } from "./agent-fulfillment.service.js";
import { z } from "zod";

const Empty = z.object({}).strict();
function personal(request: AuthenticatedRequest, query: unknown) {
  if (request.authenticationKind !== "oidc" || !request.tenantContext)
    throw new ForbiddenException({ code: "agent_fulfillment_personal_session_required", message: "此入口需要当前本人会话" });
  if (!Empty.safeParse(query).success) throw new BadRequestException({ code: "agent_fulfillment_input_invalid", message: "此入口不接受额外查询参数" });
  return request.tenantContext;
}

@Controller("v1/agent-fulfillment")
export class AgentFulfillmentController {
  constructor(@Inject(AgentFulfillmentService) private readonly service: AgentFulfillmentService) {}

  @Get("workspace") @Header("Cache-Control", "private, no-store")
  workspace(@Req() request: AuthenticatedRequest, @Query() query: unknown) {
    return this.service.workspace(personal(request, query));
  }
  @Post("definition") @HttpCode(200) @Header("Cache-Control", "private, no-store")
  definition(@Req() request: AuthenticatedRequest, @Body() raw: unknown, @Query() query: unknown) {
    return this.service.definition(personal(request, query), raw);
  }
  @Post("candidates") @HttpCode(200) @Header("Cache-Control", "private, no-store")
  candidates(@Req() request: AuthenticatedRequest, @Body() raw: unknown, @Query() query: unknown) {
    return this.service.candidates(personal(request, query), raw);
  }
  @Post("call") @HttpCode(200) @Header("Cache-Control", "private, no-store")
  call(@Req() request: AuthenticatedRequest, @Body() raw: unknown, @Query() query: unknown) {
    return this.service.call(personal(request, query), raw);
  }
}
