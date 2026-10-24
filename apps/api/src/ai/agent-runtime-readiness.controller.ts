import { BadRequestException, ConflictException, Controller, ForbiddenException, Get, Header, Inject, Param, Query, Req, Res } from "@nestjs/common";
import { erpPermissionContext, Permission } from "@yummyai/authz";
import { AgentReadinessFamilySchema } from "@yummyai/contracts/ai/agent-readiness";
import { erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { z } from "zod";
import { RequiresPermission } from "../auth/permissions.decorator.js";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { AgentRuntimeReadinessService } from "./agent-runtime-readiness.service.js";

const Empty = z.object({}).strict();

@Controller("v1/ai/agent-runtime-readiness")
export class AgentRuntimeReadinessController {
  constructor(@Inject(AgentRuntimeReadinessService) private readonly service: AgentRuntimeReadinessService) {}

  @Get(":family")
  @Header("Cache-Control", "private, no-store")
  @RequiresPermission(Permission.WorkflowRead)
  async get(@Req() request: AuthenticatedRequest, @Param("family") rawFamily: string, @Query() query: unknown,
    @Res({ passthrough: true }) response: { setHeader(name: string, value: string): void }) {
    if (!request.tenantContext || request.authenticationKind !== "oidc")
      throw new ForbiddenException({ code: "agent_runtime_readiness_personal_session_required" });
    const family = AgentReadinessFamilySchema.safeParse(rawFamily);
    if (!family.success || !Empty.safeParse(query).success) throw new BadRequestException({ code: "agent_runtime_readiness_input_invalid" });
    const expected = request.headers["x-yummyai-context-authority"];
    if (expected !== undefined && (typeof expected !== "string" || expected !== erpSessionAuthority(erpPermissionContext(request.tenantContext))))
      throw new ConflictException({ code: "authority_changed" });
    const result = await this.service.get(request.tenantContext, family.data);
    if (expected !== undefined && result.contextAuthority !== expected) throw new ConflictException({ code: "authority_changed" });
    response.setHeader("x-yummyai-context-authority", result.contextAuthority);
    return result;
  }
}
