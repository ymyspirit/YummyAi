import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { authorize, Permission } from "@yummyai/authz";
import {
  EntityIdSchema,
  PodExecutableToolKeySchema,
  PodTaskParameterSnapshotSchema,
  type TenantContext,
} from "@yummyai/contracts";
import { WorkflowExecutionSnapshotSchema } from "@yummyai/contracts/workflow/execution";
import {
  WorkflowNodeInspectionSchema,
  WorkflowRepairOptionsSchema,
  WorkflowArtifactInspectionSchema,
  workflowExecutionCode,
  workflowExecutionMessage,
} from "@yummyai/contracts/workflow/operator";
import {
  captureSnapshots,
  researchItems,
  users,
  workflowNodeAttempts,
  withTenant,
  type DatabaseConnection,
} from "@yummyai/database";
import { and, desc, eq, ilike, isNull, sql } from "drizzle-orm";
import { CustomProductPackageService } from "../catalog/custom-product-package.service.js";
import { PodArtworkTaskService } from "../design/pod-artwork-task.service.js";
import { podToolModule } from "../design/pod-workbench.service.js";
import { DATABASE_CONNECTION } from "../platform.tokens.js";
import { WorkflowRunService } from "./workflow-run.service.js";
import { workflowInvocationView } from "./workflow-invocation.js";
import type { HarnessInvocationView } from "@yummyai/contracts/harness";

