import { Body, Controller, Inject, Post, Req } from "@nestjs/common";
import { Permission } from "@yummyai/authz";
import { RequiresPermission } from "../auth/permissions.decorator.js";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { CreativeStudioService } from "./creative-studio.service.js";
import { StudioGenerationService } from "./studio-generation.service.js";

@Controller("v1/creative-studio")
export class CreativeStudioController {
  constructor(@Inject(CreativeStudioService) private readonly studio: CreativeStudioService, @Inject(StudioGenerationService) private readonly generation: StudioGenerationService) {}
  @Post("rpc")
  @RequiresPermission(Permission.DesignRead)
  invoke(@Req() request: AuthenticatedRequest, @Body() body: unknown) { return this.studio.invoke(request.tenantContext!, body); }
  @Post("models")
  @RequiresPermission(Permission.ModelConfigure)
  addModel(@Req() request: AuthenticatedRequest, @Body() body: unknown) { return this.generation.addModel(request.tenantContext!, body); }
}
