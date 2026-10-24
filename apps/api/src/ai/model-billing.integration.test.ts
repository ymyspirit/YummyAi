import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Permission } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import {
  aiAssistRuns as runs,
  aiAssistExecutions as executions,
  aiBudgetLedger as ledger,
  modelBillingReconciliations as receipts,
  memberships,
  membershipRoles,
  roles,
  modelProviderConfigs,
  podArtworkInvocations,
  podArtworkTasks,
  designTasks,
  connectDatabase,
  migrateDatabase,
  readModelBillingAcknowledgments,
  withTenant,
} from "@yummyai/database";
import { eq, sql } from "drizzle-orm";
import { ModelBillingService } from "./model-billing.service.js";
import { DrizzleCatalogRepository, ProductService } from "../catalog/product.service.js";
import { PodArtworkTaskService } from "../design/pod-artwork-task.service.js";
import { PodWorkbenchService } from "../design/pod-workbench.service.js";
import { AuditService } from "../audit/audit.service.js";

const url = new URL(process.env.DATABASE_URL ?? "postgres://invalid/invalid");
if (
  process.env.E2E_ISOLATED_DAILY !== "1" ||
  !/^\/order_daily_e2e_[a-f0-9]{32}$/.test(url.pathname)
)
  throw new Error("Model billing tests require disposable resources");
