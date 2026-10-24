import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { ForbiddenError, Permission, ASSIST_ACCESS_POLICY_VERSION, requiredAssistPermissions } from "@yummyai/authz";
import { ASSIST_PROMPT_VERSION, assistHarness, assistTaskFingerprint, businessBenchmarkBasisFingerprint, businessBenchmarkSourcePins,
  } from "@yummyai/ai-core";
import { createEntityId } from "@yummyai/contracts";
import { CreateAssistSchema } from "@yummyai/contracts/ai/assist";
import { BenchmarkAttemptPageQuerySchema, BenchmarkCommandReceiptSchema, BusinessBenchmarkCaseSchema, ROLE_BENCHMARK_RULE_VERSION } from "@yummyai/contracts/knowledge/benchmark";
import { SalesPlanFieldsSchema } from "@yummyai/contracts/catalog/sales-plan";
import { ArtworkAuditRepository } from "@yummyai/order-design";
import { assertDatabaseMigrationsCurrent, connectDatabase, aiAssistRuns, knowledgeBenchmarkAssessments,
  knowledgeBenchmarkReviews, withTenant, loadCurrentMembershipContext, type TenantTransaction } from "@yummyai/database";
import { eq, sql } from "drizzle-orm";
import { beforeAll, afterAll, afterEach, describe, expect, it, vi } from "vitest";
import * as eventOwner from "./knowledge-import.service.js";
import { KnowledgeBenchmarkExperimentService, benchmarkAssessmentView } from "./knowledge-benchmark-experiment.service.js";
import { benchmarkRequestChecksum, recordBenchmarkCommand } from "./knowledge-benchmark-dataset.service.js";
import { expireKnowledgeBenchmarkBodiesInTenant } from "../../../worker/src/knowledge-benchmark-retention.js";
import { TeamDirectoryService } from "../auth/team-directory.service.js";
import { MethodGovernanceService } from "./method-governance.service.js";
import { roleBenchmarkFixture, roleBenchmarkGate, roleBenchmarkSha, roleEnvelope, requireRoleBenchmarkEnvironment, remainingBenchmarkRoles } from "../../../../tools/testing/role-benchmark-fixture.mjs";

requireRoleBenchmarkEnvironment("current");
const rollback = new Error("Synthetic role raw closure control rollback");
function pg(error: unknown): { code?: string; message?: string } {
  for (let depth = 0; depth < 7 && error && typeof error === "object"; depth++) {
    if ("code" in error && typeof error.code === "string") return { code: error.code, message: "message" in error ? String(error.message) : undefined };
    error = "cause" in error ? error.cause : undefined;
  }
  return {};
}

