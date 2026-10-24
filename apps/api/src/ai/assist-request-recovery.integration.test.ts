import { randomUUID } from "node:crypto";
import { ConflictException } from "@nestjs/common";
import { ForbiddenError, Permission } from "@yummyai/authz";
import { CreateAssistSchema } from "@yummyai/contracts/ai/assist";
import { AssistReceiptViewSchema } from "@yummyai/contracts/ai/assist-recovery";
import { aiAssistRuns, aiAssistExecutions, connectDatabase, withTenant } from "@yummyai/database";
import { eq } from "drizzle-orm";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { agentReadFixture, allAgentPermissions, bounded, deferred, requireAgentReadEnvironment } from "./agent-read.test-fixture.js";
import { AssistTaskWorkspaceService } from "./assist-task-workspace.service.js";

const database = connectDatabase(requireAgentReadEnvironment());
const f = agentReadFixture(database);
const allScopes = () => Object.fromEntries(allAgentPermissions.map(bit => [bit, "tenant" as const]));

describe.sequential("Ordinary Assist original-request read recovery", () => {
  beforeAll(() => f.initialize());
  afterAll(async () => { vi.useRealTimers(); f.close(); await database.client.end(); });

  it("finds an original completed request outside recent history after service reconstruction without another paid call", async () => {
    const request = await f.knowledgeRequest(), original = await f.assists.create(f.a.context, request);
    await f.process(original.id);
    const saved = await f.assists.get(f.a.context, original.id); expect(saved.status).toBe("completed");
    for (let index = 0; index < 20; index++) {
      const newer = await f.assists.create(f.a.context, { ...request, requestId: randomUUID() });
      await f.process(newer.id);
    }
    expect((await f.assists.list(f.a.context, request.kind, saved.scope)).some(row => row.id === original.id)).toBe(false);
    const before = await f.state(), restarted = f.newAssists();
    const receipt = AssistReceiptViewSchema.parse(await restarted.receipt(f.a.context, f.proof(request)));
    expect(receipt.state).toBe("found"); expect(receipt.run).toEqual(saved);
    const absent = await restarted.receipt(f.a.context, { requestId: randomUUID(), requestChecksum: "a".repeat(64) });
    expect(absent).toMatchObject({ state: "not_found", run: null });
    expect(await f.state()).toEqual(before);
  });

  it("keeps one original native run, execution and budget through concurrent create, queue loss and read-only receipt replay", async () => {
    const request = await f.knowledgeRequest(), before = await f.state(); f.controls.failQueue = true;
    try {
      const [first, second] = await Promise.all([f.assists.create(f.a.context, request), f.assists.create(f.a.context, request)]);
      expect(first.id).toBe(second.id); expect(first.status).toBe("queued");
      const committed = await f.state();
      for (const table of ["ai_assist_runs", "ai_assist_executions", "ai_budget_ledger"])
        expect(committed.tables[table]!.count - before.tables[table]!.count).toBe(1);
      const restarted = f.newAssists();
      const views = await Promise.all([restarted.receipt(f.a.context, f.proof(request)), restarted.receipt(f.a.context, f.proof(request))]);
      expect(views.map(value => value.run?.id)).toEqual([first.id, first.id]);
      await expect(restarted.receipt(f.a.context, f.proof({ ...request, taskGoal: "Synthetic changed original body" }))).rejects.toMatchObject({ response: { code: "assist_request_binding_mismatch" } });
      await expect(restarted.create(f.a.context, { ...request, taskGoal: "Synthetic changed original body" })).rejects.toBeInstanceOf(ConflictException);
      expect(await f.state()).toEqual(committed);
    } finally { f.controls.failQueue = false; }
  });

  it("reads submitted-unknown and saved-response checkpoints without resubmission, processing or budget release", async () => {
    const uncertainRequest = await f.knowledgeRequest(), uncertain = await f.assists.create(f.a.context, uncertainRequest);
    const calls = f.providerRequests.length;
    f.controls.beforeResponse = async () => { throw new DOMException("Synthetic transport response lost", "TimeoutError"); };
    try { await f.process(uncertain.id); } finally { f.controls.beforeResponse = undefined; }
    const [uncertainExecution] = await withTenant(database.db, f.a.context, tx => tx.select().from(aiAssistExecutions).where(eq(aiAssistExecutions.runId, uncertain.id)));
    expect(uncertainExecution).toMatchObject({ phase: "uncertain", submissionState: "submitted" });
    expect(f.providerRequests.length - calls).toBe(1);
    const checkpointRequest = await f.knowledgeRequest(), checkpoint = await f.assists.create(f.a.context, checkpointRequest);
    const originalEncrypt = f.vault.encrypt.bind(f.vault);
    const interrupt = vi.spyOn(f.vault, "encrypt").mockImplementation(value => {
      if (Object.hasOwn(JSON.parse(value) as object, "result")) throw new Error("Synthetic local output storage interrupted");
      return originalEncrypt(value);
    });
    try { expect(await f.process(checkpoint.id)).toMatchObject({ disposition: "recovery_pending" }); }
    finally { interrupt.mockRestore(); }
    const [storedCheckpoint] = await withTenant(database.db, f.a.context, tx => tx.select().from(aiAssistExecutions).where(eq(aiAssistExecutions.runId, checkpoint.id)));
    expect(storedCheckpoint).toMatchObject({ phase: "response_ready", submissionState: "received" });
    const before = await f.state(), restarted = f.newAssists();
    expect((await restarted.receipt(f.a.context, f.proof(uncertainRequest))).run?.invocations?.[0]).toMatchObject({ state: "uncertain", boundary: "submitted", billing: { budgetState: "reserved" } });
    expect((await restarted.receipt(f.a.context, f.proof(checkpointRequest))).run?.invocations?.[0]).toMatchObject({ boundary: "received", billing: { budgetState: "committed" } });
    expect(await f.state()).toEqual(before);
  });

  it("keeps request lookup private across actors and tenants and rechecks each original read permission and ceiling", async () => {
    const request = await f.knowledgeRequest(), original = await f.assists.create(f.a.context, request); await f.process(original.id);
    const before = await f.state();
    for (const actor of [f.second, f.foreign])
      expect(await f.assists.receipt(actor.context, f.proof(request))).toMatchObject({ state: "not_found", run: null });
    const ceiling = { ...f.a.context, permissionScopes: { ...f.a.context.permissionScopes, [Permission.WorkflowRead]: "self" as const } };
    await expect(f.assists.receipt(ceiling, f.proof(request))).rejects.toBeInstanceOf(ForbiddenError);
    await f.scopes(f.a, { ...allScopes(), [Permission.WorkflowRead]: "self" });
    await expect(f.assists.receipt(f.a.context, f.proof(request))).rejects.toBeInstanceOf(ForbiddenError);
    await f.scopes(f.a, allScopes());
    expect(await f.state()).toEqual(before);
    await f.memberActive(f.a, false);
    try { await expect(f.assists.receipt(f.a.context, f.proof(request))).rejects.toBeInstanceOf(ForbiddenError); }
    finally { await f.memberActive(f.a, true); }
  });

  it("retains a stale original order receipt without requeueing and still requires current PII access for its original body", async () => {
    const parent = await f.order(), detail = await f.orderWorkspace.detail(f.a.context, parent.lines[0]!.id);
    const request = CreateAssistSchema.options[2].parse({ kind: "order_review", orderLineId: detail.line.id,
      expectedRevision: detail.line.revision, expectedSourceVersionId: detail.report?.versionId ?? null, modelId: f.modelId, requestId: randomUUID() });
    const original = await f.assists.create(f.a.context, request);
    await f.orderWorkspace.save(f.a.context, request.orderLineId, { expectedRevision: detail.line.revision, expectedSourceVersionId: detail.report?.versionId ?? null,
      draft: { ...detail.draft, instructions: "Synthetic later original order revision" }, status: "needs_information", reason: "Synthetic real source advance", idempotencyKey: randomUUID() });
    const before = await f.state();
    expect(await f.assists.receipt(f.a.context, f.proof(request))).toMatchObject({ state: "found", run: { id: original.id, status: "queued", stale: true, result: null } });
    expect(await f.state()).toEqual(before);
    await f.scopes(f.a, { ...allScopes(), [Permission.OrderPiiRead]: "self" });
    try { await expect(f.assists.receipt(f.a.context, f.proof(request))).rejects.toBeInstanceOf(ForbiddenError); }
    finally { await f.scopes(f.a, allScopes()); }
    expect(await f.state()).toEqual(before);
  });

  it("fences late receipt bodies on team-authority and retention changes while preserving original encrypted rows and costs", async () => {
    const team = await f.team(f.a), context = await f.current(f.a);
    const request = await f.knowledgeRequest(), original = await f.assists.create(context, request); await f.process(original.id);
    const readOriginal = f.assists.get.bind(f.assists);
    for (const phase of ["team", "expiry"] as const) {
      const phaseContext = phase === "team" ? context : await f.current(f.a);
      const reached = deferred(), release = deferred();
      const hold = vi.spyOn(f.assists, "get").mockImplementationOnce(async (...args) => {
        const value = await readOriginal(...args); expect(value.result?.summary).toBe("Synthetic original response");
        reached.resolve(); await bounded(release.promise, "Receipt release gate missing"); return value;
      });
      const pending = f.assists.receipt(phaseContext, f.proof(request)); void pending.catch(() => {});
      try {
        await bounded(reached.promise, "Actual original receipt body was not read");
        if (phase === "team") await f.teamActive(f.a, team.memberId, false);
        else {
          const [row] = await withTenant(database.db, f.a.context, tx => tx.select({ expiresAt: aiAssistRuns.expiresAt }).from(aiAssistRuns).where(eq(aiAssistRuns.id, original.id)));
          vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(row!.expiresAt.getTime() + 1);
        }
        const before = await f.state(); release.resolve();
        await expect(pending).rejects.toMatchObject({ response: { code: phase === "team" ? "authority_changed" : "assist_request_expired" } });
        if (phase === "expiry") {
          const expired = await f.newAssists().receipt(phaseContext, f.proof(request));
          expect(expired.run).toMatchObject({ id: original.id, status: "completed", request: null, result: null, images: [] });
        }
        expect(await f.state()).toEqual(before);
      } finally {
        release.resolve(); await pending.catch(() => {}); hold.mockRestore(); vi.useRealTimers();
        if (phase === "team") await f.teamActive(f.a, team.memberId, true);
      }
    }
  });

  it("keeps ordinary order and after-sales object searches inside current per-bit read and PII scope", async () => {
    await f.order();
    const actor = await f.actor(f.a.tenantId), tasks = new AssistTaskWorkspaceService(database, f.assists, f.contexts, f.orderWorkspace, f.editor);
    for (const narrowed of [Permission.OrderRead, Permission.OrderPiiRead]) {
      await f.scopes(actor, { [Permission.OrderRead]: "tenant", [Permission.OrderPiiRead]: "tenant", [Permission.FinanceRead]: "tenant", [narrowed]: "self" });
      for (const kind of ["order_review", "after_sales_review"] as const)
        await expect(tasks.targets(actor.context, { kind, q: "" })).rejects.toBeInstanceOf(ForbiddenError);
    }
    await f.scopes(actor, { [Permission.OrderRead]: "tenant", [Permission.OrderPiiRead]: "tenant" });
    const before = await f.state();
    const control = await tasks.targets(actor.context, { kind: "order_review", q: "" });
    expect(control.items.length).toBeGreaterThan(0);
    expect(await f.state()).toEqual(before);
  });
});
