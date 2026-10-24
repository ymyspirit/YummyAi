import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import {
  Permission,
  ASSIST_ACCESS_POLICY_VERSION,
  requiredAssistPermissions,
} from "@yummyai/authz";
import {
  SecretVault,
  OpenAiCompatibleProvider,
  assistHarness,
  type AssistContext,
} from "@yummyai/ai-core";
import { createEntityId, PodExecutableToolKeySchema, type TenantContext } from "@yummyai/contracts";
import { KnowledgeFieldsSchema } from "@yummyai/contracts/knowledge";
import { JobEnvelopeSchema } from "@yummyai/jobs";
import {
  connectDatabase,
  migrateDatabase,
  withTenant,
  agentMethods,
  agentMethodVersions,
  knowledgeVersions,
  aiAssistRuns,
  aiAssistExecutions,
  aiBudgetLedger,
  memberships,
  membershipRoles,
  roles,
  selectAgentMethod,
  assertAgentMethodSelection,
  methodDefinitionChecksum,
} from "@yummyai/database";
import { eq } from "drizzle-orm";
import { AuditService } from "../audit/audit.service.js";
import { AssistContextService } from "../ai/assist-context.service.js";
import { AssistService } from "../ai/assist.service.js";
import {
  AiAssistProcessor,
  assistPricing,
} from "../../../worker/src/processors/ai-assist.processor.js";
import { KnowledgeService } from "./knowledge.service.js";
import { KnowledgeImportService } from "./knowledge-import.service.js";
import { KnowledgeAnswerContextService } from "./knowledge-answer-context.service.js";
import { MethodGovernanceService } from "./method-governance.service.js";

const isolated =
  process.env.E2E_ISOLATED_DAILY === "1" &&
  /^\/order_daily_e2e_[a-f0-9]{32}$/.test(
    new URL(process.env.DATABASE_URL ?? "postgres://invalid/invalid").pathname,
  );