describe.sequential("six original native roles use fixed real source owners and never adopt benchmark output", () => {
  const database = connectDatabase(), f = roleBenchmarkFixture(database);
  beforeAll(async () => { await assertDatabaseMigrationsCurrent(database); await f.initialize(); });
  afterAll(async () => { try { f.close(); } finally { await database.client.end(); } });
  afterEach(async () => {
    vi.restoreAllMocks(); vi.useRealTimers(); f.controls.failQueue = false; delete f.controls.beforeQueue; delete f.controls.beforeResponse;
    await f.grant(); await f.grant(f.second);
    try {
      vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(Date.now() + 31 * 86_400_000));
      for (const row of await f.pending()) await f.processRun(row.id, row.ownerId === f.second.userId ? f.second : f.a, "expire");
    } finally { vi.useRealTimers(); }
  });
  type Scene = Awaited<ReturnType<typeof f.experiment>>;
  async function start(scene: Scene, index = 0) {
    const item = scene.version.items[index]!, cell = (await f.experiments.get(f.a.context, scene.created.id)).cells.find(row => row.itemId === item.id)!;
    const input = { itemId: item.id, expectedLatestAttemptId: cell.latestAttemptId, confirmNewPaidAttempt: true as const, requestId: randomUUID() };
    return { input, receipt: await f.experiments.start(f.a.context, scene.created.id, input) };
  }
  async function nativeCount(requestId: string) {
    return (await withTenant(database.db, f.seed(f.a), tx => tx.execute<{ attempts: number; natives: number; budgets: number; executions: number; protocols: number; starts: number }>(sql`select
      (select count(*)::int from knowledge_benchmark_attempts where request_id=${requestId}::uuid) as attempts,
      (select count(*)::int from ai_assist_runs where request_id=${requestId}::uuid) as natives,
      (select count(*)::int from ai_budget_ledger where request_id in(select id from ai_assist_runs where request_id=${requestId}::uuid)) as budgets,
      (select count(*)::int from ai_assist_executions where run_id in(select id from ai_assist_runs where request_id=${requestId}::uuid)) as executions,
      (select count(*)::int from knowledge_evaluation_protocols where run_id in(select id from knowledge_evaluation_runs where request_id=${requestId}::uuid)) as protocols,
      (select count(*)::int from knowledge_governance_events where action='benchmark.attempt.start' and resource_id in(select id from knowledge_benchmark_attempts where request_id=${requestId}::uuid)) as starts`)))[0]!;
  }
  const oneNative = { attempts: 1, natives: 1, budgets: 1, executions: 1, protocols: 0, starts: 1 };
  async function review(id: string, decision: "pass" | "needs_review" = "pass") {
    const attempt = await f.experiments.attempt(f.a.context, id);
    return f.experiments.review(f.a.context, id, { expectedReviewId: attempt.review?.id ?? null, decision, minutes: "1.250", hourlyUsd: "60.00000000",
      reason: "Synthetic operator checks original sources; model output is not artwork, buyer approval or business adoption", requestId: randomUUID() });
  }

  it("publishes twelve complete and missing six-role packets from actual scanned research, private work, parsed templates and compiled reviewed mockups", async () => {
    const calls = f.requests.length, source = await f.dataset(), before = await f.businessState(f.a.context);
    expect(source.version.items).toHaveLength(12); expect(new Set(source.version.items.map(row => row.fields.role))).toEqual(new Set(remainingBenchmarkRoles));
    for (const role of remainingBenchmarkRoles) expect(source.rows.filter(row => row.role === role).map(row => row.complete)).toEqual([true, false]);
    for (const item of source.version.items) {
      if (item.fields.role === "knowledge_answer") throw new Error("Synthetic six-role fixed dataset required");
      const prepared = await f.originalPrepared(item), pins = businessBenchmarkSourcePins(prepared);
      expect(item.caseId).toBeNull(); expect(item.taskFingerprint).toBe(assistTaskFingerprint(prepared)); expect(item.sourcePins).toEqual(pins);
      expect(item.basisFingerprint).toBe(businessBenchmarkBasisFingerprint(item.fields, prepared));
      expect(pins[0]).toMatchObject({ kind: "business", resourceBindings: prepared.benchmarkResources });
      expect(Object.keys(prepared.benchmarkResources!.permissionScopes).length).toBeGreaterThan(0);
      expect(prepared.images.every(image => image.dataUrl?.startsWith("data:image/jpeg;base64,") && image.url === undefined)).toBe(true);
      expect(prepared.artworkAudit).toBeUndefined(); expect(prepared.benchmarkExecutionVersion).toBeUndefined();
      for (const key of ["expectedFacts", "forbiddenClaims", "expectedValue", "expectRefusal"]) expect(JSON.stringify(prepared)).not.toContain(`"${key}"`);
      if (item.fields.role === "after_sales_review") expect(JSON.stringify(prepared)).not.toMatch(/PRIVATE-ROLE-SUMMARY|PRIVATE-ROLE-CONTACT|private-role@example|PRIVATE-ROLE-MESSAGE/);
    }
    const template = source.rows.find(row => row.role === "template_config" && row.complete)!;
    const parsed = await f.facts.templates.templateAnalysisBasis(f.a.context, template.targetId);
    expect(parsed).toMatchObject({ status: "completed", canvas: { dpi: 300 } }); expect(parsed.slots.length).toBeGreaterThan(0);
    const media = (await withTenant(database.db, f.a.context, tx => tx.execute<{ n: number; scanned: number }>(sql`select count(*)::int as n,
      count(*)filter(where status='archived' and scan_result->>'result'='clean' and object_key is not null)::int as scanned from capture_media`)))[0]!;
    expect(media.n).toBeGreaterThan(0); expect(media.scanned).toBe(media.n);
    const sku = source.rows.find(row => row.role === "sku_package" && row.complete)!;
    expect(await f.facts.mockups.getInspection(f.a.context, sku.ids.inspectionId!)).toMatchObject({ status: "completed", executionEvidence: "original_execution" });
    const [rights] = await withTenant(database.db, f.a.context, tx => tx.execute<{ masterId: string; masterVersion: number; masterChecksum: string;
      masterRights: Record<string, unknown>; source: Record<string, unknown>; aiGenerated: boolean; masterAiGenerated: boolean }>(sql`select
      m.id as "masterId",m.version as "masterVersion",m.checksum_sha256 as "masterChecksum",m.rights_metadata as "masterRights",
      p.rights_metadata as source,p.ai_generated as "aiGenerated",m.ai_generated as "masterAiGenerated"
      from sales_recipe_versions r join artwork_master_versions v on v.id=r.artwork_version_id and v.tenant_id=r.tenant_id
      join asset_files m on m.id=v.asset_id and m.tenant_id=v.tenant_id
      join design_version_files df on df.version_id=r.design_version_id and df.tenant_id=r.tenant_id and df.role='production'
      join asset_files p on p.id=df.asset_file_id and p.tenant_id=df.tenant_id where r.id=${sku.ids.recipeId}::uuid`));
    expect(rights).toBeDefined(); expect(rights!.source).toMatchObject({ source: { kind: "owned" }, approvedBy: f.a.userId,
      inheritedRights: expect.arrayContaining([expect.objectContaining({ assetId: rights!.masterId, version: rights!.masterVersion,
        checksumSha256: rights!.masterChecksum, rightsStatus: "approved", evidence: rights!.masterRights })]) });
    expect(rights!.source.source).not.toEqual(expect.objectContaining({ kind: "original_design" })); expect(rights!.aiGenerated).toBe(rights!.masterAiGenerated);
    const created = await f.experiments.create(f.a.context, { datasetVersionId: source.version.id, baselineVersion: ROLE_BENCHMARK_RULE_VERSION,
      modelId: f.modelId, label: "Synthetic original six-role free baseline", maxAttemptsPerItem: 2, reason: "Known input packets and explicit image limits", requestId: randomUUID() });
    const baseline = await f.experiments.attempts(f.a.context, created.id, BenchmarkAttemptPageQuerySchema.parse({ arm: "baseline", limit: 20 }));
    expect(baseline.total).toBe(12); expect(baseline.items).toHaveLength(12); expect(baseline.nextCursor).toBeNull();
    for (const row of baseline.items) {
      const actual = await f.experiments.attempt(f.a.context, row.id), item = source.version.items.find(item => item.id === actual.itemId)!;
      expect(actual).toMatchObject({ nativeRunId: null, evaluationRunId: null, state: "completed", assessment: { graderVersion: "role-benchmark-checks-v1" },
        modelCost: { amountUsd: "0.00000000", source: "not_submitted", confirmedProviderCalls: 0 } });
      expect(actual.result?.actions).toEqual([]); expect(actual.result?.typedAnswers).toBeUndefined();
      if (item.fields.role === "creative") { expect(actual.result?.directions).toEqual([]); expect(actual.assessment?.hardPass).toBe(false); }
      const original = await f.originalPrepared(item);
      if (original.images.length) expect(actual.result?.missingInformation.join(" ")).toMatch(/未读取图片像素/);
    }
    expect(f.requests).toHaveLength(calls); expect(await f.businessState(f.a.context)).toEqual(before);
  });

  it("executes all six complete and missing native kinds with original harnesses, one native budget and same-transaction sealed scores without business mutation", async () => {
    const scene = await f.experiment(), before = await f.businessState(f.a.context), calls = f.requests.length;
    for (const [index, item] of scene.version.items.entries()) {
      const prepared = await f.originalPrepared(item); let birth: Record<string, string> | undefined, queued = 0;
      f.controls.beforeQueue = async event => {
        queued++;
        birth = (await withTenant(database.db, f.a.context, tx => tx.execute<Record<string, string>>(sql`select n.creation_transaction_id::text as native,
          a.creation_transaction_id::text as attempt,e.xmin::text as execution,b.xmin::text as budget,c.creation_transaction_id::text as command
          from ai_assist_runs n join knowledge_benchmark_attempts a on a.native_run_id=n.id join ai_assist_executions e on e.run_id=n.id
          join ai_budget_ledger b on b.request_id=n.id join knowledge_benchmark_commands c on c.request_id=n.request_id where n.id=${event.id}::uuid`)))[0];
      };
      const current = await start(scene, index); delete f.controls.beforeQueue;
      expect(queued).toBe(1); expect(birth).toBeDefined(); expect(new Set(Object.values(birth!)).size).toBe(1); expect(await nativeCount(current.input.requestId)).toEqual(oneNative);
      const done = await f.complete(current.receipt.id, scene.version);
      expect(done.native.kind).toBe(item.fields.role); expect(done.native.methodSelection).toEqual(item.method); expect(done.native.request?.kind).toBe(item.fields.role);
      const expected = assistHarness(prepared.request.kind, false, requiredAssistPermissions(prepared.request.kind, "run"), ASSIST_ACCESS_POLICY_VERSION);
      expect(done.native.executionContract?.tools.map(tool => tool.key)).toEqual([expected.toolKey]); expect(done.native.executionContract?.skill.key).toBe(expected.skill.key);
      const sealed = done.attempt.assessment!; expect(sealed.graderVersion).toBe("role-benchmark-checks-v1");
      expect(sealed.checks.find(row => row.key === "fixed_media")?.status).toBe("pass");
      const [closure] = await withTenant(database.db, f.a.context, tx => tx.execute<{ ai: string; grade: string; execution: string; event: string; input: string; prompt: string }>(sql`select
        n.xmin::text as ai,g.creation_transaction_id::text as grade,e.xmin::text as execution,v.xmin::text as event,n.input_fingerprint as input,n.prompt_version as prompt
        from ai_assist_runs n join knowledge_benchmark_attempts a on a.native_run_id=n.id join knowledge_benchmark_assessments g on g.attempt_id=a.id
        join ai_assist_executions e on e.run_id=n.id join knowledge_governance_events v on v.resource_id=a.id and v.action='benchmark.assessment'
        where n.id=${done.native.id}::uuid`));
      expect(new Set([closure!.ai, closure!.grade, closure!.execution, closure!.event]).size).toBe(1); expect(closure!.prompt).toBe(ASSIST_PROMPT_VERSION);
      const provider = JSON.stringify(f.requests.at(-1)!.body);
      for (const gold of ["expectedFacts", "forbiddenClaims", "expectedValue", "benchmarkCalculations"]) expect(provider).not.toContain(gold);
      expect(provider).not.toMatch(/PRIVATE-ROLE-SUMMARY|PRIVATE-ROLE-CONTACT|private-role@example|PRIVATE-ROLE-MESSAGE/);
      for (const image of prepared.images) expect(provider).toContain(image.dataUrl!);
      await f.processRun(done.native.id); expect((await f.experiments.attempt(f.a.context, current.receipt.id)).assessment).toEqual(sealed);
    }
    expect(f.requests).toHaveLength(calls + 12); expect(await f.businessState(f.a.context)).toEqual(before);
  });

  it("keeps a real hard failure independent from human pass and charges every original attempt while pending review remains incomplete", async () => {
    const scene = await f.experiment(["creative"]), before = await f.businessState(f.a.context), first = await start(scene);
    await f.complete(first.receipt.id, scene.version); await review(first.receipt.id);
    const second = await start(scene), failed = await f.complete(second.receipt.id, scene.version, { forbidden: true }), sealed = failed.attempt.assessment;
    expect(sealed?.checks.find(row => row.key === "forbidden_claims")?.status).toBe("fail"); await review(second.receipt.id);
    expect((await f.experiments.attempt(f.a.context, second.receipt.id)).assessment).toEqual(sealed);
    expect((await f.experiments.get(f.a.context, scene.created.id)).cells[0]).toMatchObject({ latestAttemptId: second.receipt.id, hardPass: false, qualified: false });
    const third = await start(scene); await f.complete(third.receipt.id, scene.version);
    const costs = (await f.costs.summary(f.a.context, scene.created.id)).candidate;
    expect(costs).toMatchObject({ allAttempts: 3, modelKnownUsd: "0.00063000", qualifiedItems: 0, state: "incomplete", totalUsd: null });
    expect(costs.pendingReviewItems).toBeGreaterThan(0); expect(await f.businessState(f.a.context)).toEqual(before);
  });

  it("rejects foreign template stable keys and image citations through the actual paid native validator without fabricating a successful score", async () => {
    const scene = await f.experiment(["template_config", "sku_package"]), before = await f.businessState(f.a.context), calls = f.requests.length;
    for (const role of ["template_config", "sku_package"] as const) {
      const index = scene.version.items.findIndex(item => item.fields.role === role), current = await start(scene, index);
      const native = await f.experiments.attempt(f.a.context, current.receipt.id); if (!native.nativeRunId) throw new Error("Actual original native required");
      f.setOutput(await f.output(scene.version.items[index]!, role === "template_config" ? { foreignSlot: true } : { foreignEvidence: true }));
      await f.processRun(native.nativeRunId);
      const actual = await f.experiments.attempt(f.a.context, current.receipt.id);
      expect(actual.state).toBe("failed"); expect(actual.assessment).toBeNull(); expect(actual.modelCost).toMatchObject({ amountUsd: "0.00021000", confirmedProviderCalls: 1 });
      expect(await nativeCount(current.input.requestId)).toEqual(oneNative);
    }
    expect(f.requests).toHaveLength(calls + 2); expect(await f.businessState(f.a.context)).toEqual(before);
  });

  it("pins Workflow self separately from domain tenant and rejects a foreign source after only its domain scope narrows", async () => {
    const foreign = await f.facts.source(f.second.context, "template_config", true), all = Object.values(Permission);
    const workflow: Permission[] = [Permission.WorkflowRead, Permission.WorkflowManage, Permission.WorkflowRun, Permission.WorkflowApprove];
    await f.grant(f.a, workflow, "self", all.filter(bit => !workflow.includes(bit)));
    const ceiling = await withTenant(database.db, f.seed(f.a), tx => loadCurrentMembershipContext(tx, f.seed(f.a)));
    const own = (await f.sourceRows()).find(row => row.role === "template_config" && row.complete)!;
    const items = [];
    for (const [index, source] of [foreign, own].entries()) {
      const basis = await f.adapter.basis(ceiling, { kind: source.role, targetId: source.targetId, taskGoal: "Original owner-specific mixed scopes" });
      items.push(BusinessBenchmarkCaseSchema.parse({ key: `mixed_${index}`, role: source.role, label: "Synthetic original owner mixed scopes", task: basis.input, expectedFacts: [], forbiddenClaims: [], expectRefusal: false }));
    }
    const saved = await f.datasets.save(ceiling, null, { fields: { name: "Synthetic self Workflow with foreign domain source", description: "Independent per-bit scope, not one global minimum", items }, expectedRevision: 0, reason: "Synthetic actual owner scope pin", requestId: randomUUID() });
    const published = await f.datasets.publish(ceiling, saved.id, { expectedRevision: 1, retentionDays: 7, reason: "Synthetic independent Workflow and Design scopes", requestId: randomUUID() });
    const version = await f.datasets.version(ceiling, published.id); expect(version.dataScope).toBe("self");
    const original = await f.originalPrepared(version.items[0]!);
    expect(original.benchmarkResources!.permissionScopes[Permission.WorkflowRead]).toBe("self"); expect(original.benchmarkResources!.permissionScopes[Permission.DesignRead]).toBe("tenant");
    const created = await f.experiments.create(ceiling, { datasetVersionId: version.id, baselineVersion: ROLE_BENCHMARK_RULE_VERSION, modelId: f.modelId, label: "Synthetic independent-domain source",
      maxAttemptsPerItem: 2, reason: "Synthetic no scope escalation", requestId: randomUUID() });
    const input = { itemId: version.items[0]!.id, expectedLatestAttemptId: null, confirmNewPaidAttempt: true as const, requestId: randomUUID() }, receipt = await f.experiments.start(ceiling, created.id, input);
    const originalCommand = await f.datasets.request(ceiling, input.requestId);
    function assertMinimalCommand(command: typeof originalCommand, requestId: string, parentId: string, checksum: string, expectedReceipt: typeof receipt) {
      expect(BenchmarkCommandReceiptSchema.parse(command)).toEqual(command);
      expect(Object.keys(command).sort()).toEqual(["requestId", "operation", "parentId", "requestChecksum", "receipt", "createdAt"].sort());
      expect(Object.keys(command.receipt).sort()).toEqual(["id", "revision"]);
      expect(command).toMatchObject({ requestId, operation: "attempt.start", parentId, requestChecksum: checksum, receipt: expectedReceipt });
    }
    async function recoveryEffects() {
      const [audit] = await withTenant(database.db, f.seed(f.a), tx => tx.execute<{ count: number; hash: string }>(sql`select count(*)::int as count,
        md5(coalesce(jsonb_agg(to_jsonb(a) order by a.id)::text,'[]')) as hash from audit_events a`));
      return { state: await f.state(), audit, queue: f.dispatches.length, provider: f.requests.length };
    }
    const emptyNative = { attempts: 0, natives: 0, budgets: 0, executions: 0, protocols: 0, starts: 0 };
    assertMinimalCommand(originalCommand, input.requestId, created.id, benchmarkRequestChecksum("attempt.start", created.id, input), receipt);
    const state = await f.state(); await f.grant(f.a, [...workflow, Permission.DesignRead], "self", all.filter(bit => ![...workflow, Permission.DesignRead].includes(bit)));
    const narrowedEffects = await recoveryEffects(); expect(narrowedEffects.state).toEqual(state);
    for (const read of [() => f.datasets.version(ceiling, version.id), () => f.experiments.get(ceiling, created.id), () => f.experiments.attempt(ceiling, receipt.id),
      () => f.costs.summary(ceiling, created.id)])
      await expect(read()).rejects.toBeInstanceOf(ForbiddenError);
    const restoredCommand = await f.datasets.request(ceiling, input.requestId);
    assertMinimalCommand(restoredCommand, input.requestId, created.id, originalCommand.requestChecksum, receipt);
    expect(restoredCommand).toEqual(originalCommand); expect(await f.experiments.start(ceiling, created.id, input)).toEqual(receipt);
    const newInput = { ...input, expectedLatestAttemptId: receipt.id, requestId: randomUUID() };
    await expect(f.experiments.start(ceiling, created.id, newInput)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(f.experiments.start(ceiling, created.id, { ...input, expectedLatestAttemptId: receipt.id })).rejects.toMatchObject({ status: 409, message: "benchmark_request_conflict" });
    expect(await nativeCount(input.requestId)).toEqual(oneNative); expect(await nativeCount(newInput.requestId)).toEqual(emptyNative);
    expect(await recoveryEffects()).toEqual(narrowedEffects);
    await f.grant(f.a, all.filter(bit => bit !== Permission.DesignRead));
    const noDesignEffects = await recoveryEffects();
    await expect(f.datasets.request(ceiling, input.requestId)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(f.experiments.start(ceiling, created.id, input)).rejects.toBeInstanceOf(ForbiddenError);
    expect(await recoveryEffects()).toEqual(noDesignEffects);
    await f.grant(); const otherActorEffects = await recoveryEffects();
    await expect(f.datasets.request(f.second.context, input.requestId)).rejects.toMatchObject({ status: 404, message: "benchmark_request_not_found" });
    await expect(f.experiments.start(f.second.context, created.id, input)).rejects.toMatchObject({ status: 404, message: "benchmark_experiment_not_found" });
    expect(await recoveryEffects()).toEqual(otherActorEffects);
    await f.grant(); await expect(f.datasets.version({ ...ceiling, permissionScopes: { ...ceiling.permissionScopes, [Permission.DesignRead]: "self" } }, version.id)).rejects.toBeInstanceOf(ForbiddenError);
    await f.grant(f.a, [...workflow, Permission.DesignRead], "team", all.filter(bit => ![...workflow, Permission.DesignRead].includes(bit)));
    await expect(f.adapter.basis(ceiling, { kind: "template_config", targetId: foreign.targetId, taskGoal: "No trusted resource team binding" })).rejects.toThrow();
    await f.grant();
    const inspectAs = async (context: typeof f.a.context, assetId: string) => {
      const [asset] = await withTenant(database.db, context, tx => tx.execute<{ version: number }>(sql`select version from asset_files where id=${assetId}::uuid`));
      const receipt = await f.facts.templates.createTemplateSourceInspection(context, { sourceAssetId: assetId, sourceAssetVersion: asset!.version, idempotencyKey: createEntityId() });
      await f.facts.inspector.process(roleEnvelope(context, { inspectionId: receipt.id }));
      expect((await f.facts.templates.templateAnalysisBasis(context, receipt.id)).status).toBe("completed");
      return receipt;
    };
    // The real parser requester is deliberately different from the asset owner.
    const parsedByB = await inspectAs(f.second.context, own.ids.assetId!), parsedByA = await inspectAs(f.a.context, foreign.ids.assetId!);
    expect(parsedByB.requestedBy).toBe(f.second.userId); expect(parsedByA.requestedBy).toBe(f.a.userId);
    const selfBits: Permission[] = [...workflow, Permission.DesignRead, Permission.DesignWrite, Permission.AssetRead];
    await f.grant(f.a, selfBits, "self", all.filter(bit => !selfBits.includes(bit)));
    const self = await withTenant(database.db, f.seed(f.a), tx => loadCurrentMembershipContext(tx, f.seed(f.a)));
    const ownTasks = [];
    for (const [index, id] of [own.targetId, parsedByB.id].entries()) {
      const basis = await f.adapter.basis(self, { kind: "template_config", targetId: id, taskGoal: "Source owner stays self even when a colleague parsed the original asset" });
      ownTasks.push(BusinessBenchmarkCaseSchema.parse({ key: `source_owner_${index}`, role: "template_config", label: "Own source parsed by another operator", task: basis.input,
        expectedFacts: [], forbiddenClaims: [], expectRefusal: false }));
    }
    const ownSaved = await f.datasets.save(self, null, { fields: { name: "Actual source ownership, not parser identity", description: "Synthetic owner-scoped template control", items: ownTasks },
      expectedRevision: 0, reason: "Source file belongs to this actual self member", requestId: randomUUID() });
    const ownPublished = await f.datasets.publish(self, ownSaved.id, { expectedRevision: 1, retentionDays: 7, reason: "A colleague's parser request cannot change original source ownership", requestId: randomUUID() });
    expect((await f.datasets.version(self, ownPublished.id)).items).toHaveLength(2);
    const noWrite = await f.state();
    await expect(f.adapter.basis(self, { kind: "template_config", targetId: parsedByA.id, taskGoal: "Being the parser requester cannot grant ownership of another member's source" })).rejects.toBeInstanceOf(ForbiddenError);
    expect(await f.state()).toEqual(noWrite);
    await f.grant();
    const teams = new TeamDirectoryService(database), team = await teams.create(f.a.context, { name: `Synthetic actual source team ${randomUUID()}`, reason: "Actual team ownership acceptance fixture", requestId: randomUUID() });
    const members = [];
    for (const actor of [f.a, f.second]) members.push(await teams.setMember(f.a.context, team.id, { membershipId: actor.membershipId, active: true, expectedRevision: null,
      reason: "Actual trusted membership in the shared source team", requestId: randomUUID() }));
    const teammate = await withTenant(database.db, f.seed(f.second), tx => loadCurrentMembershipContext(tx, f.seed(f.second)));
    await f.facts.development.registerArtwork(teammate, { teamId: team.id, code: `TEAM-${randomUUID().slice(0, 12)}`, name: "Synthetic original team-owned source reference", mode: "customer_image",
      instructions: "Synthetic reusable image field only; no order or production approval", customization: { version: 1, fields: [{ key: "photo", label: "Original synthetic image", type: "image", required: true,
        validation: { allowedMediaTypes: ["image/png"], maxFiles: 1, maxBytes: 1024 * 1024 } }] },
      materials: [{ assetId: foreign.ids.assetId!, role: "source", usage: "Original synthetic team source registered by its owner" }], expectedVersion: 0, idempotencyKey: randomUUID() });
    await f.grant(f.a, selfBits, "team", all.filter(bit => !selfBits.includes(bit)));
    const teamContext = await withTenant(database.db, f.seed(f.a), tx => loadCurrentMembershipContext(tx, f.seed(f.a)));
    expect(teamContext.teamIds).toContain(team.id);
    const teamItems = [];
    for (const [index, id] of [foreign.targetId, parsedByA.id].entries()) {
      const basis = await f.adapter.basis(teamContext, { kind: "template_config", targetId: id, taskGoal: "Actual trusted shared original source, independent of parser requester" });
      teamItems.push(BusinessBenchmarkCaseSchema.parse({ key: `team_source_${index}`, role: "template_config", label: "Actual teammate source", task: basis.input, expectedFacts: [], forbiddenClaims: [], expectRefusal: false }));
    }
    const teamSaved = await f.datasets.save(teamContext, null, { fields: { name: "Real team source execution", description: "Actual trusted team resource and original scope", items: teamItems },
      expectedRevision: 0, reason: "Real shared asset owner and team master", requestId: randomUUID() });
    const teamPublished = await f.datasets.publish(teamContext, teamSaved.id, { expectedRevision: 1, retentionDays: 7, reason: "Pin original team IDs for the actual native Worker", requestId: randomUUID() });
    const teamVersion = await f.datasets.version(teamContext, teamPublished.id), prepared = await f.originalPrepared(teamVersion.items[0]!);
    expect(prepared.benchmarkResources!.teamIds).toContain(team.id); expect(prepared.benchmarkResources!.permissionScopes[Permission.AssetRead]).toBe("team");
    const teamExperiment = await f.experiments.create(teamContext, { datasetVersionId: teamVersion.id, modelId: f.modelId, label: "Actual original team execution", baselineVersion: ROLE_BENCHMARK_RULE_VERSION,
      maxAttemptsPerItem: 1, reason: "No queue identity team loss", requestId: randomUUID() });
    const teamStart = { itemId: teamVersion.items[0]!.id, expectedLatestAttemptId: null, confirmNewPaidAttempt: true as const, requestId: randomUUID() };
    const teamReceipt = await f.experiments.start(teamContext, teamExperiment.id, teamStart), teamNative = await f.experiments.attempt(teamContext, teamReceipt.id);
    if (!teamNative.nativeRunId) throw new Error("Actual original team native run required");
    f.setOutput(await f.output(teamVersion.items[0]!)); await f.processRun(teamNative.nativeRunId);
    expect(await f.experiments.attempt(teamContext, teamReceipt.id)).toMatchObject({ state: "completed", assessment: { hardPass: true } });
    const originalTeamCommand = await f.datasets.request(teamContext, teamStart.requestId);
    assertMinimalCommand(originalTeamCommand, teamStart.requestId, teamExperiment.id, benchmarkRequestChecksum("attempt.start", teamExperiment.id, teamStart), teamReceipt);
    await f.grant();
    await teams.setMember(f.a.context, team.id, { membershipId: f.a.membershipId, active: false, expectedRevision: members[0]!.revision,
      reason: "Actual current team membership withdrawn", requestId: randomUUID() });
    await f.grant(f.a, selfBits, "team", all.filter(bit => !selfBits.includes(bit)));
    const teamWithdrawnEffects = await recoveryEffects();
    for (const read of [() => f.datasets.version(teamContext, teamVersion.id), () => f.experiments.get(teamContext, teamExperiment.id),
      () => f.experiments.attempt(teamContext, teamReceipt.id), () => f.costs.summary(teamContext, teamExperiment.id)])
      await expect(read()).rejects.toBeInstanceOf(ForbiddenError);
    const restoredTeamCommand = await f.datasets.request(teamContext, teamStart.requestId);
    assertMinimalCommand(restoredTeamCommand, teamStart.requestId, teamExperiment.id, originalTeamCommand.requestChecksum, teamReceipt);
    expect(restoredTeamCommand).toEqual(originalTeamCommand); expect(await f.experiments.start(teamContext, teamExperiment.id, teamStart)).toEqual(teamReceipt);
    const newTeamInput = { ...teamStart, expectedLatestAttemptId: teamReceipt.id, requestId: randomUUID() };
    await expect(f.experiments.start(teamContext, teamExperiment.id, newTeamInput)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(f.experiments.start(teamContext, teamExperiment.id, { ...teamStart, expectedLatestAttemptId: teamReceipt.id })).rejects.toMatchObject({ status: 409, message: "benchmark_request_conflict" });
    expect(await nativeCount(teamStart.requestId)).toEqual(oneNative); expect(await nativeCount(newTeamInput.requestId)).toEqual(emptyNative);
    expect(await recoveryEffects()).toEqual(teamWithdrawnEffects);
    await f.grant();
    const ownSources = await f.sourceRows(), ownCreative = ownSources.find(row => row.role === "creative" && row.complete)!, ownSku = ownSources.find(row => row.role === "sku_package" && row.complete)!;
    const [ownSpu] = await withTenant(database.db, f.a.context, tx => tx.execute<{ id: string }>(sql`select spu_id as id from skus where id=${ownSku.ids.skuId}::uuid`));
    const ownPlan = (await f.facts.salesPlans.create(f.a.context, { spuId: ownSpu!.id, fields: SalesPlanFieldsSchema.parse({ name: "Own plan with independently self ProductRead", mode: "custom", fulfillment: "fbm",
      researchItemIds: [ownCreative.ids.researchItemId!] }), idempotencyKey: randomUUID() })).plan;
    await f.grant(f.a, [Permission.ProductRead], "self", all.filter(bit => bit !== Permission.ProductRead));
    const dynamic = await withTenant(database.db, f.seed(f.a), tx => loadCurrentMembershipContext(tx, f.seed(f.a)));
    for (const bit of [...workflow, Permission.DesignRead, Permission.ResearchRead]) expect(dynamic.permissionScopes![bit]).toBe("tenant");
    expect(dynamic.permissionScopes![Permission.ProductRead]).toBe("self");
    const creativeBasis = await f.adapter.basis(dynamic, { kind: "creative", targetId: ownCreative.targetId, taskGoal: "Only this actor's original sales-plan facts" });
    if (creativeBasis.input.kind !== "creative") throw new Error("Actual creative task required for dynamic ProductRead");
    const creativeRequest = CreateAssistSchema.parse({ ...creativeBasis.input, scopeId: ownPlan.id, projectId: undefined, salesPlan: { id: ownPlan.id, revision: ownPlan.revision },
      expectedTaskFingerprint: undefined, modelId: f.modelId, requestId: randomUUID() });
    const planPrepared = await f.contexts.prepareRoleBenchmark(dynamic, creativeRequest);
    const task = Object.fromEntries(Object.entries(planPrepared.request).filter(([key]) => key !== "modelId" && key !== "requestId"));
    const planField = BusinessBenchmarkCaseSchema.parse({ key: "own_plan_dynamic_self", role: "creative", label: "Original own SalesPlan requires only its actual self ProductRead",
      task: { ...task, expectedTaskFingerprint: assistTaskFingerprint(planPrepared) }, expectedFacts: [], forbiddenClaims: [], expectRefusal: false });
    const templateBasis = await f.adapter.basis(dynamic, { kind: "template_config", targetId: own.targetId, taskGoal: "Original own template control" });
    const dynamicSaved = await f.datasets.save(dynamic, null, { fields: { name: "Tenant Workflow with dynamic self ProductRead", description: "Dynamic required bits cannot inherit a broader experiment floor",
      items: [planField, BusinessBenchmarkCaseSchema.parse({ key: "own_template_control", role: "template_config", label: "Actual own parsed source", task: templateBasis.input,
        expectedFacts: [], forbiddenClaims: [], expectRefusal: false })] }, expectedRevision: 0, reason: "Explicit independent dynamic permission scope", requestId: randomUUID() });
    const dynamicPublished = await f.datasets.publish(dynamic, dynamicSaved.id, { expectedRevision: 1, retentionDays: 7, reason: "Preserve original self ProductRead for this owned plan", requestId: randomUUID() });
    const dynamicVersion = await f.datasets.version(dynamic, dynamicPublished.id), dynamicItem = dynamicVersion.items.find(item => item.fields.key === planField.key)!;
    expect(dynamicVersion.dataScope).toBe("tenant");
    const fixedPlan = await f.originalPrepared(dynamicItem);
    expect(fixedPlan.request.salesPlan).toEqual({ id: ownPlan.id, revision: ownPlan.revision });
    expect(fixedPlan.benchmarkResources!.permissionScopes[Permission.ProductRead]).toBe("self");
    expect(fixedPlan.benchmarkResources!.items).toContainEqual({ kind: "sales_plan", id: ownPlan.id });
    const dynamicExperiment = await f.experiments.create(dynamic, { datasetVersionId: dynamicVersion.id, modelId: f.modelId, label: "Dynamic self permission remains self at native birth and execution",
      baselineVersion: ROLE_BENCHMARK_RULE_VERSION, maxAttemptsPerItem: 1, reason: "No dynamic ProductRead escalation", requestId: randomUUID() });
    expect((await f.experiments.get(dynamic, dynamicExperiment.id)).dataScope).toBe("tenant");
    const physicalBefore = await f.businessState(f.a.context), providerCalls = f.requests.length;
    const dynamicReceipt = await f.experiments.start(dynamic, dynamicExperiment.id, { itemId: dynamicItem.id, expectedLatestAttemptId: null, confirmNewPaidAttempt: true, requestId: randomUUID() });
    const dynamicNative = await f.experiments.attempt(dynamic, dynamicReceipt.id);
    if (!dynamicNative.nativeRunId) throw new Error("Actual dynamic-scope native run required");
    const [birth] = await withTenant(database.db, dynamic, tx => tx.execute<{ same: boolean; itemId: string }>(sql`select a.creation_transaction_id::text=n.creation_transaction_id::text as same,n.benchmark_item_id as "itemId"
      from knowledge_benchmark_attempts a join ai_assist_runs n on n.id=a.native_run_id where a.id=${dynamicReceipt.id}::uuid`));
    expect(birth).toEqual({ same: true, itemId: dynamicItem.id });
    f.setOutput(await f.output(dynamicItem)); await f.processRun(dynamicNative.nativeRunId);
    expect(await f.experiments.attempt(dynamic, dynamicReceipt.id)).toMatchObject({ state: "completed", assessment: { hardPass: true, graderVersion: "role-benchmark-checks-v1" } });
    expect((await f.assists.get(dynamic, dynamicNative.nativeRunId)).accessPolicy?.requiredPermissions).toContain(Permission.ProductRead);
    expect(f.requests).toHaveLength(providerCalls + 1); expect(await f.businessState(f.a.context)).toEqual(physicalBefore);
  });

  it("rechecks PII and current scope after original reads and provider I/O without returning or sealing a late private result", async () => {
    const scene = await f.experiment(["order_review", "after_sales_review"]), current = await start(scene), done = await f.complete(current.receipt.id, scene.version);
    const check = f.contexts.assertExecutionCurrent.bind(f.contexts), gate = roleBenchmarkGate(); let entered = false;
    const spy = vi.spyOn(f.contexts, "assertExecutionCurrent").mockImplementation(async (...args) => { await check(...args); entered = true; await gate.promise; });
    const read = f.assists.get(f.a.context, done.native.id); void read.catch(() => {});
    try {
      await expect.poll(() => entered, { timeout: 15_000 }).toBe(true); await f.grant(f.a, Object.values(Permission).filter(bit => bit !== Permission.OrderPiiRead));
      gate.release(); await expect(read).rejects.toBeInstanceOf(ForbiddenError);
    } finally { gate.release(); await Promise.allSettled([read]); spy.mockRestore(); await f.grant(); }
    const late = await start(scene), native = await f.experiments.attempt(f.a.context, late.receipt.id); if (!native.nativeRunId) throw new Error("Actual native required");
    const providerGate = roleBenchmarkGate(); entered = false; f.controls.beforeResponse = async () => { entered = true; await providerGate.promise; };
    f.setOutput(await f.output(scene.version.items[0]!)); const before = await f.businessState(f.a.context), calls = f.requests.length;
    const processing = f.processRun(native.nativeRunId); void processing.catch(() => {});
    try {
      await expect.poll(() => entered, { timeout: 15_000 }).toBe(true); await f.grant(f.a, Object.values(Permission).filter(bit => bit !== Permission.OrderPiiRead));
      providerGate.release(); await processing;
      const [actual] = await withTenant(database.db, f.seed(f.a), tx => tx.execute<{ state: string; grades: number }>(sql`select status as state,
        (select count(*)::int from knowledge_benchmark_assessments where attempt_id=${late.receipt.id}::uuid) as grades from ai_assist_runs where id=${native.nativeRunId}::uuid`));
      expect(actual!.state).not.toBe("completed"); expect(actual!.grades).toBe(0); expect(f.requests).toHaveLength(calls + 1);
      expect(await f.businessState(f.seed(f.a))).toEqual(before);
    } finally { providerGate.release(); await Promise.allSettled([processing]); delete f.controls.beforeResponse; await f.grant(); }
  });

  it("serializes actual same-key attempts and restores only the original actor, body and receipt across a new service instance", async () => {
    const scene = await f.experiment(["creative"]), input = { itemId: scene.version.items[0]!.id, expectedLatestAttemptId: null, confirmNewPaidAttempt: true as const, requestId: randomUUID() };
    const gate = roleBenchmarkGate(); let blockerPid: number | undefined;
    const blocker = withTenant(database.db, f.a.context, async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`knowledge-benchmark-request:${f.a.tenantId}:${input.requestId}`},0))`);
      blockerPid = (await tx.execute<{ id: number }>(sql`select pg_backend_pid() as id`))[0]!.id; await gate.promise;
    });
    const pending: Array<Promise<{ id: string; revision: number }>> = [];
    try {
      await expect.poll(() => blockerPid, { timeout: 15_000 }).toBeDefined();
      for (let i = 0; i < 3; i++) { const attempt = f.experiments.start(f.a.context, scene.created.id, input); void attempt.catch(() => {}); pending.push(attempt); }
      await expect.poll(async () => Number((await database.client.unsafe("select count(*)::int as n from pg_stat_activity where datname=current_database() and wait_event='advisory' and $1::int=any(pg_blocking_pids(pid))", [blockerPid!]))[0]!.n), { timeout: 15_000 }).toBe(3);
      gate.release(); await blocker; const receipts = await Promise.all(pending); expect(new Set(receipts.map(row => row.id)).size).toBe(1); expect(await nativeCount(input.requestId)).toEqual(oneNative);
      const rebuilt = new KnowledgeBenchmarkExperimentService(database, f.evaluations, f.vault, f.adapter);
      expect(await rebuilt.start(f.a.context, scene.created.id, input)).toEqual(receipts[0]);
      expect(await f.datasets.request(f.a.context, input.requestId)).toMatchObject({ operation: "attempt.start", parentId: scene.created.id, receipt: receipts[0] });
      for (const actor of [f.second, f.foreign]) await expect(rebuilt.start(actor.context, scene.created.id, input)).rejects.toBeInstanceOf(NotFoundException);
      await expect(rebuilt.start(f.a.context, scene.created.id, { ...input, itemId: scene.version.items[1]!.id })).rejects.toBeInstanceOf(ConflictException);
      await expect(rebuilt.start(f.a.context, scene.created.id, { ...input, requestId: randomUUID() })).rejects.toBeInstanceOf(ConflictException);
      await f.complete(receipts[0]!.id, scene.version); expect(await nativeCount(input.requestId)).toEqual(oneNative);
    } finally { gate.release(); await blocker; await Promise.allSettled(pending); }
  });

  it("rolls back publication and native admission audit failure and recovers postcommit queue loss by its original request", async () => {
    const source = await f.sources(["template_config"]), saved = await f.datasets.save(f.a.context, null, { fields: source.fields, expectedRevision: 0, reason: "Synthetic source publication audit rollback", requestId: randomUUID() });
    const original = eventOwner.recordKnowledgeGovernanceEvent;
    const spy = vi.spyOn(eventOwner, "recordKnowledgeGovernanceEvent").mockImplementation(async (...args) => { if (args[3] === "benchmark.dataset.publish") throw new Error("Synthetic role audit unavailable"); return original(...args); });
    let before = await f.state(); const dispatches = f.dispatches.length;
    await expect(f.datasets.publish(f.a.context, saved.id, { expectedRevision: 1, retentionDays: 7, reason: "Synthetic real rollback", requestId: randomUUID() })).rejects.toThrow("Synthetic role audit unavailable");
    expect(await f.state()).toEqual(before); expect(f.dispatches).toHaveLength(dispatches); spy.mockRestore();
    const scene = await f.experiment(["template_config"]), input = { itemId: scene.version.items[0]!.id, expectedLatestAttemptId: null, confirmNewPaidAttempt: true as const, requestId: randomUUID() };
    before = await f.state(); const beforeDispatch = f.dispatches.length;
    vi.spyOn(eventOwner, "recordKnowledgeGovernanceEvent").mockImplementation(async (...args) => { if (args[3] === "benchmark.attempt.start") throw new Error("Synthetic role audit unavailable"); return original(...args); });
    await expect(f.experiments.start(f.a.context, scene.created.id, input)).rejects.toThrow("Synthetic role audit unavailable");
    expect(await f.state()).toEqual(before); expect(f.dispatches).toHaveLength(beforeDispatch); vi.restoreAllMocks();
    f.controls.failQueue = true; const receipt = await f.experiments.start(f.a.context, scene.created.id, input); f.controls.failQueue = false;
    expect(await f.experiments.start(f.a.context, scene.created.id, input)).toEqual(receipt); expect(await nativeCount(input.requestId)).toEqual(oneNative);
    await f.complete(receipt.id, scene.version); expect(await f.experiments.start(f.a.context, scene.created.id, input)).toEqual(receipt);
  });

  it("rejects stale fixed task and byte pins during real private file I/O without silently repinning a published sample", async () => {
    const source = await f.sources(["sku_package"]), fields = source.fields;
    const stale = structuredClone(fields); if (stale.items[0]!.role === "knowledge_answer") throw new Error("Business role required"); stale.items[0]!.task.expectedTaskFingerprint = "0".repeat(64);
    const saved = await f.datasets.save(f.a.context, null, { fields: stale, expectedRevision: 0, reason: "Synthetic invalid original pin", requestId: randomUUID() });
    let before = await f.state(); await expect(f.datasets.publish(f.a.context, saved.id, { expectedRevision: 1, retentionDays: 7, reason: "Do not silently reprepare stale input", requestId: randomUUID() })).rejects.toBeInstanceOf(ConflictException); expect(await f.state()).toEqual(before);
    const actual = await f.datasets.save(f.a.context, null, { fields, expectedRevision: 0, reason: "Synthetic real scanned source", requestId: randomUUID() });
    const read = f.facts.packages.analysisImage.bind(f.facts.packages), gate = roleBenchmarkGate(); let entered = false;
    const spy = vi.spyOn(f.facts.packages, "analysisImage").mockImplementation(async (...args) => { const body = await read(...args); entered = true; await gate.promise; return body; });
    const publishing = f.datasets.publish(f.a.context, actual.id, { expectedRevision: 1, retentionDays: 7, reason: "Fresh source permission cannot be bypassed by a completed read", requestId: randomUUID() });
    void publishing.catch(() => {});
    try {
      await expect.poll(() => entered, { timeout: 15_000 }).toBe(true); await f.grant(f.a, Object.values(Permission).filter(bit => bit !== Permission.DesignRead));
      before = await f.state(); gate.release();
      const failure = await publishing.then(() => null, (error: unknown) => error);
      expect(failure).toBeInstanceOf(NotFoundException); expect(failure).toMatchObject({ status: 404, message: "商品对象不存在或不可访问" });
      expect(await f.state()).toEqual(before);
    } finally { gate.release(); await Promise.allSettled([publishing]); spy.mockRestore(); await f.grant(); }
  });

  it("excludes benchmark native runs from ordinary history and production artwork evidence and rejects the real sales-plan adopt owner", async () => {
    const scene = await f.experiment(["creative", "artwork_preflight"]), calls = f.requests.length;
    const sku = (await f.sourceRows()).find(row => row.role === "sku_package" && row.complete)!;
    const [spu] = await withTenant(database.db, f.a.context, tx => tx.execute<{ id: string }>(sql`select spu_id as id from skus where id=${sku.ids.skuId}::uuid`));
    const plan = (await f.facts.salesPlans.create(f.a.context, { spuId: spu!.id, fields: SalesPlanFieldsSchema.parse({ name: "Synthetic real adoption guard", mode: "custom", fulfillment: "fbm" }), idempotencyKey: randomUUID() })).plan;
    const before = await f.businessState(f.a.context);
    const index = scene.version.items.findIndex(item => item.fields.role === "creative"), first = await start(scene, index), creative = await f.complete(first.receipt.id, scene.version);
    const artworkIndex = scene.version.items.findIndex(item => item.fields.role === "artwork_preflight"), artwork = await start(scene, artworkIndex), done = await f.complete(artwork.receipt.id, scene.version);
    const prepared = await f.originalPrepared(scene.version.items[artworkIndex]!);
    if (prepared.request.kind !== "artwork_preflight") throw new Error("Actual ordinary preflight fixed task required");
    const work = await f.facts.work.detail(f.a.context, prepared.request.orderLineId), editor = await f.facts.editor.get(f.a.context, work.line.editorProjectId!);
    const audit = new ArtworkAuditRepository(database, f.vault);
    expect(await audit.current(f.a.context, editor.project.id, editor.version.id)).toBeNull();
    const recent = await f.assists.list(f.a.context, "artwork_preflight", `order:${prepared.request.orderLineId}`);
    expect(recent.some(row => row.id === done.native.id)).toBe(false);
    await expect(f.launch.adopt(f.a.context, plan.id, { kind: "creative", runId: creative.native.id, directionIndex: 0, fields: ["positioning"], expectedRevision: plan.revision, idempotencyKey: randomUUID() })).rejects.toThrow("benchmark_adoption_forbidden");
    expect((await f.facts.salesPlans.get(f.a.context, plan.id)).plan).toEqual(plan);
    // Explicit plan setup precedes the hash, so the real adoption target is covered too.
    const later = await f.businessState(f.a.context); expect(later).toEqual(before); expect(f.requests).toHaveLength(calls + 2);
  });

  it("requires authentic six-role scores, real current birth and matching audits and remains closed after an early constraint flush", async () => {
    const scene = await f.experiment(["template_config"]), baseline = scene.experiment.cells[0]!.baselineAttemptId, current = await start(scene); await f.complete(current.receipt.id, scene.version);
    const [grade] = await withTenant(database.db, f.a.context, tx => tx.select().from(knowledgeBenchmarkAssessments).where(eq(knowledgeBenchmarkAssessments.attemptId, baseline)));
    expect(benchmarkAssessmentView(f.vault, grade!)).toMatchObject({ graderVersion: "role-benchmark-checks-v1" });
    expect(() => benchmarkAssessmentView(f.vault, { ...grade!, proof: grade!.proof.slice(0, -3) + "xyz" })).toThrow("benchmark_assessment_unavailable");
    expect(() => benchmarkAssessmentView(f.vault, { ...grade!, attemptId: scene.experiment.cells[1]!.baselineAttemptId })).toThrow("benchmark_assessment_unavailable");
    for (const actor of [f.second, f.foreign]) await withTenant(database.db, actor.context, async tx => {
      const [role] = await tx.execute<{ app: boolean }>(sql`select current_user='yummyai_app' as app`); expect(role!.app).toBe(true);
      for (const table of ["knowledge_benchmark_items", "knowledge_benchmark_attempts", "knowledge_benchmark_assessments", "knowledge_benchmark_commands"])
        expect(await tx.execute(sql`select id from ${sql.identifier(table)}`)).toEqual([]);
    });
    const before = await f.state();
    async function rawReview(tx: TenantTransaction, audit: boolean) {
      const id = createEntityId(), createdAt = new Date(), input = { expectedReviewId: null, decision: "pass", minutes: "0.250", hourlyUsd: "60.00000000", reason: "Synthetic six-role raw closure control", requestId: randomUUID() };
      await tx.insert(knowledgeBenchmarkReviews).values({ id, tenantId: f.a.tenantId, createdBy: f.a.userId, createdAt, creationTransactionId: "forged-marker",
        attemptId: baseline, assessmentId: grade!.id, previousId: null, sequence: 1, decision: "pass", minutes: input.minutes, hourlyUsd: input.hourlyUsd, reason: input.reason });
      await recordBenchmarkCommand(tx, f.a.context, "attempt.review", baseline, input, { id, revision: 1 }, "tenant", createdAt);
      if (audit) await eventOwner.recordKnowledgeGovernanceEvent(tx, f.a.context, id, "benchmark.attempt.review", input.reason, { attemptId: baseline, assessmentId: grade!.id, sequence: 1 });
      const [birth] = await tx.execute<{ saved: string; actual: string }>(sql`select creation_transaction_id as saved,pg_current_xact_id()::text as actual from knowledge_benchmark_reviews where id=${id}::uuid`);
      expect(birth!.saved).toBe(birth!.actual);
    }
    await expect(withTenant(database.db, f.a.context, async tx => { await rawReview(tx, true); await tx.execute(sql`set constraints all immediate`); throw rollback; })).rejects.toBe(rollback); expect(await f.state()).toEqual(before);
    await expect(withTenant(database.db, f.a.context, async tx => { await rawReview(tx, false); await tx.execute(sql`set constraints all immediate`); })).rejects.toSatisfy((error: unknown) => pg(error).code === "23514" && pg(error).message === "benchmark_audit_required"); expect(await f.state()).toEqual(before);
    const native = await f.experiments.attempt(f.a.context, current.receipt.id);
    await expect(withTenant(database.db, f.a.context, async tx => { await rawReview(tx, true); await tx.execute(sql`set constraints all immediate`);
      await tx.update(aiAssistRuns).set({ benchmarkItemId: scene.version.items[1]!.id }).where(eq(aiAssistRuns.id, native.nativeRunId!));
    })).rejects.toSatisfy((error: unknown) => pg(error).code === "23514" && pg(error).message === "benchmark_native_marker_immutable"); expect(await f.state()).toEqual(before);
    const item = scene.version.items[0]!, raw = await f.originalPrepared(item), pins = businessBenchmarkSourcePins(raw), bad = structuredClone(pins);
    if (!("kind" in bad[0]!)) throw new Error("Actual typed business source required"); delete bad[0]!.resourceBindings;
    expect((await withTenant(database.db, f.a.context, tx => tx.execute<{ valid: boolean; invalid: boolean }>(sql`select knowledge_benchmark_resource_pins_valid(${JSON.stringify(pins)}::jsonb) as valid,
      knowledge_benchmark_resource_pins_valid(${JSON.stringify(bad)}::jsonb) as invalid`)))[0]).toEqual({ valid: true, invalid: false });
    const unfinished = await start(scene, 1), queued = await f.experiments.attempt(f.a.context, unfinished.receipt.id);
    if (!queued.nativeRunId) throw new Error("Actual queued native birth required for completion closure");
    expect(queued).toMatchObject({ state: "queued", assessment: null });
    const queuedState = await f.state(), queuedRequests = f.requests.length;
    for (const earlyFlush of [false, true]) {
      await expect(withTenant(database.db, f.a.context, async tx => {
        const [role] = await tx.execute<{ app: boolean }>(sql`select current_user='yummyai_app' as app`); expect(role!.app).toBe(true);
        if (earlyFlush) await tx.execute(sql`set constraints all immediate`);
        await tx.update(aiAssistRuns).set({ status: "completed", encryptedOutput: "synthetic-forged", completedAt: new Date() }).where(eq(aiAssistRuns.id, queued.nativeRunId!));
        // The normal branch deliberately returns so its real deferred COMMIT must reject.
      })).rejects.toSatisfy((error: unknown) => pg(error).code === "23514" && pg(error).message === "benchmark_native_completion_required");
      expect(await f.state()).toEqual(queuedState); expect(f.requests).toHaveLength(queuedRequests);
      expect(await f.experiments.attempt(f.a.context, unfinished.receipt.id)).toMatchObject({ state: "queued", assessment: null });
    }
  });

  it("clears expired six-role bodies through original durable jobs while sealed grades, source ownership, reports and exact request recovery remain immutable", async () => {
    const scene = await f.experiment(["template_config"]), current = await start(scene), done = await f.complete(current.receipt.id, scene.version);
    const reportInput = { reason: "Synthetic original six-role report before private-body expiry", requestId: randomUUID() }, receipt = await f.costs.report(f.a.context, scene.created.id, reportInput);
    const report = await f.costs.readReport(f.a.context, receipt.id), facts = await f.businessState(f.a.context);
    const immutable = async () => (await withTenant(database.db, f.seed(f.a), tx => tx.execute<{ manifest: string; grades: string; native: string; report: string }>(sql`select
      (select md5(to_jsonb(v)::text) from knowledge_benchmark_versions v where id=${scene.version.id}::uuid) as manifest,
      (select md5(jsonb_agg(to_jsonb(g)-'encrypted_output' order by g.id)::text) from knowledge_benchmark_assessments g join knowledge_benchmark_attempts a on a.id=g.attempt_id where a.experiment_id=${scene.created.id}::uuid) as grades,
      (select md5(to_jsonb(n)::text) from ai_assist_runs n where id=${done.native.id}::uuid) as native,
      (select md5(to_jsonb(r)::text) from knowledge_benchmark_reports r where id=${receipt.id}::uuid) as report`)))[0]!;
    const original = await immutable(), { nonce, workspace } = requireRoleBenchmarkEnvironment("current");
    const [clock] = await database.client.unsafe<{ database: string; definition: string }[]>("select current_database() as database,pg_get_functiondef('knowledge_benchmark_now()'::regprocedure) as definition");
    expect(clock?.database).toBe(`order_daily_e2e_${nonce}`); if (!clock?.definition) throw new Error("Original benchmark clock required");
    let operationError: unknown, restoreError: unknown, restored = false;
    try {
      await database.client.unsafe("create or replace function knowledge_benchmark_now() returns timestamptz language sql volatile set search_path=pg_catalog,public as $$ select clock_timestamp()+interval '31 days' $$");
      await f.grant(f.a, []); const expired = await expireKnowledgeBenchmarkBodiesInTenant(database, f.a.tenantId); expect(expired.failed).toBe(0); expect(expired.expired).toBeGreaterThanOrEqual(4);
      const [actual] = await withTenant(database.db, f.seed(f.a), tx => tx.execute<{ basis: number; baseline: number; completed: number }>(sql`select
        (select count(*)::int from knowledge_benchmark_items where version_id=${scene.version.id}::uuid and encrypted_basis is not null) as basis,
        (select count(*)::int from knowledge_benchmark_assessments g join knowledge_benchmark_attempts a on a.id=g.attempt_id where a.experiment_id=${scene.created.id}::uuid and a.arm='baseline' and g.encrypted_output is not null) as baseline,
        (select count(*)::int from knowledge_benchmark_retention_jobs j where state='completed' and(resource_id in(select id from knowledge_benchmark_items where version_id=${scene.version.id}::uuid)
          or resource_id in(select g.id from knowledge_benchmark_assessments g join knowledge_benchmark_attempts a on a.id=g.attempt_id where a.experiment_id=${scene.created.id}::uuid and a.arm='baseline'))) as completed`));
      expect(actual).toEqual({ basis: 0, baseline: 0, completed: 4 }); expect(await immutable()).toEqual(original);
      expect(await expireKnowledgeBenchmarkBodiesInTenant(database, f.a.tenantId)).toEqual({ expired: 0, failed: 0 });
    } catch (error) { operationError = error; }
    finally {
      try { await database.client.unsafe(clock.definition); restored = (await database.client.unsafe<{ definition: string }[]>("select pg_get_functiondef('knowledge_benchmark_now()'::regprocedure) as definition"))[0]?.definition === clock.definition;
        if (!restored) restoreError = new Error("Original benchmark clock restoration differs"); } catch (error) { restoreError = error; }
      try { await f.grant(); const owned = resolve(workspace, "tmp/role-benchmark-20261021-b84f6d29/qa"); await mkdir(owned, { recursive: true });
        await writeFile(resolve(owned, `retention-clock-${nonce}.json`), JSON.stringify({ nonce, restored, originalDefinitionSha256: roleBenchmarkSha(clock.definition), orderClockChanged: false, tenantRowsTimeChanged: false }, null, 2) + "\n");
      } catch (error) { restoreError = restoreError ? new AggregateError([restoreError, error], "Synthetic restoration evidence failed") : error; }
    }
    if (operationError && restoreError) throw new AggregateError([operationError, restoreError], "Synthetic six-role retention and restoration failed");
    if (restoreError) throw restoreError; if (operationError) throw operationError;
    expect((await f.datasets.version(f.a.context, scene.version.id)).items.every(row => !row.usable)).toBe(true);
    expect((await f.experiments.attempt(f.a.context, scene.experiment.cells[0]!.baselineAttemptId)).result).toBeNull();
    expect((await f.experiments.attempt(f.a.context, current.receipt.id)).assessment).toEqual(done.attempt.assessment);
    expect(await f.costs.readReport(f.a.context, receipt.id)).toEqual(report); expect(await f.businessState(f.a.context)).toEqual(facts);
    expect(await f.experiments.start(f.a.context, scene.created.id, current.input)).toEqual(current.receipt);

    // Fresh sources below deliberately follow retention and every other source
    // consumer: withdrawing guidance must not poison their shared fixture setup.
    const guidanceEvidence = async (experimentId: string, reportId: string) => (await withTenant(database.db, f.a.context, tx => tx.execute<{
      assessments: string; native: string; budgets: string; expenses: string; report: string;
    }>(sql`select
      (select md5(coalesce(jsonb_agg(to_jsonb(g) order by g.id)::text,'[]')) from knowledge_benchmark_assessments g join knowledge_benchmark_attempts a on a.id=g.attempt_id where a.experiment_id=${experimentId}::uuid) as assessments,
      (select md5(coalesce(jsonb_agg(to_jsonb(n) order by n.id)::text,'[]')) from ai_assist_runs n join knowledge_benchmark_attempts a on a.native_run_id=n.id where a.experiment_id=${experimentId}::uuid) as native,
      (select md5(coalesce(jsonb_agg(to_jsonb(b) order by b.id)::text,'[]')) from ai_budget_ledger b join knowledge_benchmark_attempts a on a.native_run_id=b.request_id where a.experiment_id=${experimentId}::uuid) as budgets,
      (select md5(coalesce(jsonb_agg(to_jsonb(e) order by e.id)::text,'[]')) from knowledge_benchmark_expenses e where e.experiment_id=${experimentId}::uuid) as expenses,
      (select md5(to_jsonb(r)::text) from knowledge_benchmark_reports r where r.id=${reportId}::uuid) as report`)))[0]!;
    async function recordedGuidanceScene() {
      const value = await f.experiment(["after_sales_review"]), started = await start(value), finished = await f.complete(started.receipt.id, value.version);
      expect(finished.attempt.resultAvailable).toBe(true); expect(finished.attempt.result).not.toBeNull();
      const saved = await f.costs.report(f.a.context, value.created.id, { reason: "Synthetic immutable score and actual attempt cost before guidance withdrawal", requestId: randomUUID() });
      return { value, started, finished, saved, report: await f.costs.readReport(f.a.context, saved.id), costs: await f.costs.summary(f.a.context, value.created.id),
        evidence: await guidanceEvidence(value.created.id, saved.id), facts: await f.businessState(f.a.context) };
    }
    async function assertGuidanceUnavailable(value: Awaited<ReturnType<typeof recordedGuidanceScene>>) {
      const actual = await f.experiments.attempt(f.a.context, value.started.receipt.id);
      expect(actual).toMatchObject({ state: "completed", resultAvailable: false, result: null, review: null });
      expect(actual.assessment).toEqual(value.finished.attempt.assessment); expect(actual.modelCost).toEqual(value.finished.attempt.modelCost);
      const originalNative = await f.assists.get(f.a.context, value.finished.native.id);
      expect(originalNative).toMatchObject({ status: "completed", stale: true, result: null });
      const page = await f.experiments.attempts(f.a.context, value.value.created.id);
      expect(page.items.find(row => row.id === actual.id)).toMatchObject({ resultAvailable: false, result: null });
      expect((await f.datasets.version(f.a.context, value.value.version.id)).items.every(row => !row.usable)).toBe(true);
      expect(await f.costs.readReport(f.a.context, value.saved.id)).toEqual(value.report);
      const costs = await f.costs.summary(f.a.context, value.value.created.id);
      expect({ baseline: costs.baseline, candidate: costs.candidate, latestExpenses: costs.latestExpenses })
        .toEqual({ baseline: value.costs.baseline, candidate: value.costs.candidate, latestExpenses: value.costs.latestExpenses });
      expect(await guidanceEvidence(value.value.created.id, value.saved.id)).toEqual(value.evidence);
      expect(await f.businessState(f.a.context)).toEqual(value.facts);
    }
    const card = await f.knowledge.save(f.a.context, null, { fields: { ...f.fields("Synthetic reviewed after sales guidance"),
      title: "客服 售后 退款 补寄 固定指导", summary: "客服 售后 退款 补寄 仅核对原证据", body: "客服 售后 退款 补寄 保留缺项并由人工决定 不自动处理订单",
      topic: "after_sales", platform: "all", market: "ALL" }, expectedRevision: 0, reason: "Synthetic reviewed guidance for its original after-sales owner", requestId: randomUUID() });
    await f.publish(card.id);
    const knowledgeScene = await recordedGuidanceScene(), knowledgePrepared = await f.originalPrepared(knowledgeScene.value.version.items[0]!);
    expect(knowledgePrepared.knowledge?.some(reference => reference.entryId === card.id)).toBe(true);
    const cardRow = (await f.knowledge.workspace(f.a.context)).entries.find(row => row.id === card.id)!;
    await f.knowledge.change(f.a.context, card.id, "disable", { expectedRevision: cardRow.revision, version: cardRow.latestVersion,
      reason: "Actual original knowledge owner withdraws this published guidance", requestId: randomUUID() });
    await assertGuidanceUnavailable(knowledgeScene);
    const rejectedKnowledgeState = await f.state(), noNewKnowledgeCalls = f.requests.length;
    await expect(review(knowledgeScene.started.receipt.id)).rejects.toMatchObject({ status: 409, message: "benchmark_review_unavailable" });
    expect(await f.state()).toEqual(rejectedKnowledgeState); expect(f.requests).toHaveLength(noNewKnowledgeCalls);

    const methods = new MethodGovernanceService(database, f.audit), harness = assistHarness("after_sales_review", false,
      requiredAssistPermissions("after_sales_review", "run"), ASSIST_ACCESS_POLICY_VERSION), methodKey = harness.registry.describeSkill(harness.skill).methodKey;
    const method = await methods.save(f.a.context, { methodKey, expectedRevision: 0, knowledgeVersionIds: [], notes: "仅核对原售后事实并保留未知 不自动发送或采用",
      reason: "Synthetic independently reviewed original registered method", requestId: randomUUID() });
    const methodRow = async () => {
      const row = (await methods.workspace(f.a.context)).methods.find(value => value.id === method.methodId);
      if (!row) throw new Error("Actual original method owner did not retain its saved method"); return row;
    };
    let methodState = await methodRow();
    await methods.transition(f.a.context, method.methodId, "submit", { expectedRevision: methodState.revision, version: methodState.latestVersion,
      reason: "Synthetic explicit method review", requestId: randomUUID() });
    methodState = await methodRow();
    await methods.transition(f.a.context, method.methodId, "publish", { expectedRevision: methodState.revision, version: methodState.latestVersion,
      reviewedChecksum: methodState.latest.checksum, reason: "Synthetic actual method publication", requestId: randomUUID() });
    const methodScene = await recordedGuidanceScene(), methodPrepared = await f.originalPrepared(methodScene.value.version.items[0]!);
    expect(methodPrepared.methodSelection).toMatchObject({ mode: "published", methodId: method.methodId });
    const readGate = roleBenchmarkGate(), originalAttempt = f.experiments.attempt.bind(f.experiments); let originalReadCompleted = false;
    const readSpy = vi.spyOn(f.experiments, "attempt").mockImplementation(async (...args) => {
      const actual = await originalAttempt(...args);
      if (args[1] === methodScene.started.receipt.id && !originalReadCompleted) {
        expect(actual.resultAvailable).toBe(true); expect(actual.result).not.toBeNull(); originalReadCompleted = true; await readGate.promise;
      }
      return actual;
    });
    const reviewing = f.experiments.review(f.a.context, methodScene.started.receipt.id, { expectedReviewId: null, decision: "pass", minutes: "1.250", hourlyUsd: "60.00000000",
      reason: "Synthetic real review loses its original method only after reading the original result", requestId: randomUUID() }).then(value => ({ value }), (error: unknown) => ({ error }));
    try {
      await expect.poll(() => originalReadCompleted, { timeout: 5_000 }).toBe(true);
      methodState = await methodRow();
      await methods.transition(f.a.context, method.methodId, "disable", { expectedRevision: methodState.revision, version: methodState.activeVersion,
        reason: "Actual method withdrawal wins before the pending review transaction", requestId: randomUUID() });
      const withdrawnState = await f.state(), noNewMethodCalls = f.requests.length;
      readGate.release(); const outcome = await reviewing;
      expect(outcome).toHaveProperty("error"); if (!("error" in outcome)) throw new Error("A review committed after its original method was withdrawn");
      expect(outcome.error).toMatchObject({ status: 409, message: "benchmark_review_unavailable" });
      expect(await f.state()).toEqual(withdrawnState); expect(f.requests).toHaveLength(noNewMethodCalls);
    } finally { readGate.release(); await reviewing; readSpy.mockRestore(); }
    await assertGuidanceUnavailable(methodScene);
  });
});