@Injectable()
export class WorkflowOperatorService {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(WorkflowRunService) private readonly runs: WorkflowRunService,
    @Inject(CustomProductPackageService) private readonly catalog: CustomProductPackageService,
    @Inject(PodArtworkTaskService) private readonly pod: PodArtworkTaskService,
  ) {}

  private async basis(context: TenantContext, runId: string, nodeId: string) {
    authorize(context, Permission.WorkflowRead);
    authorize(context, Permission.ProductRead);
    const run = await this.runs.get(context, runId),
      node = run.graph.nodes.find((node) => node.id === nodeId),
      current = run.nodes.find((node) => node.nodeId === nodeId);
    if (!node || !current) throw new NotFoundException("Workflow node not found");
    const canCommand =
      context.permissions.includes(Permission.WorkflowRun) &&
      (!node.requiredPermission || context.permissions.includes(node.requiredPermission));
    return { run, node, current, canCommand };
  }

  async inspect(context: TenantContext, runId: string, nodeId: string) {
    const basis = await this.basis(context, runId, nodeId);
    const rows = await withTenant(this.database.db, context, (tx) =>
      tx
        .select({ attempt: workflowNodeAttempts, actor: users.displayName })
        .from(workflowNodeAttempts)
        .leftJoin(users, eq(users.id, workflowNodeAttempts.requestedBy))
        .where(eq(workflowNodeAttempts.nodeRunId, basis.current.id))
        .orderBy(desc(workflowNodeAttempts.attemptNumber))
        .limit(31),
    );
    let uncertain = false;
    const attempts = [];
    for (const { attempt, actor } of rows.slice(0, 30)) {
      let child = null;
      let childInvocations:HarnessInvocationView[]=[];
      let ownerUnavailable=false;
      const parsedSnapshot=WorkflowExecutionSnapshotSchema.safeParse(attempt.inputSnapshot);
      let receipt:null|{id:string;outputChecksum:string;createdAt:string}=null;
      if(attempt.startedAt&&parsedSnapshot.success&&parsedSnapshot.data.input.kind==="catalog") {
        try { receipt=await this.catalog.getOperationReceipt(context,basis.run.productPlanId,parsedSnapshot.data.input.value.operationId); }
        catch(error) { ownerUnavailable=!(error instanceof NotFoundException); }
      }
      const childId = EntityIdSchema.safeParse(attempt.outputSnapshot?.delegatedTaskId);
      if (
        childId.success &&
        !context.permissions.includes(Permission.DesignRead) &&
        attempt.attemptNumber === basis.current.attemptCount
      )
        uncertain = true;
      if(childId.success&&!context.permissions.includes(Permission.DesignRead))ownerUnavailable=true;
      if (childId.success && context.permissions.includes(Permission.DesignRead)) {
        try {
          const task = await this.pod.get(context, childId.data);
          childInvocations=(task.invocations??[]).map(invocation=>({...invocation,parentId:attempt.id}));
          child = {
            id: task.id,
            module: podToolModule(task.toolKey),
            status: task.status,
            progressPercent: task.progressPercent,
            needsReconciliation: task.errorCode === "POD_RESULT_UNCERTAIN",
          };
          if (
            attempt.attemptNumber === basis.current.attemptCount &&
            (task.errorCode === "POD_RESULT_UNCERTAIN" || task.status === "running")
          )
            uncertain = true;
        } catch {
          ownerUnavailable=true;
          if (attempt.attemptNumber === basis.current.attemptCount) uncertain = true;
        }
      }
      attempts.push({
        id: attempt.id,
        number: attempt.attemptNumber,
        status: attempt.status,
        actor: actor ?? "原操作者已移除或未记录",
        queuedAt: attempt.queuedAt.toISOString(),
        startedAt: attempt.startedAt?.toISOString() ?? null,
        finishedAt: attempt.finishedAt?.toISOString() ?? null,
        errorCode: workflowExecutionCode(attempt.errorCode),
        message: workflowExecutionMessage(attempt.errorCode),
        recoveryCount: attempt.recoveryCount,
        inputChecksum: attempt.inputChecksum,
        inputAvailable: Boolean(attempt.inputSnapshot && attempt.requestedBy),
        methodSelection: parsedSnapshot.success ? parsedSnapshot.data.methodSelection ?? null : null,
        executionContract: (() => {
          const parsed = WorkflowExecutionSnapshotSchema.safeParse(attempt.inputSnapshot);
          return parsed.success ? parsed.data.executionContract ?? null : null;
        })(),
        invocations:[workflowInvocationView(attempt,parsedSnapshot.success?parsedSnapshot.data:null,receipt,child!==null,ownerUnavailable),...childInvocations],
        child,
      });
    }
    const capability = basis.node.config.capabilityKey;
    const repairPermissions = capability?.startsWith("pod.")
      ? [Permission.DesignRead, Permission.DesignWrite, Permission.AssetRead]
      : [
          Permission.ProductWrite,
          ...(capability?.endsWith("generate_provisional_facts")
            ? [Permission.ResearchRead]
            : [Permission.AssetRead]),
        ];
    const latestSnapshot = WorkflowExecutionSnapshotSchema.safeParse(
      rows[0]?.attempt.inputSnapshot,
    );
    const pinnedPermissions = latestSnapshot.success ? latestSnapshot.data.requiredPermissions : [];
    const canRepair =
      basis.canCommand &&
      basis.node.kind === "internal_action" &&
      !uncertain &&
      [...repairPermissions, ...pinnedPermissions].every((permission) =>
        context.permissions.includes(permission),
      );
    return WorkflowNodeInspectionSchema.parse({
      runId,
      nodeId,
      inspectedAt: new Date().toISOString(),
      attempts,
      hasMoreAttempts: rows.length > 30,
      access: {
        canCommand: basis.canCommand,
        canApprove: basis.canCommand && context.permissions.includes(Permission.WorkflowApprove),
        canRetry:
          canRepair && latestSnapshot.success && rows[0]?.attempt.requestedBy === context.userId,
        canRepair,
      },
    });
  }

  async repairOptions(context: TenantContext, runId: string, nodeId: string, query = "") {
    const basis = await this.basis(context, runId, nodeId);
    const inspection = await this.inspect(context, runId, nodeId);
    if (!inspection.access.canRepair)
      throw new ForbiddenException("当前权限或原任务状态不允许重新配置");
    const [latest] = await withTenant(this.database.db, context, (tx) =>
      tx
        .select()
        .from(workflowNodeAttempts)
        .where(eq(workflowNodeAttempts.nodeRunId, basis.current.id))
        .orderBy(desc(workflowNodeAttempts.attemptNumber))
        .limit(1),
    );
    const snapshot = WorkflowExecutionSnapshotSchema.safeParse(latest?.inputSnapshot);
    const parameters = { ...basis.node.config.parameters, ...basis.current.parameterSnapshot };
    if (basis.node.config.capabilityKey === "yummyai.custom_product.generate_provisional_facts") {
      authorize(context, Permission.ResearchRead);
      const term = query
        .trim()
        .slice(0, 100)
        .replace(/[\\%_]/g, "\\$&");
      const sources = await withTenant(this.database.db, context, (tx) =>
        tx
          .select({
            snapshotId: captureSnapshots.id,
            title: captureSnapshots.title,
            capturedAt: captureSnapshots.capturedAt,
          })
          .from(captureSnapshots)
          .innerJoin(researchItems, eq(researchItems.id, captureSnapshots.researchItemId))
          .where(
            and(
              isNull(researchItems.archivedAt),
              context.dataScope === "tenant"
                ? undefined
                : eq(researchItems.ownerUserId, context.userId),
              term ? ilike(captureSnapshots.title, `%${term}%`) : undefined,
            ),
          )
          .orderBy(desc(captureSnapshots.capturedAt), desc(captureSnapshots.id))
          .limit(51),
      );
      const pin =
        snapshot.success && snapshot.data.input.kind === "catalog"
          ? snapshot.data.input.value
          : undefined;
      return WorkflowRepairOptionsSchema.parse({
        kind: "profile",
        targetMarketplace:
          pin?.targetMarketplace ??
          (typeof parameters.targetMarketplace === "string"
            ? parameters.targetMarketplace
            : "amazon.com"),
        researchSnapshotId:
          pin?.sources[0]?.snapshotId ??
          (EntityIdSchema.safeParse(parameters.researchSnapshotId).success
            ? parameters.researchSnapshotId
            : null),
        sources: sources.slice(0, 50).map((source) => ({
          ...source,
          title: source.title ?? "未命名研究资料",
          capturedAt: source.capturedAt.toISOString(),
        })),
        hasMoreSources: sources.length > 50,
      });
    }
    if (basis.node.config.capabilityKey === "yummyai.custom_product.export_package") {
      const mode =
        snapshot.success && snapshot.data.input.kind === "catalog"
          ? snapshot.data.input.value.mode
          : parameters.mode;
      return WorkflowRepairOptionsSchema.parse({
        kind: "package",
        mode: mode === "release" ? "release" : "draft",
      });
    }
    const tool = PodExecutableToolKeySchema.safeParse(
      basis.node.config.capabilityKey?.replace(/^pod\./, ""),
    );
    if (!tool.success) throw new BadRequestException("该节点没有可重新配置的内部工具");
    const pin =
      snapshot.success && snapshot.data.input.kind === "pod"
        ? snapshot.data.input.value.input
        : undefined;
    const options = await this.pod.inputOptions(context, tool.data, basis.run.productPlanId);
    const parsed = PodTaskParameterSnapshotSchema.safeParse(
      pin?.parameterSnapshot ?? parameters.parameterSnapshot,
    );
    return WorkflowRepairOptionsSchema.parse({
      kind: "pod",
      toolKey: tool.data,
      title:
        pin?.title ?? (typeof parameters.title === "string" ? parameters.title : basis.node.title),
      skuId:
        pin?.skuId ??
        (EntityIdSchema.safeParse(parameters.skuId).success ? parameters.skuId : null),
      inputAssetIds: pin?.inputAssetIds ?? [],
      parameterSnapshot: parsed.success ? parsed.data : null,
      options,
    });
  }

  private async linked(context: TenantContext, runId: string, linkId: string) {
    authorize(context, Permission.WorkflowRead);
    authorize(context, Permission.ProductRead);
    const run = await this.runs.get(context, runId),
      link = run.artifacts.find((artifact) => artifact.id === linkId);
    if (!link) throw new NotFoundException("Workflow artifact not found");
    return { run, link };
  }
  async artifact(context: TenantContext, runId: string, linkId: string) {
    const { run, link } = await this.linked(context, runId, linkId);
    if (link.artifactType === "product_facts" || link.artifactType === "product_package") {
      const receiptId = EntityIdSchema.safeParse(link.artifactId);
      if (!receiptId.success) throw new NotFoundException("Legacy artifact has no owned receipt");
      const receipt = await this.catalog.getOperationReceipt(
        context,
        run.productPlanId,
        receiptId.data,
      );
      if (link.artifactType === "product_facts" && receipt.operation === "profile")
        return WorkflowArtifactInspectionSchema.parse({
          kind: "profile",
          receiptId: receipt.id,
          checksum: receipt.outputChecksum,
          createdAt: receipt.createdAt,
          profile: receipt.result.profile,
        });
      if (link.artifactType === "product_package" && receipt.operation === "package")
        return WorkflowArtifactInspectionSchema.parse({
          kind: "package",
          receiptId: receipt.id,
          checksum: receipt.outputChecksum,
          createdAt: receipt.createdAt,
          mode: receipt.result.mode,
          fileName: receipt.result.fileName,
          completeness: receipt.result.completeness,
          canDownload: context.permissions.includes(Permission.AssetRead),
        });
      throw new NotFoundException("Artifact does not match its owner receipt");
    }
    if (link.artifactType === "design_version") {
      authorize(context, Permission.DesignRead);
      const node = run.nodes.find((node) => node.nodeId === link.nodeId);
      if (!node) throw new NotFoundException("Artifact node not found");
      const attempts = await withTenant(this.database.db, context, (tx) =>
        tx
          .select({ output: workflowNodeAttempts.outputSnapshot })
          .from(workflowNodeAttempts)
          .where(
            and(
              eq(workflowNodeAttempts.nodeRunId, node.id),
              sql`${workflowNodeAttempts.outputSnapshot}->>'artifactId' = ${link.artifactId}`,
            ),
          )
          .limit(1),
      );
      const output = attempts.find(
        (attempt) => attempt.output?.artifactId === link.artifactId,
      )?.output;
      const taskId = EntityIdSchema.safeParse(output?.delegatedTaskId);
      if (!taskId.success) throw new NotFoundException("Artifact has no owned POD task");
      const task = await this.pod.get(context, taskId.data);
      if (task.resultVersionId !== link.artifactId)
        throw new NotFoundException("POD artifact version does not match");
      return WorkflowArtifactInspectionSchema.parse({
        kind: "pod",
        taskId: task.id,
        module: podToolModule(task.toolKey),
        designTaskId: task.designTaskId,
        versionId: task.resultVersionId,
        toolKey: task.toolKey,
        status: task.status,
        progressPercent: task.progressPercent,
      });
    }
    throw new NotFoundException("This artifact has no supported owner view");
  }
  async download(context: TenantContext, runId: string, linkId: string) {
    const { run, link } = await this.linked(context, runId, linkId);
    if (link.artifactType !== "product_package")
      throw new NotFoundException("This artifact is not a product package");
    const receiptId = EntityIdSchema.safeParse(link.artifactId);
    if (!receiptId.success) throw new NotFoundException("Artifact has no owned package receipt");
    return this.catalog.downloadOperationPackage(context, run.productPlanId, receiptId.data);
  }
}
