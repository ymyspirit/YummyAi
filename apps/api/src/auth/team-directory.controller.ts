import {
  Body,
  Controller,
  Get,
  Header,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from "@nestjs/common";
import { z } from "zod";
import { Permission } from "@yummyai/authz";
import { RequiresPermission } from "./permissions.decorator.js";
import type { AuthenticatedRequest } from "./tenant-context.guard.js";
import { TeamDirectoryService } from "./team-directory.service.js";
const context = (request: AuthenticatedRequest) => {
  if (!request.tenantContext) throw Error("Authenticated context required");
  return request.tenantContext;
};
@Controller("v1/teams")
export class TeamDirectoryController {
  constructor(@Inject(TeamDirectoryService) private readonly teams: TeamDirectoryService) {}
  @Get()
  @Header("Cache-Control", "private, no-store")
  @RequiresPermission(Permission.MembershipManage)
  workspace(@Req() r: AuthenticatedRequest, @Query() q: unknown) {
    return this.teams.workspace(context(r), q);
  }
  @Get("options")
  @Header("Cache-Control", "private, no-store")
  options(@Req() r: AuthenticatedRequest, @Query() q: unknown) {
    z.object({}).strict().parse(q);
    return this.teams.options(context(r));
  }
  @Post()
  @RequiresPermission(Permission.MembershipManage)
  create(@Req() r: AuthenticatedRequest, @Body() b: unknown) {
    return this.teams.create(context(r), b);
  }
  @Patch(":id")
  @RequiresPermission(Permission.MembershipManage)
  update(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Body() b: unknown) {
    return this.teams.update(context(r), z.uuidv7().parse(id), b);
  }
  @Post(":id/members")
  @RequiresPermission(Permission.MembershipManage)
  member(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Body() b: unknown) {
    return this.teams.setMember(context(r), z.uuidv7().parse(id), b);
  }
}
