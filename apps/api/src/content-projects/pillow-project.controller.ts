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
import { PillowProjectQuerySchema } from "@yummyai/contracts/catalog/pillow-project";
import { RequiresPermission } from "../auth/permissions.decorator.js";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { PillowProjectService } from "./pillow-project.service.js";

@Controller("v1/content-projects/pillow")
@RequiresPermission(Permission.DesignRead)
export class PillowProjectController {
  constructor(@Inject(PillowProjectService) private readonly projects: PillowProjectService) {}
  @Get()
  @Header("Cache-Control", "private, no-store")
  workspace(@Req() request: AuthenticatedRequest, @Query() query: unknown) {
    const parsed = PillowProjectQuerySchema.safeParse(query);
    if (!parsed.success) throw new BadRequestException("抱枕项目筛选条件无效");
    return this.projects.workspace(context(request), parsed.data);
  }
  @Get("orders/:id")
  @Header("Cache-Control", "private, no-store")
  @RequiresPermission(
    Permission.DesignRead,
    Permission.AssetRead,
    Permission.OrderRead,
    Permission.OrderPiiRead,
  )
  order(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string,
    @Query() query: Record<string, unknown>,
  ) {
    const parsed = EntityIdSchema.safeParse(id);
    if (!parsed.success || Object.keys(query).length)
      throw new BadRequestException("抱枕订单编号或查询条件无效");
    return this.projects.order(context(request), parsed.data);
  }
}
function context(request: AuthenticatedRequest) {
  if (!request.tenantContext) throw new Error("Tenant context is required");
  return request.tenantContext;
}
