import {
  BadRequestException,
  Controller,
  Get,
  Header,
  Inject,
  Param,
  Query,
  Req,
} from "@nestjs/common";
import { Permission } from "@yummyai/authz";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import { ContentProjectQuerySchema } from "@yummyai/contracts/catalog/content-project";
import { RequiresPermission } from "../auth/permissions.decorator.js";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { ContentProjectService } from "./content-project.service.js";

@Controller("v1/content-projects")
@RequiresPermission(Permission.DesignRead)
export class ContentProjectController {
  constructor(@Inject(ContentProjectService) private readonly projects: ContentProjectService) {}
  @Get()
  @Header("Cache-Control", "private, no-store")
  list(@Req() request: AuthenticatedRequest, @Query() query: unknown) {
    const parsed = ContentProjectQuerySchema.safeParse(query);
    if (!parsed.success) throw new BadRequestException("图文项目筛选条件无效");
    return this.projects.list(context(request), parsed.data);
  }
  @Get(":id")
  @Header("Cache-Control", "private, no-store")
  @RequiresPermission(Permission.DesignRead, Permission.AssetRead)
  get(@Req() request: AuthenticatedRequest, @Param("id") id: string) {
    const parsed = EntityIdSchema.safeParse(id);
    if (!parsed.success) throw new BadRequestException("图文项目编号无效");
    return this.projects.get(context(request), parsed.data);
  }
}
function context(request: AuthenticatedRequest) {
  if (!request.tenantContext) throw new Error("Tenant context is required");
  return request.tenantContext;
}
