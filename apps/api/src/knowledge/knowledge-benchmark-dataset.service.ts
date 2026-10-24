import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { createHash } from "node:crypto";
import { authorize, ForbiddenError, Permission, permissionScope } from "@yummyai/authz";
import { assistTaskFingerprint, businessBenchmarkBasisFingerprint, businessBenchmarkCaseChecksum, businessBenchmarkSourcePins, knowledgeEvaluationChecksum, openBenchmarkValue, sealBenchmarkValue, type AssistContext, type SecretVault } from "@yummyai/ai-core";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import {
  BenchmarkCommandReceiptSchema, BenchmarkDatasetPageSchema, BenchmarkDatasetSchema,
  BenchmarkDatasetSummarySchema, BenchmarkItemSchema, BenchmarkPageQuerySchema,
  BenchmarkReceiptSchema, BenchmarkVersionPageSchema, BenchmarkVersionSchema,
  BenchmarkVersionSummarySchema, PublishBenchmarkDatasetSchema, SaveBenchmarkDatasetSchema,
  LEGACY_BUSINESS_BENCHMARK_ROLES,
  benchmarkCommandCanonical, benchmarkCaseHasProducts, type BenchmarkCase, type BenchmarkDatasetFields, type BenchmarkOperation,
} from "@yummyai/contracts/knowledge/benchmark";
import {
  knowledgeBenchmarkDatasets as datasets, knowledgeBenchmarkVersions as versions,
  knowledgeBenchmarkItems as items, knowledgeBenchmarkCommands as commands,
  knowledgeEvaluationCases as cases, withTenant,
  type DatabaseConnection, type TenantTransaction,
} from "@yummyai/database";
import { assertEvaluationScope, currentEvaluationContext } from "@yummyai/knowledge-core";
import { and, desc, eq, getTableColumns, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { AI_ASSIST_VAULT, DATABASE_CONNECTION } from "../platform.tokens.js";
import { KnowledgeEvaluationService } from "./knowledge-evaluation.service.js";
import { recordKnowledgeGovernanceEvent } from "./knowledge-import.service.js";
import { assertBusinessBenchmarkResources, assertBusinessBenchmarkScope, businessBenchmarkPermissions, KnowledgeBenchmarkBusinessService } from "./knowledge-benchmark-business.service.js";
import { isPinnedAssistGuidanceCurrentInTransaction } from "../ai/assist-context.service.js";

export type { BenchmarkOperation } from "@yummyai/contracts/knowledge/benchmark";
export type BenchmarkReceipt = z.infer<typeof BenchmarkReceiptSchema>;
export type BenchmarkPageQuery = z.infer<typeof BenchmarkPageQuerySchema>;
export const benchmarkChecksum = knowledgeEvaluationChecksum;
export const benchmarkRequestChecksum = (operation: BenchmarkOperation, parentId: string | null, input: unknown) =>
  createHash("sha256").update(benchmarkCommandCanonical(operation, parentId, input)).digest("hex");
export const benchmarkReadOptions = { isolationLevel: "repeatable read", accessMode: "read write" } as const;
export const benchmarkInput = <T>(schema: z.ZodType<T>, raw: unknown): T => {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new BadRequestException("benchmark_input_invalid");
  return parsed.data;
};
export const benchmarkId = (raw: string) => benchmarkInput(z.uuidv7().transform(value => value.toLowerCase()), raw);
export const benchmarkHasProducts = (fields: BenchmarkDatasetFields) => fields.items.some(benchmarkCaseHasProducts);
export function assertBenchmarkFieldsScope(context: TenantContext, scope: TenantContext["dataScope"], fields: BenchmarkCase[], operation: "read" | "run" | "review" | "manage" = "read") {
  assertBenchmarkScope(context, scope, operation, fields.some(benchmarkCaseHasProducts));
  for (const item of fields) if (item.role !== "knowledge_answer") assertBusinessBenchmarkScope(context, scope, item.role);
}
export function benchmarkCasePermissions(fields: BenchmarkCase[]) {
  return [...new Set(fields.flatMap(item => item.role === "knowledge_answer" ? [] : businessBenchmarkPermissions(item.role)))];
}
async function assertBenchmarkResources(tx: TenantTransaction, context: TenantContext, fields: BenchmarkCase[]) {
  for (const item of fields) if (item.role !== "knowledge_answer") await assertBusinessBenchmarkResources(tx, context, [item.task]);
}
type BenchmarkBasisValue = { tenantId: string; createdBy: string; itemId: string; versionId: string; caseId: string | null;
  caseChecksum: string; basisFingerprint: string; taskFingerprint: string; expiresAt: string; prepared: AssistContext };
export function readBenchmarkBasis(vault: SecretVault, row: typeof items.$inferSelect): AssistContext {
  if (!row.encryptedBasis) throw new ConflictException("benchmark_basis_unavailable");
  try {
    const value = openBenchmarkValue<BenchmarkBasisValue>(vault, "basis", row.encryptedBasis);
    if (value.tenantId !== row.tenantId || value.createdBy !== row.createdBy || value.itemId !== row.id || value.versionId !== row.versionId ||
      value.caseId !== row.caseId || value.caseChecksum !== row.caseChecksum || value.basisFingerprint !== row.basisFingerprint ||
      value.taskFingerprint !== row.taskFingerprint || value.expiresAt !== row.expiresAt.toISOString() ||
      assistTaskFingerprint(value.prepared) !== row.taskFingerprint)
      throw new Error("benchmark_basis_invalid");
    if (row.fields.role === "knowledge_answer") {
      if (!row.caseId || value.caseChecksum !== benchmarkChecksum(row.fields.evaluation) || value.prepared.request.kind !== "knowledge_answer" ||
        value.prepared.request.purpose !== "evaluation" || value.prepared.request.scopeId !== row.caseId) throw new Error("benchmark_basis_invalid");
    } else if (row.caseId !== null || value.prepared.benchmarkExecutionVersion || value.prepared.request.kind !== row.fields.role ||
      value.caseChecksum !== businessBenchmarkCaseChecksum(row.fields) || businessBenchmarkBasisFingerprint(row.fields, value.prepared) !== row.basisFingerprint ||
      benchmarkChecksum(businessBenchmarkSourcePins(value.prepared)) !== benchmarkChecksum(row.sourcePins)) throw new Error("benchmark_basis_invalid");
    return value.prepared;
  } catch { throw new ConflictException("benchmark_basis_unavailable"); }
}
/** The original basis is authenticated only to judge current usability; no body leaves this reader. */
export async function benchmarkGuidanceCurrentInTransaction(tx: TenantTransaction, context: TenantContext, vault: SecretVault,
  item: typeof items.$inferSelect, options: { lock?: boolean } = {}): Promise<boolean> {
  if (item.fields.role === "knowledge_answer" || LEGACY_BUSINESS_BENCHMARK_ROLES.some(role => role === item.fields.role)) return true;
  if (item.expiresAt <= new Date()) return false;
  const [body] = await tx.select({ encryptedBasis: items.encryptedBasis }).from(items)
    .where(and(eq(items.id, item.id), eq(items.versionId, item.versionId), eq(items.createdBy, context.userId)));
  if (!body?.encryptedBasis) return false;
  let prepared: AssistContext;
  try { prepared = readBenchmarkBasis(vault, { ...item, encryptedBasis: body.encryptedBasis }); }
  catch (error) { if (error instanceof ConflictException) return false; throw error; }
  return isPinnedAssistGuidanceCurrentInTransaction(tx, context, prepared, options);
}
export function assertBenchmarkScope(context: TenantContext, scope: TenantContext["dataScope"], operation: "read" | "run" | "review" | "manage", hasProducts = false) {
  assertEvaluationScope(context, scope, operation === "manage" ? "read" : operation, hasProducts);
  if (operation === "manage") {
    authorize(context, Permission.WorkflowManage);
    if (scopeRank[permissionScope(context, Permission.WorkflowManage)] < scopeRank[scope])
      throw new ForbiddenError(Permission.WorkflowManage, "outside_data_scope");
  }
}
const scopeRank = { self: 0, team: 1, tenant: 2 };
export function benchmarkDataScope(context: TenantContext, permissions: Permission[], hasProducts = false): TenantContext["dataScope"] {
  const required = [Permission.WorkflowRead, ...permissions, ...(hasProducts ? [Permission.ProductRead] : [])];
  for (const permission of required) authorize(context, permission);
  return required.map(permission => permissionScope(context, permission)).reduce((smallest, value) => scopeRank[value] < scopeRank[smallest] ? value : smallest, "tenant");
}
export async function currentBenchmarkContext(tx: TenantTransaction, ceiling: TenantContext, operation: "read" | "run" | "review" | "manage" = "read") {
  return currentEvaluationContext(tx, ceiling, operation);
}
export async function lockBenchmarkRequest(tx: TenantTransaction, context: TenantContext, requestId: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`knowledge-benchmark-request:${context.tenantId}:${requestId}`},0))`);
}
export async function replayBenchmarkCommand(tx: TenantTransaction, context: TenantContext, operation: BenchmarkOperation, parentId: string | null, input: { requestId: string }) {
  await lockBenchmarkRequest(tx, context, input.requestId);
  const [prior] = await tx.select().from(commands).where(eq(commands.requestId, input.requestId));
  if (!prior) return null;
  const requestChecksum = benchmarkRequestChecksum(operation, parentId, input);
  if (prior.createdBy !== context.userId || prior.operation !== operation || prior.parentId !== parentId || prior.requestChecksum !== requestChecksum)
    throw new ConflictException("benchmark_request_conflict");
  assertBenchmarkScope(context, prior.dataScope, operationPermission(operation));
  if (operation === "dataset.publish") assertBenchmarkScope(context, prior.dataScope, "review");
  assertBenchmarkCommandDomain(context, prior);
  return BenchmarkReceiptSchema.parse(prior.receipt);
}
export async function recordBenchmarkCommand(tx: TenantTransaction, context: TenantContext, operation: BenchmarkOperation, parentId: string | null,
  input: { requestId: string }, receipt: BenchmarkReceipt, dataScope: TenantContext["dataScope"], createdAt: Date) {
  const [row] = await tx.insert(commands).values({ id: createEntityId(), tenantId: context.tenantId, createdBy: context.userId,
    creationTransactionId: "0", createdAt, requestId: input.requestId, operation, parentId, dataScope, receipt,
    requestChecksum: benchmarkRequestChecksum(operation, parentId, input) }).onConflictDoNothing().returning({ id: commands.id });
  if (!row) throw new ConflictException("benchmark_request_conflict");
}
function operationPermission(operation: string): "read" | "run" | "review" | "manage" {
  if (["dataset.create", "dataset.save"].includes(operation)) return "manage";
  if (["dataset.publish", "experiment.create", "attempt.start"].includes(operation)) return "run";
  if (["attempt.review", "expense.record", "report.create"].includes(operation)) return "review";
  throw new ConflictException("benchmark_request_invalid");
}
function assertBenchmarkCommandDomain(context: TenantContext, command: typeof commands.$inferSelect) {
  // Minted by the DB from this command's actual birth result. A mutable draft's
  // present fields cannot reinterpret an old request's authorization domain.
  for (const role of command.businessRoles) assertBusinessBenchmarkScope(context, command.dataScope, role);
}
export function benchmarkDatasetSummary(row: typeof datasets.$inferSelect) {
  return BenchmarkDatasetSummarySchema.parse({ id: row.id, revision: row.revision, name: row.fields.name,
    itemCount: row.fields.items.length, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() });
}
export function benchmarkVersionSummary(row: typeof versions.$inferSelect) {
  return BenchmarkVersionSummarySchema.parse({ id: row.id, datasetId: row.datasetId, version: row.version, datasetRevision: row.datasetRevision,
    name: row.name, checksum: row.checksum, itemCount: row.itemCount, dataScope: row.dataScope,
    createdAt: row.createdAt.toISOString(), basisExpiresAt: row.basisExpiresAt.toISOString() });
}
export async function requireBenchmarkDataset(tx: TenantTransaction, context: TenantContext, id: string, operation: "read" | "manage" | "run" = "read") {
  const [row] = await tx.select().from(datasets).where(and(eq(datasets.id, id), eq(datasets.createdBy, context.userId)));
  if (!row) throw new NotFoundException("benchmark_dataset_not_found");
  assertBenchmarkFieldsScope(context, row.dataScope, row.fields.items, operation);
  await assertBenchmarkResources(tx, context, row.fields.items);
  return row;
}
export async function requireBenchmarkVersion(tx: TenantTransaction, context: TenantContext, id: string, operation: "read" | "run" = "read", includeBasis = false) {
  const [row] = await tx.select().from(versions).where(and(eq(versions.id, id), eq(versions.createdBy, context.userId)));
  if (!row) throw new NotFoundException("benchmark_version_not_found");
  const itemRows = await tx.select({ ...getTableColumns(items),
    encryptedBasis: includeBasis ? items.encryptedBasis : sql<null>`null`, basisRetained: sql<boolean>`${items.encryptedBasis} is not null`,
  }).from(items).where(eq(items.versionId, row.id)).orderBy(items.ordinal);
  assertBenchmarkFieldsScope(context, row.dataScope, itemRows.map(item => item.fields), operation);
  for (const item of itemRows) if (item.fields.role !== "knowledge_answer") {
    const pin = item.sourcePins[0], bindings = pin && "kind" in pin ? pin.resourceBindings : undefined;
    if (!LEGACY_BUSINESS_BENCHMARK_ROLES.some(role => role === item.fields.role) && !bindings) throw new ConflictException("benchmark_basis_unavailable");
    await assertBusinessBenchmarkResources(tx, context, [item.fields.task], bindings);
  }
  if (itemRows.length !== row.itemCount || itemRows.some((item, ordinal) => item.ordinal !== ordinal || item.createdBy !== context.userId))
    throw new ConflictException("benchmark_version_incomplete");
  return { row, items: itemRows };
}

@Injectable()
export class KnowledgeBenchmarkDatasetService {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(KnowledgeEvaluationService) private readonly evaluations: KnowledgeEvaluationService,
    @Inject(AI_ASSIST_VAULT) private readonly vault: SecretVault,
    @Inject(KnowledgeBenchmarkBusinessService) private readonly business?: KnowledgeBenchmarkBusinessService,
  ) {}

  async request(ceiling: TenantContext, rawId: string) {
    const requestId = benchmarkInput(z.uuid().transform(value => value.toLowerCase()), rawId);
    return withTenant(this.database.db, ceiling, async tx => {
      const current = await currentBenchmarkContext(tx, ceiling);
      const [row] = await tx.select().from(commands).where(and(eq(commands.requestId, requestId), eq(commands.createdBy, current.userId)));
      if (!row) throw new NotFoundException("benchmark_request_not_found");
      assertBenchmarkScope(current, row.dataScope, operationPermission(row.operation));
      if (row.operation === "dataset.publish") assertBenchmarkScope(current, row.dataScope, "review");
      assertBenchmarkCommandDomain(current, row);
      return BenchmarkCommandReceiptSchema.parse({ requestId: row.requestId, operation: row.operation, parentId: row.parentId,
        requestChecksum: row.requestChecksum, receipt: row.receipt, createdAt: row.createdAt.toISOString() });
    }, benchmarkReadOptions);
  }

  async list(ceiling: TenantContext, raw: unknown = {}) {
    const query = benchmarkInput(BenchmarkPageQuerySchema, raw);
    return withTenant(this.database.db, ceiling, async tx => {
      const current = await currentBenchmarkContext(tx, ceiling);
      if (query.cursor) await requireBenchmarkDataset(tx, current, query.cursor);
      const rows = await tx.select().from(datasets).where(and(eq(datasets.createdBy, current.userId), query.cursor ? lt(datasets.id, query.cursor) : undefined))
        .orderBy(desc(datasets.id)).limit(query.limit + 1);
      const [count] = await tx.select({ total: sql<number>`count(*)::int` }).from(datasets).where(eq(datasets.createdBy, current.userId));
      for (const row of rows) {
        assertBenchmarkFieldsScope(current, row.dataScope, row.fields.items);
        await assertBenchmarkResources(tx, current, row.fields.items);
      }
      return BenchmarkDatasetPageSchema.parse({ items: rows.slice(0, query.limit).map(benchmarkDatasetSummary),
        nextCursor: rows.length > query.limit ? rows[query.limit - 1]!.id : null, total: count!.total });
    }, benchmarkReadOptions);
  }

  async get(ceiling: TenantContext, rawId: string) {
    return withTenant(this.database.db, ceiling, async tx => {
      const current = await currentBenchmarkContext(tx, ceiling);
      const row = await requireBenchmarkDataset(tx, current, benchmarkId(rawId));
      return BenchmarkDatasetSchema.parse({ ...benchmarkDatasetSummary(row), fields: row.fields });
    }, benchmarkReadOptions);
  }

  async save(ceiling: TenantContext, rawId: string | null, raw: unknown) {
    const input = benchmarkInput(SaveBenchmarkDatasetSchema, raw), id = rawId === null ? null : benchmarkId(rawId);
    const operation = id ? "dataset.save" : "dataset.create";
    return withTenant(this.database.db, ceiling, async tx => {
      const current = await currentBenchmarkContext(tx, ceiling, "manage");
      const replay = await replayBenchmarkCommand(tx, current, operation, id, input);
      if (replay) return replay;
      const dataScope = benchmarkDataScope(current, [Permission.WorkflowManage, ...benchmarkCasePermissions(input.fields.items)], benchmarkHasProducts(input.fields));
      assertBenchmarkFieldsScope(current, dataScope, input.fields.items, "manage");
      await assertBenchmarkResources(tx, current, input.fields.items);
      const createdAt = new Date();
      let receipt: BenchmarkReceipt;
      if (!id) {
        if (input.expectedRevision !== 0) throw new ConflictException("benchmark_dataset_changed");
        receipt = { id: createEntityId(), revision: 1 };
        await tx.insert(datasets).values({ id: receipt.id, tenantId: current.tenantId, createdBy: current.userId, creationTransactionId: "0",
          createdAt, updatedAt: createdAt, revision: 1, fields: input.fields, dataScope });
      } else {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`knowledge-benchmark-dataset:${current.tenantId}:${id}`},0))`);
        const row = await requireBenchmarkDataset(tx, current, id, "manage");
        if (row.revision !== input.expectedRevision) throw new ConflictException("benchmark_dataset_changed");
        receipt = { id, revision: row.revision + 1 };
        const [updated] = await tx.update(datasets).set({ fields: input.fields, revision: receipt.revision, updatedAt: createdAt })
          .where(and(eq(datasets.id, id), eq(datasets.revision, row.revision))).returning({ id: datasets.id });
        if (!updated) throw new ConflictException("benchmark_dataset_changed");
      }
      await recordKnowledgeGovernanceEvent(tx, current, receipt.id, `benchmark.${operation}`, input.reason, { revision: receipt.revision });
      await recordBenchmarkCommand(tx, current, operation, id, input, receipt, id ? (await requireBenchmarkDataset(tx, current, id)).dataScope : dataScope, createdAt);
      return receipt;
    });
  }

  async versions(ceiling: TenantContext, rawId: string, raw: unknown = {}) {
    const id = benchmarkId(rawId), query = benchmarkInput(BenchmarkPageQuerySchema, raw);
    return withTenant(this.database.db, ceiling, async tx => {
      const current = await currentBenchmarkContext(tx, ceiling);
      await requireBenchmarkDataset(tx, current, id);
      if (query.cursor) {
        const cursor = await requireBenchmarkVersion(tx, current, query.cursor);
        if (cursor.row.datasetId !== id) throw new NotFoundException("benchmark_cursor_not_found");
      }
      const rows = await tx.select().from(versions).where(and(eq(versions.datasetId, id), query.cursor ? lt(versions.id, query.cursor) : undefined))
        .orderBy(desc(versions.id)).limit(query.limit + 1);
      const [count] = await tx.select({ total: sql<number>`count(*)::int` }).from(versions).where(eq(versions.datasetId, id));
      for (const row of rows) await requireBenchmarkVersion(tx, current, row.id);
      return BenchmarkVersionPageSchema.parse({ items: rows.slice(0, query.limit).map(benchmarkVersionSummary),
        nextCursor: rows.length > query.limit ? rows[query.limit - 1]!.id : null, total: count!.total });
    }, benchmarkReadOptions);
  }

  async version(ceiling: TenantContext, rawId: string) {
    return withTenant(this.database.db, ceiling, async tx => {
      const current = await currentBenchmarkContext(tx, ceiling);
      const value = await requireBenchmarkVersion(tx, current, benchmarkId(rawId));
      const usability = new Map<string, boolean>();
      for (const item of value.items) usability.set(item.id, await benchmarkGuidanceCurrentInTransaction(tx, current, this.vault, item));
      const manifestFields = value.row.manifest.fields;
      const description = manifestFields && typeof manifestFields === "object" && !Array.isArray(manifestFields) && "description" in manifestFields ? manifestFields.description : undefined;
      return BenchmarkVersionSchema.parse({ ...benchmarkVersionSummary(value.row), ...(typeof description === "string" ? { description } : {}), items: value.items.map(item => BenchmarkItemSchema.parse({
        id: item.id, versionId: item.versionId, caseId: item.caseId, ordinal: item.ordinal, fields: item.fields,
        caseChecksum: item.caseChecksum, basisFingerprint: item.basisFingerprint, taskFingerprint: item.taskFingerprint,
        sourcePins: item.sourcePins, method: item.method, expiresAt: item.expiresAt.toISOString(), usable: item.basisRetained && item.expiresAt > new Date() && usability.get(item.id) === true,
      })) });
    }, benchmarkReadOptions);
  }

  async publish(ceiling: TenantContext, rawId: string, raw: unknown) {
    const id = benchmarkId(rawId), input = benchmarkInput(PublishBenchmarkDatasetSchema, raw);
    const initial = await withTenant(this.database.db, ceiling, async tx => {
      const current = await currentBenchmarkContext(tx, ceiling, "run");
      authorize(current, Permission.WorkflowApprove);
      const replay = await replayBenchmarkCommand(tx, current, "dataset.publish", id, input);
      if (replay) { assertBenchmarkScope(current, (await requireBenchmarkDataset(tx, current, id)).dataScope, "review"); return { replay, current, dataset: null }; }
      const dataset = await requireBenchmarkDataset(tx, current, id, "run");
      assertBenchmarkScope(current, dataset.dataScope, "review", benchmarkHasProducts(dataset.fields));
      if (dataset.revision !== input.expectedRevision) throw new ConflictException("benchmark_dataset_changed");
      if (dataset.fields.items.length < 2) throw new ConflictException("benchmark_multiple_items_required");
      const scope = benchmarkDataScope(current, [Permission.WorkflowManage, Permission.WorkflowRun, Permission.WorkflowApprove,
        ...benchmarkCasePermissions(dataset.fields.items)], benchmarkHasProducts(dataset.fields));
      return { replay: null, current: { ...current, dataScope: scope }, dataset };
    });
    if (initial.replay) return initial.replay;
    const dataset = initial.dataset!;
    const expiresAt = new Date(Date.now() + input.retentionDays * 86_400_000);
    const preparedItems: Array<{ id: string; caseId: string | null; ordinal: number; fields: BenchmarkCase } &
      Awaited<ReturnType<KnowledgeEvaluationService["prepareBenchmarkItem"]>>> = [];
    for (const [ordinal, fields] of dataset.fields.items.entries()) {
      const caseId = fields.role === "knowledge_answer" ? createEntityId() : null, itemId = createEntityId();
      if (fields.role !== "knowledge_answer" && !this.business) throw new ConflictException("benchmark_business_adapter_unavailable");
      const captured = fields.role === "knowledge_answer" ? await this.evaluations.prepareBenchmarkItem(initial.current, caseId!, fields, expiresAt) :
        await this.business!.prepare(initial.current, fields, expiresAt);
      preparedItems.push({ id: itemId, caseId, ordinal, fields, ...captured });
    }
    return withTenant(this.database.db, ceiling, async tx => {
      const current = await currentBenchmarkContext(tx, ceiling, "run");
      authorize(current, Permission.WorkflowApprove);
      const replay = await replayBenchmarkCommand(tx, current, "dataset.publish", id, input);
      if (replay) return replay;
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`knowledge-benchmark-dataset:${current.tenantId}:${id}`},0))`);
      const latest = await requireBenchmarkDataset(tx, current, id, "run");
      assertBenchmarkScope(current, latest.dataScope, "review", benchmarkHasProducts(latest.fields));
      if (latest.revision !== input.expectedRevision || benchmarkChecksum(latest.fields) !== benchmarkChecksum(dataset.fields))
        throw new ConflictException("benchmark_dataset_changed");
      const [previous] = await tx.select().from(versions).where(eq(versions.datasetId, id)).orderBy(desc(versions.version)).limit(1);
      const versionId = createEntityId(), createdAt = new Date(), versionNumber = (previous?.version ?? 0) + 1;
      const pinnedItems = [];
      for (const captured of preparedItems) {
        if (captured.fields.role === "knowledge_answer") await this.evaluations.assertBenchmarkItemInTransaction(tx, current, captured.prepared);
        else {
          if (!this.business) throw new ConflictException("benchmark_business_adapter_unavailable");
          await this.business.assertInTransaction(tx, current, captured.prepared);
        }
        const itemExpiresAt = new Date(Math.min(expiresAt.getTime(), captured.prepared.expiresAt ? Date.parse(captured.prepared.expiresAt) : expiresAt.getTime()));
        if (!Number.isFinite(itemExpiresAt.getTime()) || itemExpiresAt <= createdAt) throw new ConflictException("benchmark_basis_expired");
        pinnedItems.push({ id: captured.id, caseId: captured.caseId, ordinal: captured.ordinal, fields: captured.fields,
          caseChecksum: captured.fields.role === "knowledge_answer" ? benchmarkChecksum(captured.fields.evaluation) : businessBenchmarkCaseChecksum(captured.fields),
          basisFingerprint: captured.basisFingerprint, taskFingerprint: captured.taskFingerprint,
          sourcePins: captured.fields.role === "knowledge_answer" ? (captured.prepared.knowledge ?? []).map(source => ({ sourceId: source.sourceId, entryId: source.entryId, versionId: source.versionId,
            version: source.version, checksum: source.checksum, title: source.title })) : businessBenchmarkSourcePins(captured.prepared),
          method: captured.prepared.methodSelection ?? null, expiresAt: itemExpiresAt.toISOString() });
      }
      const dataScope = initial.current.dataScope;
      assertBenchmarkFieldsScope(current, dataScope, latest.fields.items, "run");
      assertBenchmarkFieldsScope(current, dataScope, latest.fields.items, "review");
      if (preparedItems.some(item => item.prepared.accessPolicy?.dataScope !== dataScope)) throw new ConflictException("benchmark_basis_scope_changed");
      const manifest = { version: "knowledge-benchmark-dataset-v1", fields: latest.fields, items: pinnedItems };
      const basisExpiresAt = new Date(Math.min(...pinnedItems.map(item => Date.parse(item.expiresAt))));
      await tx.insert(versions).values({ id: versionId, tenantId: current.tenantId, createdBy: current.userId, creationTransactionId: "0", createdAt,
        datasetId: id, version: versionNumber, datasetRevision: latest.revision, name: latest.fields.name,
        checksum: benchmarkChecksum(manifest), itemCount: pinnedItems.length, dataScope, basisExpiresAt, manifest });
      for (const [index, item] of pinnedItems.entries()) {
        const prepared = preparedItems[index]!.prepared;
        if (item.fields.role === "knowledge_answer" && item.caseId) await tx.insert(cases).values({ id: item.caseId, tenantId: current.tenantId, revision: 1, benchmarkVersionId: versionId, fields: item.fields.evaluation,
          requestId: createEntityId(), createdAt });
        await tx.insert(items).values({ ...item, expiresAt: new Date(item.expiresAt), versionId, tenantId: current.tenantId,
          createdBy: current.userId, creationTransactionId: "0", createdAt,
          encryptedBasis: sealBenchmarkValue(this.vault, "basis", { tenantId: current.tenantId,
            createdBy: current.userId, itemId: item.id, versionId, caseId: item.caseId,
            caseChecksum: item.caseChecksum, basisFingerprint: item.basisFingerprint, taskFingerprint: item.taskFingerprint,
            expiresAt: item.expiresAt, prepared }) });
      }
      const receipt = { id: versionId, revision: versionNumber };
      await recordKnowledgeGovernanceEvent(tx, current, versionId, "benchmark.dataset.publish", input.reason, { datasetId: id, version: versionNumber, itemCount: pinnedItems.length });
      await recordBenchmarkCommand(tx, current, "dataset.publish", id, input, receipt, dataScope, createdAt);
      return receipt;
    });
  }
}
