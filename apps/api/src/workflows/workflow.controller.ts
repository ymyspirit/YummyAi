import { WorkflowResponsibilityInputSchema } from "@yummyai/contracts/workflow/responsibility";
import { WorkflowTaskInboxQuerySchema } from "@yummyai/contracts/workflow/task-inbox";
import { WorkflowResponsibilityService } from "./workflow-responsibility.service.js";
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
  StreamableFile,
} from "@nestjs/common";
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
import { WorkflowOperatorService } from "./workflow-operator.service.js";

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
  clone(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown) {
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
  publish(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown) {
    const context = requireContext(request);
    authorize(context, Permission.WorkflowManage);
    const input = PublishWorkflowDefinitionInputSchema.parse(body);
    return this.definitions.publish(context, z.uuidv7().parse(id), input.expectedRevision);
  }
}

@Controller("v1/workflow-runs")
export class WorkflowRunController {
  constructor(
    @Inject(WorkflowRunService) private readonly runs: WorkflowRunService,
    @Inject(WorkflowOperatorService) private readonly operator: WorkflowOperatorService,
    @Inject(WorkflowResponsibilityService)
    private readonly responsibilities: WorkflowResponsibilityService,
  ) {}

  @Get("tasks")
  @RequiresPermission(Permission.WorkflowRead)
  tasks(@Req() request: AuthenticatedRequest, @Query() query: unknown) {
    return this.responsibilities.tasks(requireContext(request), WorkflowTaskInboxQuerySchema.parse(query));
  }

  @Get(":id/nodes/:nodeId/responsibility")
  @RequiresPermission(Permission.WorkflowRead)
  responsibility(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string,
    @Param("nodeId") nodeId: string,
    @Query("q") query?: string,
  ) {
    return this.responsibilities.get(
      requireContext(request),
      z.uuidv7().parse(id),
      z.string().min(1).max(120).parse(nodeId),
      z
        .string()
        .max(100)
        .parse(query ?? ""),
    );
  }
  @Post(":id/nodes/:nodeId/responsibility")
  @RequiresPermission(Permission.WorkflowAssign)
  assign(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string,
    @Param("nodeId") nodeId: string,
    @Body() body: unknown,
  ) {
    return this.responsibilities.update(
      requireContext(request),
      z.uuidv7().parse(id),
      z.string().min(1).max(120).parse(nodeId),
      WorkflowResponsibilityInputSchema.parse(body),
    );
  }

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
  getByPlan(@Req() request: AuthenticatedRequest, @Param("productPlanId") productPlanId: string) {
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

  @Get(":id/nodes/:nodeId/execution")
  @RequiresPermission(Permission.WorkflowRead)
  execution(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string,
    @Param("nodeId") nodeId: string,
  ) {
    return this.operator.inspect(
      requireContext(request),
      z.uuidv7().parse(id),
      z.string().min(1).max(120).parse(nodeId),
    );
  }
  @Get(":id/nodes/:nodeId/repair-options")
  @RequiresPermission(Permission.WorkflowRead)
  repairOptions(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string,
    @Param("nodeId") nodeId: string,
    @Query("q") query?: string,
  ) {
    return this.operator.repairOptions(
      requireContext(request),
      z.uuidv7().parse(id),
      z.string().min(1).max(120).parse(nodeId),
      z
        .string()
        .max(100)
        .parse(query ?? ""),
    );
  }
  @Get(":id/artifacts/:linkId")
  @RequiresPermission(Permission.WorkflowRead)
  artifact(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string,
    @Param("linkId") linkId: string,
  ) {
    return this.operator.artifact(
      requireContext(request),
      z.uuidv7().parse(id),
      z.uuidv7().parse(linkId),
    );
  }
  @Get(":id/artifacts/:linkId/file")
  @Header("Cache-Control", "private, no-store")
  @Header("X-Content-Type-Options", "nosniff")
  @RequiresPermission(Permission.WorkflowRead)
  async artifactFile(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string,
    @Param("linkId") linkId: string,
  ) {
    const result = await this.operator.download(
      requireContext(request),
      z.uuidv7().parse(id),
      z.uuidv7().parse(linkId),
    );
    return new StreamableFile(Buffer.from(result.bytes), {
      type: "application/zip",
      length: result.bytes.byteLength,
      disposition: `attachment; filename*=UTF-8''${encodeURIComponent(result.fileName)}`,
    });
  }
}

function requireContext(request: AuthenticatedRequest) {
  if (!request.tenantContext) throw new Error("Tenant context is required");
  assertWorkflowCenterEnabled(request.tenantContext.tenantId);
  return request.tenantContext;
}
