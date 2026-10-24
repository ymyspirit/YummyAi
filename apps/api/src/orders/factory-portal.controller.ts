import {
  BadRequestException,
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
import { Permission } from "@yummyai/authz";
import { FactoryPortalSessionViewSchema } from "@yummyai/contracts/suppliers/factory-quantity";
import { z, ZodError } from "zod";
import { RequiresPermission } from "../auth/permissions.decorator.js";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { FactoryCollaborationService } from "./factory-collaboration.service.js";
import { OrderProductionDeliveryService } from "./order-production-delivery.service.js";
import { factoryPortalAuthority } from "./factory-access.js";
const Id = z.uuidv7(),
  Empty = z.object({}).strict();
function context(request: AuthenticatedRequest) {
  if (!request.tenantContext) throw new Error("Authenticated tenant required");
  return request.tenantContext;
}
function noQuery(query: unknown) {
  if (!Empty.safeParse(query).success) throw new BadRequestException("此操作不接受查询参数");
}
async function boundary<T>(run: () => Promise<T>) {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ZodError) throw new BadRequestException("请求参数无效，请重新核对");
    throw error;
  }
}

@Controller("v1/factory-collaboration")
export class FactoryCollaborationController {
  constructor(
    @Inject(FactoryCollaborationService)
    private readonly collaboration: FactoryCollaborationService,
  ) {}
  @Get("workspace")
  @Header("Cache-Control", "private, no-store")
  @RequiresPermission(Permission.MembershipManage, Permission.OrderRead)
  workspace(@Req() request: AuthenticatedRequest, @Query() query: unknown) {
    return boundary(() => this.collaboration.workspace(context(request), query));
  }
  @Post("grants")
  @Header("Cache-Control", "private, no-store")
  @RequiresPermission(Permission.MembershipManage, Permission.OrderRead, Permission.OrderWrite)
  create(@Req() request: AuthenticatedRequest, @Body() body: unknown, @Query() query: unknown) {
    noQuery(query);
    return boundary(() => this.collaboration.createGrant(context(request), body));
  }
  @Post("grants/:id/revoke")
  @Header("Cache-Control", "private, no-store")
  @RequiresPermission(Permission.MembershipManage, Permission.OrderRead, Permission.OrderWrite)
  revoke(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string,
    @Body() body: unknown,
    @Query() query: unknown,
  ) {
    noQuery(query);
    return boundary(() => this.collaboration.revokeGrant(context(request), Id.parse(id), body));
  }
  @Get("grants/:id/work-items")
  @Header("Cache-Control", "private, no-store")
  @RequiresPermission(Permission.MembershipManage, Permission.OrderRead)
  assignments(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string,
    @Query() query: unknown,
  ) {
    return boundary(() => this.collaboration.assignmentList(context(request), Id.parse(id), query));
  }
  @Post("grants/:id/work-items")
  @Header("Cache-Control", "private, no-store")
  @RequiresPermission(Permission.MembershipManage, Permission.OrderRead, Permission.OrderWrite)
  assign(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string,
    @Body() body: unknown,
    @Query() query: unknown,
  ) {
    noQuery(query);
    return boundary(() => this.collaboration.assign(context(request), Id.parse(id), body));
  }
  @Post("assignments/:id/revoke")
  @Header("Cache-Control", "private, no-store")
  @RequiresPermission(Permission.MembershipManage, Permission.OrderRead, Permission.OrderWrite)
  revokeAssignment(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string,
    @Body() body: unknown,
    @Query() query: unknown,
  ) {
    noQuery(query);
    return boundary(() =>
      this.collaboration.revokeAssignment(context(request), Id.parse(id), body),
    );
  }
}

@Controller("v1/factory-portal")
export class FactoryPortalController {
  constructor(
    @Inject(OrderProductionDeliveryService)
    private readonly deliveries: OrderProductionDeliveryService,
  ) {}
  @Get("session")
  @Header("Cache-Control", "private, no-store")
  session(@Req() request: AuthenticatedRequest, @Query() query: unknown) {
    noQuery(query);
    const actor = context(request);
    const canRead = actor.permissions.includes(Permission.FactoryTaskRead);
    return FactoryPortalSessionViewSchema.parse({
      authenticated: true,
      contextAuthority: factoryPortalAuthority(actor), canRead,
      canRespond: canRead && actor.permissions.includes(Permission.FactoryTaskRespond),
    });
  }
  @Get("work-items")
  @Header("Cache-Control", "private, no-store")
  @RequiresPermission(Permission.FactoryTaskRead)
  list(@Req() request: AuthenticatedRequest, @Query() query: unknown) {
    return boundary(() => this.deliveries.factoryTasks(context(request), query));
  }
  @Get("work-items/:id")
  @Header("Cache-Control", "private, no-store")
  @RequiresPermission(Permission.FactoryTaskRead)
  get(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Query() query: unknown) {
    noQuery(query);
    return boundary(() => this.deliveries.factoryTask(context(request), Id.parse(id)));
  }
  @Post("work-items/:id/feedback")
  @Header("Cache-Control", "private, no-store")
  @RequiresPermission(Permission.FactoryTaskRespond)
  feedback(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string,
    @Body() body: unknown,
    @Query() query: unknown,
  ) {
    noQuery(query);
    return boundary(() => this.deliveries.factoryFeedback(context(request), Id.parse(id), body));
  }
  @Get("work-items/:id/file")
  @RequiresPermission(Permission.FactoryTaskRead)
  async file(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string,
    @Query() query: unknown,
    @Res({ passthrough: true }) response: { setHeader(name: string, value: string): void },
  ) {
    noQuery(query);
    response.setHeader("Cache-Control", "private, no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
    response.setHeader("Referrer-Policy", "no-referrer");
    const file = await boundary(() => this.deliveries.factoryFile(context(request), Id.parse(id)));
    response.setHeader(
      "Content-Disposition",
      `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
    );
    return new StreamableFile(file.body, { type: file.mediaType, length: file.body.byteLength });
  }
}
