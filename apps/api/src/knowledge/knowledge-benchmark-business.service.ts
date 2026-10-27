import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { authorize, ForbiddenError, permissionScope, Permission, requiredAssistPermissions, assertBusinessBenchmarkScope, businessBenchmarkRunPermissions } from "@yummyai/authz";
import {
  assistPromptVersion, assistResultSchema, assistFingerprint, assistScope, assistTaskFingerprint, businessBenchmarkBasisFingerprint,
  businessBenchmarkCaseChecksum, businessBenchmarkSourcePins, knowledgeEvaluationChecksum,
  type AssistContext, type SecretVault,
} from "@yummyai/ai-core";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { CreateAssistSchema, type CreateAssist } from "@yummyai/contracts/ai/assist";
import {
  BusinessBenchmarkBasisRequestSchema, BusinessBenchmarkTargetQuerySchema,
  BUSINESS_BENCHMARK_ROLES, LEGACY_BUSINESS_BENCHMARK_ROLES, type BusinessBenchmarkCase,
} from "@yummyai/contracts/knowledge/benchmark";
import { AssistTaskBasisSchema, AssistTaskTargetsSchema } from "@yummyai/contracts/ai/task-workspace";
import {
   aiAssistRuns, inventoryLocations, inventoryStockItems, withTenant, assertBusinessBenchmarkResources,
  type DatabaseConnection, type TenantTransaction,
} from "@yummyai/database";
import { assertEvaluationScope, currentEvaluationContext } from "@yummyai/knowledge-core";
import { and, eq, inArray } from "drizzle-orm";
import { DATABASE_CONNECTION } from "../platform.tokens.js";
import { AssistService, type AssistOwnerAdmission } from "../ai/assist.service.js";
import { AssistTaskWorkspaceService } from "../ai/assist-task-workspace.service.js";
import { isPinnedAssistGuidanceCurrentInTransaction } from "../ai/assist-context.service.js";

const rank = { self: 0, team: 1, tenant: 2 };
type BusinessRole = BusinessBenchmarkCase["role"];
export { assertBusinessBenchmarkScope } from "@yummyai/authz";
export { assertBusinessBenchmarkResources } from "@yummyai/database";
export const businessBenchmarkPermissions = businessBenchmarkRunPermissions;
const newRole = (role: string) => !LEGACY_BUSINESS_BENCHMARK_ROLES.some(value => value === role);
function businessRequest(fields: BusinessBenchmarkCase): CreateAssist {
  const request = CreateAssistSchema.parse({ ...fields.task, modelId: createEntityId(), requestId: createEntityId() });
  if (request.kind !== fields.role || !BUSINESS_BENCHMARK_ROLES.some(role => role === request.kind) || request.kind === "artwork_preflight" && (request.automaticAudit || request.retryAudit))
    throw new ConflictException("benchmark_business_role_invalid");
  return request;
}
export const businessBenchmarkTaskScope = (fields: BusinessBenchmarkCase) => assistScope(businessRequest(fields));

