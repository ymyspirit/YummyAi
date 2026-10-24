import { BadRequestException, Body, ConflictException, Controller, Get, Header, HttpCode, Inject, Param, Post, Query, Req } from "@nestjs/common";
import { Permission } from "@yummyai/authz";
import {
  BenchmarkAttemptPageQuerySchema, BenchmarkAttemptPageSchema, BenchmarkAttemptSchema,
  BenchmarkCommandReceiptSchema, BenchmarkCostSummarySchema, BenchmarkDatasetPageSchema,
  BenchmarkDatasetSchema, BenchmarkExperimentPageSchema, BenchmarkExperimentSchema,
  BenchmarkPageQuerySchema, BenchmarkReceiptSchema, BenchmarkReportPageSchema,
  BenchmarkReportSchema, BenchmarkVersionPageSchema, BenchmarkVersionSchema,
  CreateBenchmarkExperimentSchema, CreateBenchmarkReportSchema, PublishBenchmarkDatasetSchema,
  RecordBenchmarkExpenseSchema, ReviewBenchmarkAttemptSchema, SaveBenchmarkDatasetSchema,
  StartBenchmarkAttemptSchema,
  BusinessBenchmarkTargetQuerySchema, BusinessBenchmarkBasisRequestSchema,
} from "@yummyai/contracts/knowledge/benchmark";
import { AssistTaskTargetsSchema, AssistTaskBasisSchema } from "@yummyai/contracts/ai/task-workspace";
import { z } from "zod";
import { RequiresPermission } from "../auth/permissions.decorator.js";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { KnowledgeBenchmarkDatasetService } from "./knowledge-benchmark-dataset.service.js";
import { KnowledgeBenchmarkExperimentService } from "./knowledge-benchmark-experiment.service.js";
import { KnowledgeBenchmarkCostService } from "./knowledge-benchmark-cost.service.js";
import { KnowledgeBenchmarkBusinessService } from "./knowledge-benchmark-business.service.js";

const entityId = z.uuidv7().transform(value => value.toLowerCase());
const requestId = z.uuid().transform(value => value.toLowerCase());
const empty = z.object({}).strict();
function input<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BadRequestException("benchmark_input_invalid");
  return parsed.data;
}

@Controller("v1/knowledge-governance/benchmarks")
@RequiresPermission(Permission.WorkflowRead)
export class KnowledgeBenchmarkController {
  constructor(
    @Inject(KnowledgeBenchmarkDatasetService) private readonly datasets: KnowledgeBenchmarkDatasetService,
    @Inject(KnowledgeBenchmarkExperimentService) private readonly experiments: KnowledgeBenchmarkExperimentService,
    @Inject(KnowledgeBenchmarkCostService) private readonly costs: KnowledgeBenchmarkCostService,
    @Inject(KnowledgeBenchmarkBusinessService) private readonly business?: KnowledgeBenchmarkBusinessService,
  ) {}

  @Get("task-targets")
  @Header("Cache-Control", "private, no-store")
  async taskTargets(@Req() req: AuthenticatedRequest, @Query() query: unknown) {
    if (!this.business) throw new ConflictException("benchmark_business_adapter_unavailable");
    return AssistTaskTargetsSchema.parse(await this.business.targets(req.tenantContext!, input(BusinessBenchmarkTargetQuerySchema, query)));
  }
  @Post("task-basis")
  @HttpCode(200)
  @Header("Cache-Control", "private, no-store")
  @RequiresPermission(Permission.WorkflowRead, Permission.WorkflowManage, Permission.WorkflowRun)
  async taskBasis(@Req() req: AuthenticatedRequest, @Body() body: unknown, @Query() query: unknown) {
    input(empty, query);
    if (!this.business) throw new ConflictException("benchmark_business_adapter_unavailable");
    return AssistTaskBasisSchema.parse(await this.business.basis(req.tenantContext!, input(BusinessBenchmarkBasisRequestSchema, body)));
  }