describe("model billing original-owner evidence and atomic reconciliation", () => {
  const database = connectDatabase(),
    service = new ModelBillingService(database);
  const a: TenantContext = {
      tenantId: createEntityId(),
      userId: createEntityId(),
      permissions: Object.values(Permission),
      dataScope: "tenant",
    },
    b = { ...a, tenantId: createEntityId(), userId: createEntityId() };
  const roleIds = new Map<string, string>(),
    providerIds = new Map<string, string>();
  const checksum = (value: string) => createHash("sha256").update(value).digest("hex");
  beforeAll(async () => {
    await migrateDatabase(database);
    process.env.MODEL_BILLING_TENANT_IDS = a.tenantId + "," + b.tenantId;
    for (const context of [a, b]) {
      await database.client.unsafe(
        "insert into organizations(id,name,slug)values($1,'Synthetic billing',$2)",
        [context.tenantId, "billing-" + context.tenantId],
      );
      await database.client.unsafe(
        "insert into app_users(id,oidc_subject,email,display_name)values($1,$2,$3,'Synthetic billing reviewer')",
        [context.userId, "billing-" + context.userId, context.userId + "@example.test"],
      );
      await withTenant(database.db, context, async (tx) => {
        const member = createEntityId(),
          role = createEntityId(),
          provider = createEntityId();
        roleIds.set(context.tenantId, role);
        providerIds.set(context.tenantId, provider);
        await tx.insert(memberships).values({
          id: member,
          tenantId: context.tenantId,
          userId: context.userId,
          status: "active",
        });
        await tx.insert(roles).values({
          id: role,
          tenantId: context.tenantId,
          name: "Synthetic billing role",
          permissions: context.permissions,
          dataScope: "tenant",
        });
        await tx
          .insert(membershipRoles)
          .values({ tenantId: context.tenantId, membershipId: member, roleId: role });
        await tx.insert(modelProviderConfigs).values({
          id: provider,
          tenantId: context.tenantId,
          provider: "openai-compatible",
          label: "Synthetic billing provider",
          encryptedApiKey: "unused-synthetic-key",
          createdBy: context.userId,
        });
      });
    }
  });
  afterAll(async () => {
    delete process.env.MODEL_BILLING_TENANT_IDS;
    await database.client.end();
  });
  async function run(
    options: {
      context?: TenantContext;
      cost?: string | null;
      budget?: string | null;
      started?: boolean;
      phase?: "completed" | "preparing" | "failed";
      submitted?: boolean;
      providerRequestId?: string;
      createdAt?: Date;
    } = {},
  ) {
    const context = options.context ?? a,
      id = createEntityId(),
      createdAt = options.createdAt ?? new Date(),
      submitted = options.submitted ?? true;
    await withTenant(database.db, context, async (tx) => {
      await tx.insert(runs).values({
        id,
        tenantId: context.tenantId,
        ownerId: context.userId,
        requestId: createEntityId(),
        kind: "knowledge_answer",
        scope: "synthetic-billing",
        status: "failed",
        inputFingerprint: checksum(id),
        requestFingerprint: checksum(id + "request"),
        modelSnapshot: {
          id: createEntityId(),
          label: "Synthetic billing model",
          model: "synthetic-model",
          providerLabel: "Synthetic billing provider",
          providerConfigId: providerIds.get(context.tenantId)!,
          inputUsdPerMillion: options.cost ? 1 : null,
          outputUsdPerMillion: options.cost ? 2 : null,
          maxTaskCostUsd: options.budget ? 1 : null,
        },
        promptVersion: "synthetic-billing-v1",
        reservedCostUsd: options.budget ?? "0",
        costUsd: options.cost ?? null,
        inputTokens: options.cost ? 1000 : null,
        outputTokens: options.cost ? 1000 : null,
        createdAt,
        startedAt: options.started === false ? null : createdAt,
        completedAt: createdAt,
        expiresAt: new Date(Date.now() + 86400000),
      });
      await tx.insert(executions).values({
        runId: id,
        tenantId: context.tenantId,
        inputFingerprint: checksum(id),
        policyChecksum: checksum("policy"),
        phase: options.phase ?? "failed",
        submissionState: submitted ? "submitted" : "not_submitted",
        submittedAt: submitted ? createdAt : null,
        providerRequestId: submitted ? (options.providerRequestId ?? "synthetic-" + id) : null,
      });
      if (options.budget !== null && options.budget !== undefined)
        await tx.insert(ledger).values({
          id: createEntityId(),
          tenantId: context.tenantId,
          requestId: id,
          taskType: "knowledge_answer",
          modelKey: "synthetic-model",
          provider: "openai-compatible",
          amountUsd: options.budget,
          state: "released",
          createdAt,
        });
    });
    return id;
  }
  async function input(id: string, amountUsd = "0.12345678", context = a) {
    const basis = await service.basis(context, "assist", id);
    return {
      commandId: createEntityId(),
      expectedFingerprint: basis.fingerprint,
      amountUsd,
      currency: "USD",
      evidenceKind: "provider_invoice",
      invoiceReference: "synthetic-invoice",
      providerRequestId: basis.providerRequestId ?? "synthetic-manual-" + id,
      proofChecksum: checksum(id),
      matchesOriginalRequest: true,
    };
  }
  async function balances(id: string) {
    return withTenant(database.db, a, async (tx) => ({
      runs: await tx.select().from(runs).where(eq(runs.id, id)),
      ledger: await tx.select().from(ledger).where(eq(ledger.requestId, id)),
      receipts: await tx.select().from(receipts).where(eq(receipts.subjectId, id)),
    }));
  }

  it("retains configured cost, corrects the canonical budget and atomically records an immutable attestation", async () => {
    const id = await run({ cost: "0.003000", budget: "0.010000" }),
      body = await input(id),
      result = await service.confirm(a, "assist", id, body);
    expect(result).toMatchObject({
      replayed: false,
      receipt: {
        verification: "operator_attested",
        amountUsd: "0.12345678",
        sequence: 1,
        budgetImpact: {
          beforeState: "released",
          beforeAmountUsd: "0.010000",
          afterState: "committed",
          afterAmountUsd: "0.123457",
        },
      },
    });
    const stored = await balances(id);
    expect(stored.runs[0]?.costUsd).toBe("0.003000");
    expect(stored.ledger[0]?.amountUsd).toBe("0.123457");
    expect(stored.receipts).toHaveLength(1);
    await expect(
      withTenant(database.db, a, (tx) =>
        tx.update(ledger).set({ amountUsd: "0.9" }).where(eq(ledger.requestId, id)),
      ),
    ).rejects.toMatchObject({ cause: { code: "23514" } });
    const original = stored.receipts[0]!;
    await expect(
      withTenant(database.db, a, (tx) =>
        tx
          .insert(receipts)
          .values({
            ...original,
            id: createEntityId(),
            commandId: createEntityId(),
            sequence: 2,
            previousId: original.id,
            amountUsd: "0.9",
            budgetImpact: {
              ...original.budgetImpact!,
              beforeState: "committed",
              beforeAmountUsd: "0.123457",
              afterAmountUsd: "0.900000",
              periodStartedAt: "2000-01-01T00:00:00.000Z",
            },
          }),
      ),
    ).rejects.toMatchObject({ cause: { code: "23514" } });
    expect((await balances(id)).ledger[0]?.amountUsd).toBe("0.123457");
    expect((await balances(id)).receipts).toHaveLength(1);
    await expect(
      database.client.unsafe("update model_billing_reconciliations set amount_usd=1 where id=$1", [
        result.receipt.id,
      ]),
    ).rejects.toMatchObject({ code: "55000" });
    await expect(
      withTenant(database.db, a, (tx) =>
        tx.execute(sql`delete from ${receipts} where id=${result.receipt.id}`),
      ),
    ).rejects.toMatchObject({ cause: { code: "42501" } });
    const audit = await database.client.unsafe(
      "select metadata from audit_events where entity_id=$1",
      [result.receipt.id],
    );
    expect(JSON.stringify(audit)).not.toContain("synthetic-invoice");
    expect(JSON.stringify(audit)).not.toContain(body.providerRequestId);
  });
  it("replays commands without reapplying an earlier amount after a later correction", async () => {
    const id = await run({ budget: "1" }),
      first = await input(id, "0.1"),
      original = await service.confirm(a, "assist", id, first);
    const second = await input(id, "0.2"),
      corrected = await service.confirm(a, "assist", id, second);
    expect(corrected.receipt.previousId).toBe(original.receipt.id);
    expect((await service.confirm(a, "assist", id, first)).replayed).toBe(true);
    expect((await balances(id)).ledger[0]?.amountUsd).toBe("0.200000");
    await expect(
      service.confirm(a, "assist", id, { ...first, amountUsd: "0.3" }),
    ).rejects.toMatchObject({ status: 409 });
  });
  it("accepts one concurrent confirmation and preserves the losing command for deliberate review", async () => {
    const id = await run({ budget: "1" }),
      body = await input(id),
      results = await Promise.allSettled([
        service.confirm(a, "assist", id, body),
        service.confirm(a, "assist", id, {
          ...body,
          commandId: createEntityId(),
          amountUsd: "0.9",
        }),
      ]);
    expect(results.filter((value) => value.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((value) => value.status === "rejected")).toHaveLength(1);
    expect((await balances(id)).receipts).toHaveLength(1);
  });
  it("creates an unpriced original budget in the original month and preserves sub-microdollar evidence", async () => {
    const createdAt = new Date("2026-08-15T00:00:00.000Z"),
      id = await run({ createdAt }),
      result = await service.confirm(a, "assist", id, await input(id, "0.00000001"));
    expect(result.receipt.amountUsd).toBe("0.00000001");
    expect(result.receipt.budgetImpact).toMatchObject({
      beforeState: null,
      afterAmountUsd: "0.000001",
      periodStartedAt: createdAt.toISOString().replace(".000Z", ".000000Z"),
    });
    const stored = await balances(id);
    expect(stored.runs[0]?.costUsd).toBeNull();
    expect(stored.ledger[0]?.createdAt).toEqual(createdAt);
    expect(stored.ledger[0]?.provider).toBe("openai-compatible");
  });
  it("rejects active, never-submitted and changed original evidence without a partial ledger write", async () => {
    for (const options of [{ phase: "preparing" as const }, { submitted: false }]) {
      const id = await run(options);
      await expect(service.confirm(a, "assist", id, await input(id))).rejects.toMatchObject({
        status: 409,
      });
      expect((await balances(id)).ledger).toEqual([]);
    }
    const id = await run({ budget: "1" }),
      body = await input(id);
    await service.confirm(a, "assist", id, {
      ...body,
      commandId: createEntityId(),
      amountUsd: "0.5",
    });
    await expect(service.confirm(a, "assist", id, body)).rejects.toMatchObject({ status: 409 });
    expect((await balances(id)).receipts).toHaveLength(1);
  });
  it("requires exact known request identity and rejects cross-allocation of the same source request", async () => {
    const first = await run(),
      body = await input(first);
    await expect(
      service.confirm(a, "assist", first, { ...body, providerRequestId: "wrong-request" }),
    ).rejects.toMatchObject({ status: 409 });
    await service.confirm(a, "assist", first, body);
    const second = await run({ providerRequestId: body.providerRequestId });
    await expect(
      service.confirm(a, "assist", second, {
        ...(await input(second)),
        proofChecksum: body.proofChecksum,
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect((await balances(second)).receipts).toEqual([]);
  });
  it("checks current grants, tenant scope and tenant rollout before exposing invoice metadata", async () => {
    const id = await run(),
      roleId = roleIds.get(a.tenantId)!;
    await expect(service.basis(b, "assist", id)).rejects.toMatchObject({ status: 404 });
    try {
      await withTenant(database.db, a, (tx) =>
        tx.update(roles).set({ permissions: [] }).where(eq(roles.id, roleId)),
      );
      await expect(service.basis(a, "assist", id)).rejects.toThrow();
      await withTenant(database.db, a, (tx) =>
        tx
          .update(roles)
          .set({ permissions: a.permissions, dataScope: "self" })
          .where(eq(roles.id, roleId)),
      );
      await expect(service.workspace(a, {})).rejects.toThrow();
      await withTenant(database.db, a, (tx) =>
        tx.update(roles).set({ dataScope: "tenant" }).where(eq(roles.id, roleId)),
      );
      process.env.MODEL_BILLING_TENANT_IDS = "";
      await expect(service.basis(a, "assist", id)).rejects.toMatchObject({ status: 503 });
    } finally {
      process.env.MODEL_BILLING_TENANT_IDS = a.tenantId + "," + b.tenantId;
      await withTenant(database.db, a, (tx) =>
        tx
          .update(roles)
          .set({ permissions: a.permissions, dataScope: "tenant" })
          .where(eq(roles.id, roleId)),
      );
    }
  });
  it("returns latest safe acknowledgments without invoice text or provider request metadata", async () => {
    const id = await run();
    await service.confirm(a, "assist", id, await input(id, "0.4"));
    await service.confirm(a, "assist", id, await input(id, "0.5"));
    const safe = await withTenant(database.db, a, (tx) =>
      readModelBillingAcknowledgments(tx, "assist", [id]),
    );
    expect(safe.get(id)?.amountUsd).toBe("0.50000000");
    expect(JSON.stringify([...safe])).not.toContain("synthetic-invoice");
    expect(JSON.stringify([...safe])).not.toContain("synthetic-" + id);
    expect(
      await withTenant(database.db, b, (tx) => readModelBillingAcknowledgments(tx, "assist", [id])),
    ).toEqual(new Map());
  });
  it("pages by database microseconds and UUID without dropping records sharing one timestamp", async () => {
    const now = new Date("2026-10-16T00:00:00.123Z");
    for (let i = 0; i < 24; i++) await run({ createdAt: now });
    const seen = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await service.workspace(a, {
        scope: "all",
        ...(cursor ? { after: cursor } : {}),
      });
      for (const row of page.items) {
        expect(seen.has(row.id)).toBe(false);
        seen.add(row.id);
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(seen.size).toBeGreaterThanOrEqual(24);
    await expect(service.workspace(a, { after: "not-a-valid-cursor" })).rejects.toMatchObject({
      status: 400,
    });
  });
  it("keeps POD response costs and outcomes immutable while recording independent manual fees", async () => {
    const catalog = new ProductService(new DrizzleCatalogRepository(database));
    const plan = await catalog.createPlan(a, {
      name: "Synthetic billing product",
      sourceReportIds: [createEntityId()],
      customization: { version: 1, fields: [] },
    });
    await catalog.transition(a, plan.id, "pending_approval");
    await catalog.transition(a, plan.id, "approved");
    const spu = await catalog.createSpu(a, plan.id, {
      code: "BILLING-POD",
      name: "Synthetic product",
    });
    const sku = await catalog.createSku(a, { spuId: spu.id, code: "BILLING-SKU", attributes: {} });
    const designId = createEntityId(),
      taskId = createEntityId(),
      invocationId = createEntityId(),
      now = new Date();
    await withTenant(database.db, a, async (tx) => {
      await tx.insert(designTasks).values({
        id: designId,
        tenantId: a.tenantId,
        skuId: sku.id,
        title: "Synthetic fee evidence",
        brief: "Synthetic no model call",
      });
      await tx.insert(podArtworkTasks).values({
        id: taskId,
        tenantId: a.tenantId,
        designTaskId: designId,
        toolKey: "text_to_image",
        status: "failed",
        parameterSnapshot: {
          designTool: "text_to_image",
          prompt: "Synthetic",
          referenceStrength: 70,
          creativity: 50,
          aspectRatio: "1:1",
          outputCount: 1,
          outputFormat: "png",
          markAiGenerated: true,
          markGeneratedAreas: true,
        },
        idempotencyKey: createEntityId(),
        requestedBy: a.userId,
        startedAt: now,
        completedAt: now,
      });
      await tx.insert(podArtworkInvocations).values({
        id: invocationId,
        tenantId: a.tenantId,
        taskId,
        attemptNumber: 1,
        phase: "failed",
        submittedAt: now,
        receivedAt: now,
        finishedAt: now,
        providerRequestId: "pod-synthetic-request",
        responseChecksum: checksum("pod-response"),
        reportedCostUsd: "0.01000000",
        metadataValid: true,
        modelKey: "synthetic-pod",
      });
    });
    const original = await service.basis(a, "pod", invocationId);
    const result = await service.confirm(a, "pod", invocationId, {
      ...(await input(await run())),
      expectedFingerprint: original.fingerprint,
      providerRequestId: "pod-synthetic-request",
      amountUsd: "0.02",
      proofChecksum: checksum(invocationId),
    });
    expect(result.receipt.budgetImpact).toBeNull();
    const pod = new PodArtworkTaskService(
      database,
      { enqueue: async () => undefined },
      new PodWorkbenchService({ enabledTools: () => new Set(["text_to_image"]) }),
      new AuditService(database),
    );
    const view = await pod.get(a, taskId);
    expect(view.status).toBe("failed");
    expect(view.invocations?.[0]?.billing).toMatchObject({
      amountUsd: "0.01000000",
      needsProviderEvidence: false,
      reconciliation: { amountUsd: "0.02000000", verification: "operator_attested" },
    });
    expect(JSON.stringify(view)).not.toContain("synthetic-invoice");
    expect(
      await withTenant(database.db, a, (tx) =>
        tx.select().from(ledger).where(eq(ledger.requestId, invocationId)),
      ),
    ).toEqual([]);
  });
});