/** Adapter for the original business Assist owner. It never adopts an output or writes business facts. */
@Injectable()
export class KnowledgeBenchmarkBusinessService {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(AssistService) private readonly assists: AssistService,
    @Inject(AssistTaskWorkspaceService) private readonly tasks: AssistTaskWorkspaceService,
  ) {}

  private async current(ceiling: TenantContext, role: BusinessRole, operation: "read" | "run" = "read") {
    return withTenant(this.database.db, ceiling, async tx => {
      const current = await currentEvaluationContext(tx, ceiling, operation);
      const bits = [Permission.WorkflowRead, ...requiredAssistPermissions(role, operation === "run" ? "run" : "read")];
      if (operation === "run") bits.push(Permission.WorkflowRun, Permission.WorkflowManage);
      for (const bit of bits) authorize(current, bit);
      const scope = bits.map(bit => permissionScope(current, bit)).reduce((a, b) => rank[a] < rank[b] ? a : b, ceiling.dataScope);
      assertBusinessBenchmarkScope(current, scope, role);
      return { ...current, dataScope: scope };
    });
  }

  async targets(ceiling: TenantContext, raw: unknown) {
    const query = BusinessBenchmarkTargetQuerySchema.parse(raw), current = await this.current(ceiling, query.kind);
    if (newRole(query.kind)) return withTenant(this.database.db, ceiling, async tx => {
      const fresh = await currentEvaluationContext(tx, ceiling);
      assertEvaluationScope(fresh, current.dataScope, "read");
      assertBusinessBenchmarkScope(fresh, current.dataScope, query.kind);
      return AssistTaskTargetsSchema.parse(await this.tasks.targets(fresh, query, true, tx));
    }, { isolationLevel: "repeatable read", accessMode: "read write" });
    const result = AssistTaskTargetsSchema.parse(await this.tasks.targets(current, query, newRole(query.kind)));
    return withTenant(this.database.db, ceiling, async tx => {
      const fresh = await currentEvaluationContext(tx, ceiling);
      assertEvaluationScope(fresh, current.dataScope, "read");
      assertBusinessBenchmarkScope(fresh, current.dataScope, query.kind);
      if (query.kind !== "procurement_review") return result;
      const pairs = result.items.map(item => item.id.split(":"));
      const stocks = pairs.length ? await tx.select({ id: inventoryStockItems.id, createdBy: inventoryStockItems.createdBy }).from(inventoryStockItems)
        .where(inArray(inventoryStockItems.id, pairs.map(pair => pair[0]!))) : [];
      const locations = pairs.length ? await tx.select({ id: inventoryLocations.id, createdBy: inventoryLocations.createdBy }).from(inventoryLocations)
        .where(inArray(inventoryLocations.id, pairs.map(pair => pair[1]!))) : [];
      return AssistTaskTargetsSchema.parse({ ...result, items: result.items.filter(item => {
        const [stockId, locationId] = item.id.split(":"), stock = stocks.find(row => row.id === stockId), location = locations.find(row => row.id === locationId);
        if (!stock || !location) return false;
        try {
          authorize(fresh, Permission.InventoryRead, { ownerId: stock.createdBy });
          authorize(fresh, Permission.InventoryRead, { ownerId: location.createdBy });
          return true;
        } catch (error) { if (error instanceof ForbiddenError) return false; throw error; }
      }) });
    }, { isolationLevel: "repeatable read", accessMode: "read write" });
  }

  async basis(ceiling: TenantContext, raw: unknown) {
    const input = BusinessBenchmarkBasisRequestSchema.parse(raw), current = await this.current(ceiling, input.kind, "run");
    let fixed: AssistContext | undefined;
    const value = AssistTaskBasisSchema.parse(await this.tasks.basis(current, input, newRole(input.kind), prepared => { fixed = prepared; }));
    await withTenant(this.database.db, ceiling, async tx => {
      const fresh = await currentEvaluationContext(tx, ceiling, "run");
      assertEvaluationScope(fresh, current.dataScope, "run");
      assertBusinessBenchmarkScope(fresh, current.dataScope, input.kind);
      if (!BUSINESS_BENCHMARK_ROLES.some(role => role === value.input.kind) ||
        !value.input.expectedTaskFingerprint || value.input.expectedTaskFingerprint !== value.fingerprint) throw new ConflictException("benchmark_business_role_invalid");
      await assertBusinessBenchmarkResources(tx, fresh, [value.input as BusinessBenchmarkCase["task"]], fixed?.benchmarkResources, fixed?.benchmarkResources ? "run" : "metadata");
    });
    return value;
  }

  async prepare(ceiling: TenantContext, fields: BusinessBenchmarkCase, expiresAt: Date) {
    const current = await this.current(ceiling, fields.role, "run");
    assertEvaluationScope(current, ceiling.dataScope, "run");
    assertBusinessBenchmarkScope(current, ceiling.dataScope, fields.role);
    const prepared = await this.assists.preparePinnedBusiness({ ...current, dataScope: ceiling.dataScope }, businessRequest(fields));
    prepared.expiresAt = new Date(Math.min(expiresAt.getTime(), prepared.expiresAt ? Date.parse(prepared.expiresAt) : expiresAt.getTime())).toISOString();
    try { businessBenchmarkSourcePins(prepared); }
    catch { throw new ConflictException("benchmark_business_sources_invalid"); }
    return { prepared, dataScope: ceiling.dataScope,
      basisFingerprint: businessBenchmarkBasisFingerprint(fields, prepared), taskFingerprint: assistTaskFingerprint(prepared) };
  }

  async assertInTransaction(tx: TenantTransaction, current: TenantContext, prepared: AssistContext) {
    if (!BUSINESS_BENCHMARK_ROLES.some(role => role === prepared.request.kind) || prepared.request.kind === "knowledge_answer")
      throw new ConflictException("benchmark_business_role_invalid");
    if (!prepared.accessPolicy?.dataScope) throw new ConflictException("benchmark_basis_unavailable");
    assertBusinessBenchmarkScope(current, prepared.accessPolicy.dataScope, prepared.request.kind);
    await assertBusinessBenchmarkResources(tx, current, [prepared.request as BusinessBenchmarkCase["task"]], prepared.benchmarkResources, newRole(prepared.request.kind) ? "run" : "metadata");
    await this.assists.assertPinnedBusinessInTransaction(tx, current, prepared);
  }

  start(context: TenantContext, itemId: string, prepared: AssistContext, modelId: string, requestId: string, admission: Omit<AssistOwnerAdmission, "prepared" | "benchmarkItemId">) {
    return this.assists.create(context, { ...prepared.request, modelId, requestId }, {
      ...admission, benchmarkItemId: itemId, prepared: async request => ({ ...prepared, request }),
    });
  }

  /** Corresponding owning reader: only the exact native receipt and its original ciphertext, never today's preview. */
  async resultInTransaction(tx: TenantTransaction, current: TenantContext, vault: SecretVault, input: {
    nativeRunId: string; itemId: string; fields: BusinessBenchmarkCase; caseChecksum: string;
    basisFingerprint: string; taskFingerprint: string; sourcePins: ReturnType<typeof businessBenchmarkSourcePins>;
    dataScope: TenantContext["dataScope"]; modelId: string; requestId: string; outputChecksum: string; expiresAt: Date;
  }) {
    assertEvaluationScope(current, input.dataScope, "read");
    assertBusinessBenchmarkScope(current, input.dataScope, input.fields.role);
    const first = input.sourcePins[0], bindings = first && "kind" in first ? first.resourceBindings : undefined;
    await assertBusinessBenchmarkResources(tx, current, [input.fields.task], bindings);
    const [row] = await tx.select({ id: aiAssistRuns.id, ownerId: aiAssistRuns.ownerId, requestId: aiAssistRuns.requestId,
      benchmarkItemId: aiAssistRuns.benchmarkItemId, kind: aiAssistRuns.kind, scope: aiAssistRuns.scope,
      promptVersion: aiAssistRuns.promptVersion,
      inputFingerprint: aiAssistRuns.inputFingerprint, modelSnapshot: aiAssistRuns.modelSnapshot, status: aiAssistRuns.status,
      encryptedInput: aiAssistRuns.encryptedInput, encryptedOutput: aiAssistRuns.encryptedOutput, expiresAt: aiAssistRuns.expiresAt,
    }).from(aiAssistRuns).where(and(eq(aiAssistRuns.id, input.nativeRunId), eq(aiAssistRuns.ownerId, current.userId)));
    if (!row) throw new NotFoundException("benchmark_native_receipt_invalid");
    if (row.expiresAt <= new Date() || input.expiresAt <= new Date() || !row.encryptedInput || !row.encryptedOutput || row.status !== "completed") return null;
    try {
      const prepared = await vault.withSecret(row.encryptedInput, value => JSON.parse(value) as AssistContext);
      if (row.benchmarkItemId !== input.itemId || row.kind !== input.fields.role || row.requestId !== input.requestId ||
        row.modelSnapshot.id !== input.modelId || row.promptVersion !== assistPromptVersion(false, row.kind === "order_review") || row.expiresAt > input.expiresAt || row.scope !== assistScope(prepared.request) ||
        row.inputFingerprint !== assistFingerprint(prepared) || prepared.request.modelId !== input.modelId ||
        prepared.request.requestId !== input.requestId || prepared.request.kind !== input.fields.role ||
        prepared.benchmarkExecutionVersion || prepared.accessPolicy?.dataScope !== input.dataScope ||
        !prepared.expiresAt || Date.parse(prepared.expiresAt) <= Date.now() ||
        businessBenchmarkCaseChecksum(input.fields) !== input.caseChecksum ||
        businessBenchmarkBasisFingerprint(input.fields, prepared) !== input.basisFingerprint ||
        assistTaskFingerprint(prepared) !== input.taskFingerprint ||
        knowledgeEvaluationChecksum(businessBenchmarkSourcePins(prepared)) !== knowledgeEvaluationChecksum(input.sourcePins))
        throw new Error("benchmark_native_receipt_invalid");
      await assertBusinessBenchmarkResources(tx, current, [input.fields.task], prepared.benchmarkResources, newRole(input.fields.role) ? "content" : "metadata");
      if (newRole(input.fields.role) && !await isPinnedAssistGuidanceCurrentInTransaction(tx, current, prepared)) return null;
      const body = await vault.withSecret(row.encryptedOutput, value => JSON.parse(value) as { result: unknown });
      const result = assistResultSchema(false, row.kind === "order_review").parse(body.result);
      if (knowledgeEvaluationChecksum(result) !== input.outputChecksum) throw new Error("benchmark_result_invalid");
      return result;
    } catch (error) { if (error instanceof ForbiddenError) throw error; throw new ConflictException("benchmark_result_unavailable"); }
  }
}
