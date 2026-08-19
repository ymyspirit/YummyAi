import { Body, Controller, Get, GoneException, Inject, Param, Patch, Post, Req } from "@nestjs/common";
import { Permission, authorize } from "@yummyai/authz";
import { z } from "zod";

import { RequiresPermission } from "../auth/permissions.decorator.js";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { AmazonCustomWorkflowService } from "./amazon-custom-workflow.service.js";

@Controller("v1/products")
export class AmazonCustomWorkflowController {
  constructor(
    @Inject(AmazonCustomWorkflowService)
    private readonly workflows: AmazonCustomWorkflowService,
  ) {}

  @Get("custom-workflows")
  @RequiresPermission(Permission.ProductRead)
  list(@Req() request: AuthenticatedRequest) {
    const context = requireContext(request);
    authorize(context, Permission.ProductRead);
    return this.workflows.list(context);
  }

  @Get("plans/:id/custom-workflow")
  @RequiresPermission(Permission.ProductRead)
  get(@Req() request: AuthenticatedRequest, @Param("id") id: string) {
    const context = requireContext(request);
    authorize(context, Permission.ProductRead);
    return this.workflows.get(context, z.uuidv7().parse(id));
  }

  @Post("plans/:id/custom-workflow")
  @RequiresPermission(Permission.ProductWrite)
  start(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const context = requireContext(request);
    authorize(context, Permission.ProductWrite);
    void id;
    void body;
    throw new GoneException("Amazon Custom SOP 已迁移到工作流中心，请使用 POST /v1/workflow-runs");
  }

  @Post("plans/:id/custom-workflow/steps/:stepKey/transitions")
  @RequiresPermission(Permission.ProductWrite)
  transition(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string,
    @Param("stepKey") stepKey: string,
    @Body() body: unknown,
  ) {
    const context = requireContext(request);
    authorize(context, Permission.ProductWrite);
    void id;
    void stepKey;
    void body;
    throw new GoneException("旧 Amazon Custom SOP 已只读，请使用工作流节点命令接口");
  }

  @Patch("plans/:id/custom-workflow/steps/:stepKey")
  @RequiresPermission(Permission.ProductWrite)
  updateCompletedStepNote(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string,
    @Param("stepKey") stepKey: string,
    @Body() body: unknown,
  ) {
    const context = requireContext(request);
    authorize(context, Permission.ProductWrite);
    void id;
    void stepKey;
    void body;
    throw new GoneException("旧 Amazon Custom SOP 已只读，请使用工作流节点命令接口");
  }
}

function requireContext(request: AuthenticatedRequest) {
  if (!request.tenantContext) throw new Error("Tenant context is required");
  return request.tenantContext;
}
