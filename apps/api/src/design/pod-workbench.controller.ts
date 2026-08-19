import { Body, Controller, Get, Inject, Param, Post, Req } from "@nestjs/common";
import { Permission, authorize } from "@yummyai/authz";
import { CreatePodArtworkTaskInputSchema, PodExecutableToolKeySchema } from "@yummyai/contracts";
import { z } from "zod";

import { RequiresPermission } from "../auth/permissions.decorator.js";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { PodWorkbenchService } from "./pod-workbench.service.js";
import { PodArtworkTaskService } from "./pod-artwork-task.service.js";

@Controller("v1/pod")
export class PodWorkbenchController {
  constructor(
    @Inject(PodWorkbenchService) private readonly workbench: PodWorkbenchService,
    @Inject(PodArtworkTaskService) private readonly tasks: PodArtworkTaskService,
  ) {}

  @Get("tools")
  @RequiresPermission(Permission.DesignRead)
  getToolCatalog(@Req() request: AuthenticatedRequest) {
    const context = requireContext(request);
    authorize(context, Permission.DesignRead);
    return this.workbench.getToolCatalog();
  }

  @Get("tasks")
  @RequiresPermission(Permission.DesignRead)
  listTasks(@Req() request: AuthenticatedRequest) {
    const context = requireContext(request);
    authorize(context, Permission.DesignRead);
    return this.tasks.list(context);
  }

  @Get("input-options/:toolKey")
  @RequiresPermission(Permission.DesignRead)
  inputOptions(@Req() request: AuthenticatedRequest, @Param("toolKey") toolKey: string) {
    const context = requireContext(request);
    authorize(context, Permission.DesignRead);
    return this.tasks.inputOptions(context, PodExecutableToolKeySchema.parse(toolKey));
  }

  @Get("tasks/:id")
  @RequiresPermission(Permission.DesignRead)
  getTask(@Req() request: AuthenticatedRequest, @Param("id") id: string) {
    const context = requireContext(request);
    authorize(context, Permission.DesignRead);
    return this.tasks.get(context, z.uuidv7().parse(id));
  }

  @Post("tasks")
  @RequiresPermission(Permission.DesignWrite)
  createTask(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const context = requireContext(request);
    authorize(context, Permission.DesignWrite);
    return this.tasks.create(context, CreatePodArtworkTaskInputSchema.parse(body));
  }
}

function requireContext(request: AuthenticatedRequest) {
  if (!request.tenantContext) throw new Error("Tenant context is required");
  return request.tenantContext;
}
