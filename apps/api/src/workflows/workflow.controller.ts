import { Body, Controller, Get, Inject, Param, Patch, Post, Req } from "@nestjs/common";
import { Permission, authorize } from "@yummyai/authz";
import {
  CloneWorkflowDefinitionInputSchema,
  CreateWorkflowDefinitionInputSchema,
  PublishWorkflowDefinitionInputSchema,
  StartWorkflowRunInputSchema,
  UpdateWorkflowDraftInputSchema,
  WorkflowNodeCommandSchema,
} from "@yummyai/contracts";
import { z } from "zod";

import { RequiresPermission } from "../auth/permissions.decorator.js";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { WorkflowDefinitionService } from "./workflow-definition.service.js";
import { assertWorkflowCenterEnabled } from "./workflow-feature.js";
import { WorkflowRunService } from "./workflow-run.service.js";

@Controller("v1/workflows")
export class WorkflowDefinitionController {
  constructor(
    @Inject(WorkflowDefinitionService)
    private readonly definitions: WorkflowDefinitionService,
  ) {}

  @Get("definitions")
  @RequiresPermission(Permission.WorkflowRead)
  list(@Req() request: AuthenticatedRequest) {
    const context = requireContext(request);
    authorize(context, Permission.WorkflowRead);
    return this.definitions.list(context);
  }

  @Post("definitions")
  @RequiresPermission(Permission.WorkflowManage)
  create(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const context = requireContext(request);
    authorize(context, Permission.WorkflowManage);
    return this.definitions.create(context, CreateWorkflowDefinitionInputSchema.parse(body));
  }

  @Get("definitions/:id/draft")
  @RequiresPermission(Permission.WorkflowRead)
  get(@Req() request: AuthenticatedRequest, @Param("id") id: string) {
    const context = requireContext(request);
    authorize(context, Permission.WorkflowRead);
    return this.definitions.get(context, z.uuidv7().parse(id));
  }

  @Patch("definitions/:id/draft")
  @RequiresPermission(Permission.WorkflowManage)
  updateDraft(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const context = requireContext(request);
    authorize(context, Permission.WorkflowManage);
    return this.definitions.updateDraft(
      context,
      z.uuidv7().parse(id),
      UpdateWorkflowDraftInputSchema.parse(body),
    );
  }

  @Post("definitions/:id/clone")
  @RequiresPermission(Permission.WorkflowManage)
  clone(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const context = requireContext(request);
    authorize(context, Permission.WorkflowManage);
    return this.definitions.clone(
      context,
      z.uuidv7().parse(id),
      CloneWorkflowDefinitionInputSchema.parse(body),
    );
  }

  @Post("definitions/:id/publish")
  @RequiresPermission(Permission.WorkflowManage)
  publish(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const context = requireContext(request);
    authorize(context, Permission.WorkflowManage);
    const input = PublishWorkflowDefinitionInputSchema.parse(body);
    return this.definitions.publish(context, z.uuidv7().parse(id), input.expectedRevision);
  }
}

@Controller("v1/workflow-runs")
export class WorkflowRunController {
  constructor(@Inject(WorkflowRunService) private readonly runs: WorkflowRunService) {}

  @Get()
  @RequiresPermission(Permission.WorkflowRead)
  list(@Req() request: AuthenticatedRequest) {
    const context = requireContext(request);
    authorize(context, Permission.WorkflowRead);
    return this.runs.list(context);
  }

  @Post()
  @RequiresPermission(Permission.WorkflowRun)
  start(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const context = requireContext(request);
    authorize(context, Permission.WorkflowRun);
    return this.runs.start(context, StartWorkflowRunInputSchema.parse(body));
  }

  @Get("by-plan/:productPlanId")
  @RequiresPermission(Permission.WorkflowRead)
  getByPlan(
    @Req() request: AuthenticatedRequest,
    @Param("productPlanId") productPlanId: string,
  ) {
    const context = requireContext(request);
    authorize(context, Permission.WorkflowRead);
    return this.runs.getByProductPlan(context, z.uuidv7().parse(productPlanId));
  }

  @Get(":id")
  @RequiresPermission(Permission.WorkflowRead)
  get(@Req() request: AuthenticatedRequest, @Param("id") id: string) {
    const context = requireContext(request);
    authorize(context, Permission.WorkflowRead);
    return this.runs.get(context, z.uuidv7().parse(id));
  }

  @Post(":id/nodes/:nodeId/commands")
  @RequiresPermission(Permission.WorkflowRun)
  command(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string,
    @Param("nodeId") nodeId: string,
    @Body() body: unknown,
  ) {
    const context = requireContext(request);
    authorize(context, Permission.WorkflowRun);
    return this.runs.command(
      context,
      z.uuidv7().parse(id),
      z.string().trim().min(1).max(120).parse(nodeId),
      WorkflowNodeCommandSchema.parse(body),
    );
  }
}

function requireContext(request: AuthenticatedRequest) {
  if (!request.tenantContext) throw new Error("Tenant context is required");
  assertWorkflowCenterEnabled(request.tenantContext.tenantId);
  return request.tenantContext;
}