describe.skipIf(!isolated)("tenant method governance and real assistant execution", () => {
  const db = connectDatabase(),
    audit = new AuditService(db),
    methods = new MethodGovernanceService(db, audit),
    knowledge = new KnowledgeService(db, audit);
  const contentVault = new SecretVault(Buffer.alloc(32, 71)),
    modelVault = new SecretVault(Buffer.alloc(32, 72));
  const key = "yummyai.assist.knowledge_answer.review";
  const notes = "先检查业务资料，再明确列出缺项";
  const noopQueue = { enqueue: async () => undefined };
  const imports = new KnowledgeImportService(
    db,
    new SecretVault(Buffer.alloc(32, 73)),
    {
      scan: async () => ({
        result: "clean",
        engine: "synthetic",
        signatureVersion: "1",
        scannedAt: new Date().toISOString(),
      }),
    },
    knowledge,
  );
  const answers = new KnowledgeAnswerContextService(db, contentVault, knowledge, imports);
  const contexts = new AssistContextService(db, null!, null!, null!, null!, null!, answers);
  const assists = new AssistService(db, contentVault, contexts, noopQueue);
  beforeAll(async () => {
    await migrateDatabase(db);
  });
  afterAll(async () => {
    await db.client.end();
  }); // Runner drops the entire disposable DB, including immutable synthetic history.
  async function tenant() {
    const context: TenantContext = {
      tenantId: createEntityId(),
      userId: createEntityId(),
      permissions: Object.values(Permission),
      dataScope: "tenant",
    };
    await db.client.unsafe(
      "insert into organizations(id,name,slug)values($1,'Synthetic method tenant',$2)",
      [context.tenantId, `method-${context.tenantId}`],
    );
    await db.client.unsafe(
      "insert into app_users(id,oidc_subject,email,display_name)values($1,$2,$3,'Synthetic method operator')",
      [context.userId, `method-${context.userId}`, `${context.userId}@example.test`],
    );
    await withTenant(db.db, context, async (tx) => {
      const member = createEntityId(),
        role = createEntityId();
      await tx.insert(memberships).values({
        id: member,
        tenantId: context.tenantId,
        userId: context.userId,
        status: "active",
      });
      await tx.insert(roles).values({
        id: role,
        tenantId: context.tenantId,
        name: "Synthetic method role",
        permissions: Object.values(Permission),
        dataScope: "tenant",
      });
      await tx
        .insert(membershipRoles)
        .values({ tenantId: context.tenantId, membershipId: member, roleId: role });
    });
    return context;
  }
  const saveInput = (methodKey = key, expectedRevision = 0, extra = {}) => ({
    methodKey,
    expectedRevision,
    notes,
    knowledgeVersionIds: [],
    reason: "Synthetic method review",
    requestId: randomUUID(),
    ...extra,
  });
  async function row(context: TenantContext, id: string) {
    return (await methods.workspace(context)).methods.find((m) => m.id === id)!;
  }
  async function action(
    context: TenantContext,
    id: string,
    operation: "submit" | "publish" | "reject" | "disable",
    extra = {},
  ) {
    const current = await row(context, id);
    return methods.transition(context, id, operation, {
      expectedRevision: current.revision,
      version: operation === "disable" ? current.activeVersion : current.latestVersion,
      reason: "Synthetic method transition",
      requestId: randomUUID(),
      ...(operation === "publish" ? { reviewedChecksum: current.latest.checksum } : {}),
      ...extra,
    });
  }
  async function adopt(context: TenantContext, input = saveInput()) {
    const saved = await methods.save(context, input);
    await action(context, saved.methodId, "submit");
    await action(context, saved.methodId, "publish");
    return row(context, saved.methodId);
  }
  async function source(context: TenantContext, published = true, extra = {}) {
    const saved = await knowledge.save(context, null, {
      fields: {
        title: "Synthetic method provenance",
        summary: "Reviewed operating guidance",
        body: "Keep business facts and operational guidance separate.",
        topic: "operations",
        platform: "all",
        market: "ALL",
        spuId: null,
        sourceType: "team",
        sourceLabel: "Synthetic team method",
        sourceUrl: "",
        owner: "Synthetic operator",
        verifiedOn: "2026-01-01",
        reviewDueOn: "2099-12-31",
        tags: [],
        ...extra,
      },
      expectedRevision: 0,
      reason: "Synthetic source",
      requestId: randomUUID(),
    });
    if (published) {
      for (const operation of ["submit", "publish"] as const) {
        const current = (await knowledge.workspace(context)).entries.find(
          (e) => e.id === saved.id,
        )!;
        await knowledge.change(context, saved.id, operation, {
          expectedRevision: current.revision,
          version: current.latestVersion,
          reason: "Synthetic source review",
          requestId: randomUUID(),
        });
      }
    }
    const version = await withTenant(
      db.db,
      context,
      async (tx) =>
        (
          await tx.select().from(knowledgeVersions).where(eq(knowledgeVersions.entryId, saved.id))
        )[0]!,
    );
    return { entryId: saved.id, versionId: version.id };
  }
  async function setupModel(context: TenantContext) {
    const id = createEntityId();
    await db.client.unsafe(
      "insert into model_provider_configs(id,tenant_id,provider,label,endpoint,encrypted_api_key,created_by)values($1,$2,'openai-compatible','Synthetic method model','https://method-fixture.invalid/v1',$3,$4)",
      [id, context.tenantId, modelVault.encrypt("synthetic-only"), context.userId],
    );
    return (
      await assists.addModel(context, {
        providerConfigId: id,
        model: "synthetic-method",
        label: "Synthetic method answer",
        inputUsdPerMillion: 1,
        outputUsdPerMillion: 2,
        maxTaskCostUsd: 1,
      })
    ).id;
  }
  async function run(context: TenantContext, id: string, beforeResponse?: () => Promise<void>) {
    const calls: Array<Record<string, unknown>> = [];
    const processor = new AiAssistProcessor(
      db,
      modelVault,
      contentVault,
      (provider, apiKey, record) =>
        new OpenAiCompatibleProvider({
          providerId: provider.id,
          endpoint: "https://method-fixture.invalid",
          apiKey,
          pricing: assistPricing(record.modelSnapshot),
          fetch: async (_url, init) => {
            calls.push(JSON.parse(String(init?.body)));
            if (beforeResponse) await beforeResponse();
            return Response.json({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      summary: "缺少可核验的业务资料",
                      findings: [],
                      directions: [],
                      matches: [],
                      missingInformation: ["请提供具体业务依据"],
                    }),
                  },
                },
              ],
              usage: { prompt_tokens: 20, completion_tokens: 30 },
            });
          },
        }),
    );
    await processor.process(
      JobEnvelopeSchema.parse({
        jobId: id,
        tenantId: context.tenantId,
        requestedBy: context.userId,
        idempotencyKey: id,
        correlationId: id,
        payload: { runId: id, operation: "analyze" },
      }),
    );
    const record = await withTenant(
      db.db,
      context,
      async (tx) => (await tx.select().from(aiAssistRuns).where(eq(aiAssistRuns.id, id)))[0]!,
    );
    return { calls, view: await assists.get(context, id), record };
  }
  async function create(context: TenantContext, modelId: string, extra = {}) {
    return assists.create(context, {
      kind: "knowledge_answer",
      scopeId: createEntityId(),
      modelId,
      requestId: randomUUID(),
      search: {
        query: "completely_unmatched_phrase",
        topic: "all",
        platform: "all",
        market: "ALL",
        spuIds: [],
      },
      ...extra,
    });
  }
  async function input(context: TenantContext, id: string) {
    const record = await withTenant(
      db.db,
      context,
      async (tx) => (await tx.select().from(aiAssistRuns).where(eq(aiAssistRuns.id, id)))[0]!,
    );
    return contentVault.withSecret(
      record.encryptedInput!,
      (text) => JSON.parse(text) as AssistContext,
    );
  }

  it("has assistant, workflow and POD code-owned methods without GET seeding or publication", async () => {
    const context = await tenant(),
      workspace = await methods.workspace(context);
    // Preserve the original registry and explicitly cover all six new original-owner methods.
    const creativeKeys = [
      "creative.creative_candidate.external_request", "creative.creative_adaptation.external_request",
      "creative.creative_adaptation.internal_write", "creative.template_compile.internal_write",
      "creative.mockup_render.internal_write", "creative.studio_generation.external_request",
    ];
    const benchmarkKey = "yummyai.assist.knowledge_answer.benchmark.review";
    // Preserve all ten original assistant methods plus the separate dataset benchmark.
    const methodCount = 10 + 1 + 2 + 2 + PodExecutableToolKeySchema.options.length * 2 + creativeKeys.length;
    expect(workspace.catalog).toHaveLength(methodCount);
    expect(new Set(workspace.catalog.map(row => row.methodKey)).size).toBe(methodCount);
    const benchmarkMethods = workspace.catalog.filter(row => row.methodKey.includes(".benchmark."));
    expect(benchmarkMethods.map(row => row.methodKey)).toEqual([benchmarkKey]);
    expect(benchmarkMethods[0]?.tools).toMatchObject([{ key: "yummyai.assist.knowledge_answer.benchmark", version: "assist-benchmark-2026-10-21-v1" }]);
    expect(workspace.catalog.filter(row => row.methodKey.startsWith("creative.")).map(row => row.methodKey).sort()).toEqual(creativeKeys.sort());
    expect(workspace.methods).toEqual([]);
    for (const method of workspace.catalog) {
      const saved = await methods.save(context, saveInput(method.methodKey));
      expect((await row(context, saved.methodId)).adoptedAt).toBeNull();
    }
    expect((await methods.workspace(context)).methods).toHaveLength(methodCount);
    for (const method of (await methods.workspace(context)).methods) {
      await action(context, method.id, "submit");
      await action(context, method.id, "publish");
    }
    expect(
      (await methods.workspace(context)).methods.every((method) => method.activeVersion === 1),
    ).toBe(true);
  });
  it("requires submission, exact review checksum and current permissions before publishing", async () => {
    const context = await tenant(),
      saved = await methods.save(context, saveInput());
    await expect(action(context, saved.methodId, "publish")).rejects.toMatchObject({ status: 409 });
    await action(context, saved.methodId, "submit");
    await expect(
      action(context, saved.methodId, "publish", { reviewedChecksum: "0".repeat(64) }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      action(
        { ...context, permissions: [Permission.WorkflowRead, Permission.WorkflowManage] },
        saved.methodId,
        "publish",
      ),
    ).rejects.toThrow("Permission denied");
    await action(context, saved.methodId, "publish");
    expect((await row(context, saved.methodId)).activeVersion).toBe(1);
  });
  it("replays identical commands once and rejects changed or stale concurrent saves", async () => {
    const context = await tenant(),
      command = saveInput();
    const [a, b] = await Promise.all([
      methods.save(context, command),
      methods.save(context, command),
    ]);
    expect(a).toEqual(b);
    await expect(methods.save(context, { ...command, notes: "different" })).rejects.toMatchObject({
      status: 409,
    });
    const results = await Promise.allSettled([
      methods.save(context, saveInput(key, 1)),
      methods.save(context, saveInput(key, 1)),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await methods.history(context, a.methodId)).versions).toHaveLength(2);
  });
  it("rejects executable body/tool injection and unknown method keys before writes", async () => {
    const context = await tenant();
    for (const extra of [
      { executionContract: {} },
      { instructions: "execute" },
      { tools: ["payment"] },
      { methodKey: "unregistered.method" },
    ])
      await expect(methods.save(context, { ...saveInput(), ...extra })).rejects.toMatchObject({
        status: 400,
      });
    expect((await methods.workspace(context)).methods).toHaveLength(0);
  });
  it("keeps a published v1 active while v2 is drafted, reviewed or rejected", async () => {
    const context = await tenant(),
      a = await adopt(context);
    await methods.save(context, saveInput(key, a.revision, { notes: "new notes" }));
    expect((await row(context, a.id)).activeVersion).toBe(1);
    await action(context, a.id, "submit");
    await action(context, a.id, "reject");
    expect((await row(context, a.id)).activeVersion).toBe(1);
    const bundle = assistHarness(
      "knowledge_answer",
      false,
      requiredAssistPermissions("knowledge_answer", "run"),
      ASSIST_ACCESS_POLICY_VERSION,
    );
    const selected = await withTenant(db.db, context, (tx) =>
      selectAgentMethod(tx, bundle.registry.describeSkill(bundle.skill)),
    );
    expect(selected.definition?.notes).toBe(notes);
  });
  it("binds published general knowledge and excludes draft, account-like scoped and foreign provenance", async () => {
    const context = await tenant(),
      foreign = await tenant(),
      draft = await source(context, false),
      other = await source(foreign),
      scoped = await source(context, true, { platform: "amazon", market: "US" });
    for (const versionId of [draft.versionId, other.versionId, scoped.versionId])
      await expect(
        methods.save(context, saveInput(key, 0, { knowledgeVersionIds: [versionId] })),
      ).rejects.toThrow();
    const approved = await source(context),
      saved = await adopt(
        context,
        saveInput(key, 0, { knowledgeVersionIds: [approved.versionId] }),
      );
    expect(saved.latest.definition.knowledgeReferences[0]?.versionId).toBe(approved.versionId);
  });
  it("enforces forced RLS, immutable versions/events and immutable method identity", async () => {
    const context = await tenant(),
      other = await tenant(),
      saved = await adopt(context);
    expect((await methods.workspace(other)).methods).toHaveLength(0);
    await expect(methods.history(other, saved.id)).rejects.toMatchObject({ status: 404 });
    const rows = await withTenant(db.db, other, (tx) =>
      tx.select().from(agentMethodVersions).where(eq(agentMethodVersions.methodId, saved.id)),
    );
    expect(rows).toEqual([]);
    await expect(
      db.client.unsafe("update agent_method_versions set reason='rewrite' where id=$1", [
        saved.latest.id,
      ]),
    ).rejects.toThrow("immutable");
    await expect(
      db.client.unsafe("delete from agent_method_events where method_id=$1", [saved.id]),
    ).rejects.toThrow("immutable");
    await expect(
      withTenant(db.db, context, (tx) =>
        tx
          .update(agentMethods)
          .set({ methodKey: "forged.key", revision: saved.revision + 1 })
          .where(eq(agentMethods.id, saved.id)),
      ),
    ).rejects.toMatchObject({ cause: { code: "55000" } });
  });
  it("rejects foreign knowledge provenance at the database boundary even with a matching method key", async () => {
    const context = await tenant(),
      other = await tenant(),
      foreignSource = await source(other);
    const current = await adopt(context),
      foreign = await adopt(
        other,
        saveInput(key, 0, { knowledgeVersionIds: [foreignSource.versionId] }),
      );
    const definition = {
      ...current.latest.definition,
      knowledgeReferences: foreign.latest.definition.knowledgeReferences,
    };
    await expect(
      db.client.unsafe(
        "insert into agent_method_versions(id,tenant_id,method_id,version,definition,checksum,reason,request_id,request_checksum,created_by)values($1,$2,$3,2,$4::jsonb,$5,'Synthetic forged source',$6,$7,$8)",
        [
          createEntityId(),
          context.tenantId,
          current.id,
          JSON.stringify(definition),
          methodDefinitionChecksum(definition),
          randomUUID(),
          "a".repeat(64),
          context.userId,
        ],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
  it("does not call a draft adopted and pins published v1/v2 independently in real new inputs", async () => {
    const context = await tenant(),
      model = await setupModel(context),
      saved = await methods.save(context, saveInput());
    const baseline = await create(context, model);
    expect((await input(context, baseline.id)).methodSelection?.mode).toBe("builtin");
    await action(context, saved.methodId, "submit");
    await action(context, saved.methodId, "publish");
    const first = await create(context, model);
    const v1 = await input(context, first.id);
    expect(v1.methodSelection).toMatchObject({ mode: "published", version: 1 });
    const current = await row(context, saved.methodId);
    await methods.save(context, saveInput(key, current.revision, { notes: "第二版工作说明" }));
    await action(context, saved.methodId, "submit");
    await action(context, saved.methodId, "publish");
    const second = await create(context, model);
    expect((await input(context, second.id)).methodSelection).toMatchObject({
      mode: "published",
      version: 2,
    });
    expect((await input(context, first.id)).data.operatingMethod).toEqual(v1.data.operatingMethod);
    const result = await run(context, first.id);
    expect(result.view.status).toBe("completed");
    expect(result.calls).toHaveLength(1);
    expect(JSON.stringify(result.calls[0])).toContain(notes);
    const messages = result.calls[0]!.messages as Array<{ role: string; content: unknown }>;
    expect(JSON.stringify(messages.filter((m) => m.role === "system"))).not.toContain(notes);
    expect(result.calls[0]).not.toHaveProperty("tools");
  });
  it("withdraws a queued method before submission without a model purchase or budget charge", async () => {
    const context = await tenant(),
      method = await adopt(context),
      model = await setupModel(context),
      task = await create(context, model);
    await action(context, method.id, "disable");
    const result = await run(context, task.id);
    expect(result.calls).toHaveLength(0);
    expect(result.record.errorCode).toBe("assist_method_withdrawn");
    expect(
      (
        await withTenant(db.db, context, (tx) =>
          tx.select().from(aiBudgetLedger).where(eq(aiBudgetLedger.requestId, task.id)),
        )
      )[0]?.state,
    ).toBe("released");
    await expect(create(context, model)).rejects.toMatchObject({ status: 409 });
  });
  it("rejects a caller-provided method selection before creating an assistant or reservation", async () => {
    const context = await tenant(),
      model = await setupModel(context);
    await expect(
      create(context, model, {
        methodSelection: { mode: "published", methodId: createEntityId() },
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(
      await withTenant(db.db, context, (tx) =>
        tx.select({ id: aiAssistRuns.id }).from(aiAssistRuns),
      ),
    ).toEqual([]);
    expect(
      await withTenant(db.db, context, (tx) =>
        tx.select({ id: aiBudgetLedger.id }).from(aiBudgetLedger),
      ),
    ).toEqual([]);
  });
  it("preserves the received response and original bill when the method is withdrawn in flight", async () => {
    const context = await tenant(),
      method = await adopt(context),
      model = await setupModel(context),
      task = await create(context, model);
    const result = await run(context, task.id, async () => {
      await action(context, method.id, "disable");
    });
    expect(result.calls).toHaveLength(1);
    expect(result.view.status).toBe("failed");
    expect(result.record.errorCode).toBe("assist_method_withdrawn");
    const evidence = await withTenant(db.db, context, async (tx) => ({
      run: (await tx.select().from(aiAssistRuns).where(eq(aiAssistRuns.id, task.id)))[0]!,
      execution: (
        await tx.select().from(aiAssistExecutions).where(eq(aiAssistExecutions.runId, task.id))
      )[0]!,
      bill: (
        await tx.select().from(aiBudgetLedger).where(eq(aiBudgetLedger.requestId, task.id))
      )[0]!,
    }));
    expect(evidence.execution.encryptedResponse).toBeTruthy();
    expect(evidence.execution.submissionState).toBe("received");
    expect(Number(evidence.run.costUsd)).toBeGreaterThan(0);
    expect(evidence.bill.state).toBe("committed");
    expect(Number(evidence.bill.amountUsd)).toBe(Number(evidence.run.costUsd));
  });
  it("keeps old selections withdrawn after explicit re-enable and rejects missing legacy publication snapshots", async () => {
    const context = await tenant(),
      method = await adopt(context),
      bundle = assistHarness(
        "knowledge_answer",
        false,
        requiredAssistPermissions("knowledge_answer", "run"),
        ASSIST_ACCESS_POLICY_VERSION,
      ),
      registered = bundle.registry.describeSkill(bundle.skill);
    const prior = await withTenant(db.db, context, (tx) => selectAgentMethod(tx, registered));
    await action(context, method.id, "disable");
    await action(context, method.id, "submit");
    await action(context, method.id, "publish");
    await expect(
      withTenant(db.db, context, (tx) =>
        assertAgentMethodSelection(tx, registered, prior.selection),
      ),
    ).rejects.toMatchObject({ code: "assist_method_withdrawn" });
    await expect(
      withTenant(db.db, context, (tx) => assertAgentMethodSelection(tx, registered, undefined)),
    ).rejects.toMatchObject({ code: "assist_method_snapshot_missing" });
    const next = await withTenant(db.db, context, (tx) => selectAgentMethod(tx, registered));
    expect(next.selection.withdrawalGeneration).toBe(1);
  });
  it("rechecks method provenance at execution even when normal question retrieval did not select that source", async () => {
    const context = await tenant(),
      provenance = await source(context),
      method = await adopt(
        context,
        saveInput(key, 0, { knowledgeVersionIds: [provenance.versionId] }),
      ),
      model = await setupModel(context),
      task = await create(context, model);
    const card = (await knowledge.workspace(context)).entries.find(
      (e) => e.id === provenance.entryId,
    )!;
    await knowledge.change(context, provenance.entryId, "disable", {
      expectedRevision: card.revision,
      version: card.latestVersion,
      reason: "Synthetic source withdrawal",
      requestId: randomUUID(),
    });
    const result = await run(context, task.id);
    expect(result.calls).toHaveLength(0);
    expect(result.record.errorCode).toBe("assist_method_sources_unavailable");
    expect((await row(context, method.id)).activeVersion).toBe(1);
  });
  it("holds a shared method lock through adoption so disable cannot commit first", async () => {
    const context = await tenant(),
      method = await adopt(context),
      bundle = assistHarness(
        "knowledge_answer",
        false,
        requiredAssistPermissions("knowledge_answer", "run"),
        ASSIST_ACCESS_POLICY_VERSION,
      ),
      registered = bundle.registry.describeSkill(bundle.skill);
    const selected = await withTenant(db.db, context, (tx) => selectAgentMethod(tx, registered));
    let release!: () => void, started!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
      }),
      ready = new Promise<void>((resolve) => {
        started = resolve;
      });
    const adoption = withTenant(db.db, context, async (tx) => {
      await assertAgentMethodSelection(tx, registered, selected.selection, { lock: true });
      started();
      await gate;
    });
    await ready;
    let disabled = false;
    const pending = action(context, method.id, "disable").then(() => {
      disabled = true;
    });
    try {
      const end = Date.now() + 5000;
      let blocked = false;
      while (Date.now() < end) {
        const [status] = await db.client.unsafe(
          "select exists(select 1 from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like '%agent_methods%') as blocked",
        );
        if (status?.blocked) {
          blocked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 15));
      }
      expect(blocked).toBe(true);
      expect(disabled).toBe(false);
    } finally {
      release();
      await Promise.all([adoption, pending]);
    }
    expect(disabled).toBe(true);
  });
  it("reports live source availability without replacing an older pinned knowledge version", async () => {
    const context = await tenant(),
      provenance = await source(context),
      method = await adopt(
        context,
        saveInput(key, 0, { knowledgeVersionIds: [provenance.versionId] }),
      );
    let card = (await knowledge.workspace(context)).entries.find(
      (entry) => entry.id === provenance.entryId,
    )!;
    await knowledge.save(context, card.id, {
      fields: {
        ...KnowledgeFieldsSchema.strip().parse(card.latest),
        body: "New source revision",
        title: "New method source",
      },
      expectedRevision: card.revision,
      reason: "Synthetic source update",
      requestId: randomUUID(),
    });
    for (const operation of ["submit", "publish"] as const) {
      card = (await knowledge.workspace(context)).entries.find(
        (entry) => entry.id === provenance.entryId,
      )!;
      await knowledge.change(context, card.id, operation, {
        expectedRevision: card.revision,
        version: card.latestVersion,
        reason: "Synthetic source review",
        requestId: randomUUID(),
      });
    }
    const current = await row(context, method.id);
    expect(current.activeAvailability?.eligible).toBe(true);
    expect(current.activeAvailability?.sourceStates).toEqual([
      { versionId: provenance.versionId, usable: true },
    ]);
    const choices = await methods.sources(context, { query: "New method source" });
    expect(choices.choices[0]?.version).toBe(2);
    expect(current.active?.definition.knowledgeReferences[0]?.version).toBe(1);
    card = (await knowledge.workspace(context)).entries.find(
      (entry) => entry.id === provenance.entryId,
    )!;
    await knowledge.change(context, card.id, "disable", {
      expectedRevision: card.revision,
      version: card.latestVersion,
      reason: "Synthetic source disable",
      requestId: randomUUID(),
    });
    const invalid = await row(context, method.id);
    expect(invalid.activeVersion).toBe(1);
    expect(invalid.activeAvailability?.eligible).toBe(false);
    expect(invalid.activeAvailability?.sourceStates[0]?.usable).toBe(false);
  });
  it("source selection filters scope/tenant and treats wildcard search text literally", async () => {
    const context = await tenant(),
      foreign = await tenant(),
      valid = await source(context, true, { title: "Literal 100%_ method" });
    await source(context, true, { title: "Literal 10000 method" });
    await source(context, false, { title: "Literal 100%_ draft" });
    await source(context, true, {
      title: "Literal 100%_ scoped",
      platform: "amazon",
      market: "US",
    });
    await source(foreign, true, { title: "Literal 100%_ foreign" });
    const choices = await methods.sources(context, { query: "100%_" });
    expect(choices.choices.map((choice) => choice.versionId)).toEqual([valid.versionId]);
    expect(choices.choices[0]?.usable).toBe(true);
    await expect(methods.sources(context, { tenantId: foreign.tenantId })).rejects.toMatchObject({
      status: 400,
    });
    await expect(methods.sources({ ...context, permissions: [] }, { query: "" })).rejects.toThrow(
      "Permission denied",
    );
  });
  it("pages source candidates using stable entry IDs without duplicating versions", async () => {
    const context = await tenant();
    for (let index = 0; index < 51; index++)
      await source(context, true, { title: `Paged method source ${index}` });
    const first = await methods.sources(context, { query: "Paged method source" });
    expect(first.choices).toHaveLength(50);
    expect(first.nextCursor).toBeTruthy();
    const second = await methods.sources(context, {
      query: "Paged method source",
      after: first.nextCursor!,
    });
    expect(second.choices).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect(
      new Set([...first.choices, ...second.choices].map((choice) => choice.entryId)).size,
    ).toBe(51);
  });
});
