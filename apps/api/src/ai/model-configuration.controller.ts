import { Body, Controller, Header, Inject, Post, Req } from "@nestjs/common";
import { Permission } from "@yummyai/authz";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { RequiresPermission } from "../auth/permissions.decorator.js";
import { ModelConfigurationService } from "./model-configuration.service.js";

@Controller("v1/ai/configuration")
export class ModelConfigurationController {
  constructor(@Inject(ModelConfigurationService) private readonly service: ModelConfigurationService) {}
  @Post()
  @Header("Cache-Control", "private, no-store")
  @RequiresPermission(Permission.ModelConfigure)
  invoke(@Req() request: AuthenticatedRequest, @Body() body: unknown) { return this.service.invoke(request.tenantContext!, body); }
}
