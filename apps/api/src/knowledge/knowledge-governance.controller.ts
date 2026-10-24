import { BadRequestException, Body, Controller, Get, Inject, Param, Post, Query, Req, Header } from "@nestjs/common";
import { Permission } from "@yummyai/authz";
import {
  KnowledgeEvaluationReportSchema,
  KnowledgeSavedRecordSchema,
  ArchiveKnowledgeEvaluationSchema,
  ReviewKnowledgeEvaluationSchema,
  SaveKnowledgeEvaluationSchema,
  StartKnowledgeEvaluationSchema,
} from "@yummyai/contracts/knowledge/governance";
import {
  KnowledgeEvaluationComparisonQuerySchema,
  KnowledgeEvaluationComparisonSchema,
  KnowledgeEvaluationRunPageQuerySchema,
  KnowledgeEvaluationRunPageSchema,
} from "@yummyai/contracts/knowledge/evaluation-read";
import { z } from "zod";
import { RequiresPermission } from "../auth/permissions.decorator.js";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { KnowledgeImportService } from "./knowledge-import.service.js";
import { KnowledgeGovernanceService } from "./knowledge-governance.service.js";
import { KnowledgeEvaluationService } from "./knowledge-evaluation.service.js";
import { KnowledgeAnswerContextService } from "./knowledge-answer-context.service.js";
const id = (s: string) => z.uuidv7().parse(s);
const evaluationId = z.uuidv7().transform(value => value.toLowerCase());
const noEvaluationQuery = z.object({}).strict();
function evaluationInput<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new BadRequestException("评测参数无效");
  return result.data;
}
@Controller("v1/knowledge-governance")
@RequiresPermission(Permission.WorkflowRead)
export class KnowledgeGovernanceController {
  constructor(
    @Inject(KnowledgeImportService) private readonly imports: KnowledgeImportService,
    @Inject(KnowledgeGovernanceService) private readonly governance: KnowledgeGovernanceService,
    @Inject(KnowledgeEvaluationService) private readonly evaluations: KnowledgeEvaluationService,
    @Inject(KnowledgeAnswerContextService) private readonly answers: KnowledgeAnswerContextService,
  ) {}
  @Get("conversations")
  @Header("Cache-Control", "private, no-store")
  conversations(@Req() r: AuthenticatedRequest) {
    return this.answers.conversations(r.tenantContext!);
  }
  @Get("workspace")
  @Header("Cache-Control", "private, no-store")
  workspace(@Req() r: AuthenticatedRequest) {
    return this.governance.workspace(r.tenantContext!);
  }
  @Post("documents/upload")
  upload(@Req() r: AuthenticatedRequest, @Body() body: unknown) {
    return this.imports.upload(r.tenantContext!, body);
  }
  @Get("documents/:id")
  @Header("Cache-Control", "private, no-store")
  document(@Req() r: AuthenticatedRequest, @Param("id") value: string) {
    return this.imports.document(r.tenantContext!, id(value));
  }
  @Post("documents/:id/original")
  @Header("Cache-Control", "private, no-store")
  original(@Req() r: AuthenticatedRequest, @Param("id") value: string) {
    return this.imports.original(r.tenantContext!, id(value));
  }
  @Post("documents/:id/confirm")
  confirm(@Req() r: AuthenticatedRequest, @Param("id") value: string, @Body() body: unknown) {
    return this.imports.confirmAccount(r.tenantContext!, id(value), body);
  }
  @Post("documents/:id/purge")
  purge(@Req() r: AuthenticatedRequest, @Param("id") value: string) {
    return this.imports.dispose(r.tenantContext!, id(value), "purge");
  }
  @Post("documents/:id/archive")
  archiveDocument(@Req() r: AuthenticatedRequest, @Param("id") value: string) {
    return this.imports.dispose(r.tenantContext!, id(value), "archive");
  }
  @Post("candidates/:id/decide")
  candidate(@Req() r: AuthenticatedRequest, @Param("id") value: string, @Body() body: unknown) {
    return this.imports.decideCandidate(r.tenantContext!, id(value), body);
  }
  @Post("sources/create")
  addSource(@Req() r: AuthenticatedRequest, @Body() body: unknown) {
    return this.governance.addSource(r.tenantContext!, body);
  }
  @Post("sources/:id/check")
  check(@Req() r: AuthenticatedRequest, @Param("id") value: string) {
    return this.governance.checkSource(r.tenantContext!, id(value));
  }
  @Post("sources/:id/control")
  control(@Req() r: AuthenticatedRequest, @Param("id") value: string, @Body() body: unknown) {
    return this.governance.controlSource(r.tenantContext!, id(value), body);
  }
  @Post("sources/:id/archive")
  archiveSource(@Req() r: AuthenticatedRequest, @Param("id") value: string, @Body() body: unknown) {
    return this.governance.archive(r.tenantContext!, "source", id(value), body);
  }
  @Get("source-reviews/:id")
  @Header("Cache-Control", "private, no-store")
  sourceReview(@Req() r: AuthenticatedRequest, @Param("id") value: string) {
    return this.governance.reviewDetail(r.tenantContext!, id(value));
  }
  @Post("source-reviews/:id/review")
  review(@Req() r: AuthenticatedRequest, @Param("id") value: string, @Body() body: unknown) {
    return this.governance.reviewSource(r.tenantContext!, id(value), body);
  }
  @Post("needs/create")
  need(@Req() r: AuthenticatedRequest, @Body() body: unknown) {
    return this.governance.saveNeed(r.tenantContext!, null, body);
  }
  @Post("needs/:id/save")
  saveNeed(@Req() r: AuthenticatedRequest, @Param("id") value: string, @Body() body: unknown) {
    return this.governance.saveNeed(r.tenantContext!, id(value), body);
  }
  @Post("needs/:id/archive")
  archiveNeed(@Req() r: AuthenticatedRequest, @Param("id") value: string, @Body() body: unknown) {
    return this.governance.archive(r.tenantContext!, "need", id(value), body);
  }
  @Post("conflicts/:id/resolve")
  resolve(@Req() r: AuthenticatedRequest, @Param("id") value: string, @Body() body: unknown) {
    return this.governance.resolveConflict(r.tenantContext!, id(value), body);
  }
  @Post("evaluations/create")
  @Header("Cache-Control", "private, no-store")
  @RequiresPermission(Permission.WorkflowRead, Permission.WorkflowManage)
  async evaluation(@Req() r: AuthenticatedRequest, @Body() body: unknown, @Query() query: unknown = {}) {
    evaluationInput(noEvaluationQuery, query);
    return KnowledgeSavedRecordSchema.strict().parse(await this.governance.saveEvaluation(r.tenantContext!, null, evaluationInput(SaveKnowledgeEvaluationSchema, body)));
  }
  @Post("evaluations/:id/save")
  @Header("Cache-Control", "private, no-store")
  @RequiresPermission(Permission.WorkflowRead, Permission.WorkflowManage)
  async saveEvaluation(
    @Req() r: AuthenticatedRequest,
    @Param("id") value: string,
    @Body() body: unknown,
    @Query() query: unknown = {},
  ) {
    evaluationInput(noEvaluationQuery, query);
    const caseId = evaluationInput(evaluationId, value);
    return KnowledgeSavedRecordSchema.strict().refine(result => result.id === caseId).parse(await this.governance.saveEvaluation(r.tenantContext!, caseId, evaluationInput(SaveKnowledgeEvaluationSchema, body)));
  }
  @Post("evaluations/:id/archive")
  @Header("Cache-Control", "private, no-store")
  @RequiresPermission(Permission.WorkflowRead, Permission.WorkflowManage)
  async archiveEvaluation(
    @Req() r: AuthenticatedRequest,
    @Param("id") value: string,
    @Body() body: unknown,
    @Query() query: unknown = {},
  ) {
    evaluationInput(noEvaluationQuery, query);
    const caseId = evaluationInput(evaluationId, value);
    return KnowledgeSavedRecordSchema.strict().refine(result => result.id === caseId).parse(await this.governance.archive(r.tenantContext!, "evaluation", caseId, evaluationInput(ArchiveKnowledgeEvaluationSchema, body)));
  }
  @Post("evaluations/:id/start")
  @Header("Cache-Control", "private, no-store")
  async start(@Req() r: AuthenticatedRequest, @Param("id") value: string, @Body() body: unknown, @Query() query: unknown = {}) {
    evaluationInput(noEvaluationQuery, query);
    return KnowledgeSavedRecordSchema.strict().parse(await this.evaluations.start(r.tenantContext!, evaluationInput(evaluationId, value), evaluationInput(StartKnowledgeEvaluationSchema, body)));
  }
  @Get("evaluations/:id/runs")
  @Header("Cache-Control", "private, no-store")
  async runs(@Req() r: AuthenticatedRequest, @Param("id") value: string, @Query() query: unknown = {}) {
    evaluationInput(noEvaluationQuery, query);
    return z.array(KnowledgeEvaluationReportSchema.strict()).max(20).parse(await this.evaluations.list(r.tenantContext!, evaluationInput(evaluationId, value)));
  }
  @Get("evaluations/:id/run-page")
  @Header("Cache-Control", "private, no-store")
  async runPage(@Req() r: AuthenticatedRequest, @Param("id") value: string, @Query() query: unknown = {}) {
    return KnowledgeEvaluationRunPageSchema.parse(await this.evaluations.page(r.tenantContext!, evaluationInput(evaluationId, value), evaluationInput(KnowledgeEvaluationRunPageQuerySchema, query)));
  }
  @Get("evaluation-comparisons")
  @Header("Cache-Control", "private, no-store")
  async comparison(@Req() r: AuthenticatedRequest, @Query() query: unknown = {}) {
    return KnowledgeEvaluationComparisonSchema.parse(await this.evaluations.compare(r.tenantContext!, evaluationInput(KnowledgeEvaluationComparisonQuerySchema, query)));
  }
  @Get("evaluation-runs/:id")
  @Header("Cache-Control", "private, no-store")
  async report(@Req() r: AuthenticatedRequest, @Param("id") value: string, @Query() query: unknown = {}) {
    evaluationInput(noEvaluationQuery, query);
    return KnowledgeEvaluationReportSchema.strict().parse(await this.evaluations.report(r.tenantContext!, evaluationInput(evaluationId, value)));
  }
  @Post("evaluation-runs/:id/review")
  @Header("Cache-Control", "private, no-store")
  async reviewEvaluation(
    @Req() r: AuthenticatedRequest,
    @Param("id") value: string,
    @Body() body: unknown,
    @Query() query: unknown = {},
  ) {
    evaluationInput(noEvaluationQuery, query);
    return KnowledgeSavedRecordSchema.strict().parse(await this.evaluations.review(r.tenantContext!, evaluationInput(evaluationId, value), evaluationInput(ReviewKnowledgeEvaluationSchema, body)));
  }
  @Get(":id/history")
  @Header("Cache-Control", "private, no-store")
  history(@Req() r: AuthenticatedRequest, @Param("id") value: string) {
    return this.governance.history(r.tenantContext!, id(value));
  }
}