  @Get("requests/:requestId")
  @Header("Cache-Control", "private, no-store")
  async request(@Req() req: AuthenticatedRequest, @Param("requestId") id: string, @Query() query: unknown) {
    input(empty, query);
    return BenchmarkCommandReceiptSchema.parse(await this.datasets.request(req.tenantContext!, input(requestId, id)));
  }
  @Get("datasets")
  @Header("Cache-Control", "private, no-store")
  async listDatasets(@Req() req: AuthenticatedRequest, @Query() query: unknown) {
    return BenchmarkDatasetPageSchema.parse(await this.datasets.list(req.tenantContext!, input(BenchmarkPageQuerySchema, query)));
  }
  @Get("datasets/:id")
  @Header("Cache-Control", "private, no-store")
  async dataset(@Req() req: AuthenticatedRequest, @Param("id") id: string, @Query() query: unknown) {
    input(empty, query);
    return BenchmarkDatasetSchema.parse(await this.datasets.get(req.tenantContext!, input(entityId, id)));
  }
  @Post("datasets")
  @Header("Cache-Control", "private, no-store")
  @RequiresPermission(Permission.WorkflowRead, Permission.WorkflowManage)
  async createDataset(@Req() req: AuthenticatedRequest, @Body() body: unknown, @Query() query: unknown) {
    input(empty, query);
    return BenchmarkReceiptSchema.parse(await this.datasets.save(req.tenantContext!, null, input(SaveBenchmarkDatasetSchema, body)));
  }
  @Post("datasets/:id/save")
  @Header("Cache-Control", "private, no-store")
  @RequiresPermission(Permission.WorkflowRead, Permission.WorkflowManage)
  async saveDataset(@Req() req: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown, @Query() query: unknown) {
    input(empty, query);
    return BenchmarkReceiptSchema.parse(await this.datasets.save(req.tenantContext!, input(entityId, id), input(SaveBenchmarkDatasetSchema, body)));
  }
  @Post("datasets/:id/publish")
  @Header("Cache-Control", "private, no-store")
  @RequiresPermission(Permission.WorkflowRead, Permission.WorkflowManage, Permission.WorkflowRun, Permission.WorkflowApprove)
  async publish(@Req() req: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown, @Query() query: unknown) {
    input(empty, query);
    return BenchmarkReceiptSchema.parse(await this.datasets.publish(req.tenantContext!, input(entityId, id), input(PublishBenchmarkDatasetSchema, body)));
  }
  @Get("datasets/:id/versions")
  @Header("Cache-Control", "private, no-store")
  async versions(@Req() req: AuthenticatedRequest, @Param("id") id: string, @Query() query: unknown) {
    return BenchmarkVersionPageSchema.parse(await this.datasets.versions(req.tenantContext!, input(entityId, id), input(BenchmarkPageQuerySchema, query)));
  }
  @Get("versions/:id")
  @Header("Cache-Control", "private, no-store")
  async version(@Req() req: AuthenticatedRequest, @Param("id") id: string, @Query() query: unknown) {
    input(empty, query);
    return BenchmarkVersionSchema.parse(await this.datasets.version(req.tenantContext!, input(entityId, id)));
  }
  @Post("experiments")
  @Header("Cache-Control", "private, no-store")
  @RequiresPermission(Permission.WorkflowRead, Permission.WorkflowManage, Permission.WorkflowRun)
  async createExperiment(@Req() req: AuthenticatedRequest, @Body() body: unknown, @Query() query: unknown) {
    input(empty, query);
    return BenchmarkReceiptSchema.parse(await this.experiments.create(req.tenantContext!, input(CreateBenchmarkExperimentSchema, body)));
  }
  @Get("experiments")
  @Header("Cache-Control", "private, no-store")
  async listExperiments(@Req() req: AuthenticatedRequest, @Query() query: unknown) {
    return BenchmarkExperimentPageSchema.parse(await this.experiments.list(req.tenantContext!, input(BenchmarkPageQuerySchema, query)));
  }
  @Get("experiments/:id")
  @Header("Cache-Control", "private, no-store")
  async experiment(@Req() req: AuthenticatedRequest, @Param("id") id: string, @Query() query: unknown) {
    input(empty, query);
    return BenchmarkExperimentSchema.parse(await this.experiments.get(req.tenantContext!, input(entityId, id)));
  }
  @Post("experiments/:id/attempts/start")
  @Header("Cache-Control", "private, no-store")
  @RequiresPermission(Permission.WorkflowRead, Permission.WorkflowManage, Permission.WorkflowRun)
  async start(@Req() req: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown, @Query() query: unknown) {
    input(empty, query);
    return BenchmarkReceiptSchema.parse(await this.experiments.start(req.tenantContext!, input(entityId, id), input(StartBenchmarkAttemptSchema, body)));
  }
  @Get("experiments/:id/attempts")
  @Header("Cache-Control", "private, no-store")
  async attempts(@Req() req: AuthenticatedRequest, @Param("id") id: string, @Query() query: unknown) {
    return BenchmarkAttemptPageSchema.parse(await this.experiments.attempts(req.tenantContext!, input(entityId, id), input(BenchmarkAttemptPageQuerySchema, query)));
  }
  @Get("attempts/:id")
  @Header("Cache-Control", "private, no-store")
  async attempt(@Req() req: AuthenticatedRequest, @Param("id") id: string, @Query() query: unknown) {
    input(empty, query);
    return BenchmarkAttemptSchema.parse(await this.experiments.attempt(req.tenantContext!, input(entityId, id)));
  }
  @Post("attempts/:id/review")
  @Header("Cache-Control", "private, no-store")
  @RequiresPermission(Permission.WorkflowRead, Permission.WorkflowApprove)
  async review(@Req() req: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown, @Query() query: unknown) {
    input(empty, query);
    return BenchmarkReceiptSchema.parse(await this.experiments.review(req.tenantContext!, input(entityId, id), input(ReviewBenchmarkAttemptSchema, body)));
  }
  @Get("experiments/:id/costs")
  @Header("Cache-Control", "private, no-store")
  async summary(@Req() req: AuthenticatedRequest, @Param("id") id: string, @Query() query: unknown) {
    input(empty, query);
    return BenchmarkCostSummarySchema.parse(await this.costs.summary(req.tenantContext!, input(entityId, id)));
  }
  @Post("experiments/:id/expenses")
  @Header("Cache-Control", "private, no-store")
  @RequiresPermission(Permission.WorkflowRead, Permission.WorkflowApprove)
  async expense(@Req() req: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown, @Query() query: unknown) {
    input(empty, query);
    return BenchmarkReceiptSchema.parse(await this.costs.expense(req.tenantContext!, input(entityId, id), input(RecordBenchmarkExpenseSchema, body)));
  }
  @Post("experiments/:id/reports")
  @Header("Cache-Control", "private, no-store")
  @RequiresPermission(Permission.WorkflowRead, Permission.WorkflowApprove)
  async report(@Req() req: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown, @Query() query: unknown) {
    input(empty, query);
    return BenchmarkReceiptSchema.parse(await this.costs.report(req.tenantContext!, input(entityId, id), input(CreateBenchmarkReportSchema, body)));
  }
  @Get("experiments/:id/reports")
  @Header("Cache-Control", "private, no-store")
  async reports(@Req() req: AuthenticatedRequest, @Param("id") id: string, @Query() query: unknown) {
    return BenchmarkReportPageSchema.parse(await this.costs.reports(req.tenantContext!, input(entityId, id), input(BenchmarkPageQuerySchema, query)));
  }
  @Get("reports/:id")
  @Header("Cache-Control", "private, no-store")
  async recordedReport(@Req() req: AuthenticatedRequest, @Param("id") id: string, @Query() query: unknown) {
    input(empty, query);
    return BenchmarkReportSchema.parse(await this.costs.readReport(req.tenantContext!, input(entityId, id)));
  }
}
