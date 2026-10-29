import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Permission } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import type { ModelTokenUsage } from "@yummyai/contracts/ai/model-usage";
import {
  ModelBillingBasisSchema,
  ModelBillingWorkspaceSchema,
} from "@yummyai/contracts/ai/model-billing";
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
  marketplaceAccounts,
  orderSourceSnapshots,
  orders,
  orderLines,
  orderWorkItems,
  orderWorkRevisions,
  orderDesignAgentRuns,
  orderDesignAgentSteps,
  orderDesignModelCalls,
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
      modelId?: string;
      status?: "failed" | "cancelled";
      tokenUsage?: ModelTokenUsage;
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
        status: options.status ?? "failed",
        inputFingerprint: checksum(id),
        requestFingerprint: checksum(id + "request"),
        modelSnapshot: {
          id: createEntityId(),
          label: "Synthetic billing model",
          model: options.modelId ?? "synthetic-model",
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
      if (options.tokenUsage) {
        // Migration 193 accepts the original first receipt and usage in the same transaction.
        if (!submitted) throw new Error("Synthetic native usage requires an original submission");
        await tx
          .update(executions)
          .set({
            submissionState: "received",
            receivedAt: createdAt,
            responseChecksum: checksum("response-" + id),
          })
          .where(eq(executions.runId, id));
        await tx.update(runs).set({ tokenUsage: options.tokenUsage }).where(eq(runs.id, id));
      }
      if (options.budget !== null && options.budget !== undefined)
        await tx.insert(ledger).values({
          id: createEntityId(),
          tenantId: context.tenantId,
          requestId: id,
          taskType: "knowledge_answer",
          modelKey: options.modelId ?? "synthetic-model",
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
      executions: await tx.select().from(executions).where(eq(executions.runId, id)),
      ledger: await tx.select().from(ledger).where(eq(ledger.requestId, id)),
      receipts: await tx.select().from(receipts).where(eq(receipts.subjectId, id)),
    }));
  }
  const solUsage: ModelTokenUsage = {
    version: "model-token-usage-v1",
    inputTokens: 1_000,
    outputTokens: 100,
    cachedInputTokens: 400,
    cacheWriteInputTokens: 0,
    totalTokens: 1_100,
    totalTokensBasis: "provider",
  };
  const imageUsage: ModelTokenUsage = {
    version: "model-token-usage-v1",
    inputTokens: 300,
    outputTokens: 300,
    cachedInputTokens: 70,
    totalTokens: 600,
    totalTokensBasis: "provider",
    inputTextTokens: 100,
    inputImageTokens: 200,
    outputTextTokens: 0,
    outputImageTokens: 300,
  };
  async function podReceipt() {
    const catalog = new ProductService(new DrizzleCatalogRepository(database));
    const plan = await catalog.createPlan(a, {
      name: "Synthetic official price reference",
      sourceReportIds: [createEntityId()],
      customization: { version: 1, fields: [] },
    });
    await catalog.transition(a, plan.id, "pending_approval");
    await catalog.transition(a, plan.id, "approved");
    const spu = await catalog.createSpu(a, plan.id, {
      code: createEntityId(),
      name: "Synthetic price reference",
    });
    const sku = await catalog.createSku(a, {
      spuId: spu.id,
      code: createEntityId(),
      attributes: {},
    });
    const designId = createEntityId(),
      taskId = createEntityId(),
      id = createEntityId(),
      now = new Date();
    await withTenant(database.db, a, async (tx) => {
      await tx.insert(designTasks).values({
        id: designId,
        tenantId: a.tenantId,
        skuId: sku.id,
        title: "Synthetic native usage",
        brief: "No image or model execution",
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
        id,
        tenantId: a.tenantId,
        taskId,
        attemptNumber: 1,
        phase: "submitted",
        submittedAt: now,
        modelKey: "gpt-image-2.5-flare",
      });
      await tx
        .update(podArtworkInvocations)
        .set({
          phase: "received",
          receivedAt: now,
          responseChecksum: checksum(id),
          providerRequestId: "synthetic-pod-" + id,
          metadataValid: true,
          reportedCostUsd: "0.01000000",
          tokenUsage: imageUsage,
        })
        .where(eq(podArtworkInvocations.id, id));
      await tx
        .update(podArtworkInvocations)
        .set({ phase: "failed", finishedAt: now })
        .where(eq(podArtworkInvocations.id, id));
    });
    return id;
  }
  async function orderCall(tokenUsage?: ModelTokenUsage) {
    const accountId = createEntityId(),
      snapshotId = createEntityId(),
      orderId = createEntityId(),
      lineId = createEntityId();
    const revisionId = createEntityId(),
      runId = createEntityId(),
      stepId = createEntityId(),
      id = createEntityId();
    const requestId = createEntityId(),
      claimToken = createEntityId(),
      budgetId = createEntityId();
    await withTenant(database.db, a, async (tx) => {
      await tx.insert(marketplaceAccounts).values({
        id: accountId,
        tenantId: a.tenantId,
        platform: "amazon",
        displayName: "Synthetic unconnected billing account " + accountId,
        region: "NA",
        authorizationMode: "amazon_private",
      });
      await tx.insert(orderSourceSnapshots).values({
        id: snapshotId,
        tenantId: a.tenantId,
        accountId,
        platform: "amazon",
        externalEventId: snapshotId,
        externalOrderId: orderId,
        normalizedOrderId: orderId,
        redactedPayload: {},
        payloadChecksum: checksum(snapshotId),
      });
      await tx.insert(orders).values({
        id: orderId,
        tenantId: a.tenantId,
        accountId,
        sourceSnapshotId: snapshotId,
        platform: "amazon",
        externalOrderId: orderId,
        providerStatus: "synthetic",
        lineCount: 1,
        placedAt: new Date(),
      });
      await tx.insert(orderLines).values({
        id: lineId,
        tenantId: a.tenantId,
        orderId,
        externalLineId: lineId,
        title: "Synthetic model billing only",
        quantity: 1,
      });
      await tx
        .insert(orderWorkItems)
        .values({ id: lineId, tenantId: a.tenantId, expiresAt: new Date("2099-01-01T00:00:00Z") });
      await tx.insert(orderWorkRevisions).values({
        id: revisionId,
        tenantId: a.tenantId,
        workItemId: lineId,
        revision: 1,
        encryptedDraft: "synthetic-sealed-draft",
        checksum: checksum(lineId),
        createdBy: a.userId,
      });
      await tx.insert(orderDesignAgentRuns).values({
        id: runId,
        tenantId: a.tenantId,
        workItemId: lineId,
        workRevisionId: revisionId,
        status: "running",
        executorKey: "strict-template",
        recipeVersion: "synthetic-v1",
        policyVersion: "synthetic-v1",
        encryptedSnapshot: "synthetic-sealed-snapshot",
        inputChecksum: checksum(lineId),
        processingToken: claimToken,
        requestedBy: a.userId,
      });
      await tx.insert(orderDesignAgentSteps).values({
        id: stepId,
        tenantId: a.tenantId,
        runId,
        key: "enhance_image_1",
        label: "Synthetic original submission",
        position: 0,
        status: "running",
        attempt: 1,
        requestId,
        encryptedInput: "synthetic-sealed-input",
        inputChecksum: checksum(lineId),
      });
      await tx.insert(ledger).values({
        id: budgetId,
        tenantId: a.tenantId,
        requestId,
        taskType: "order_design",
        modelKey: "gpt-image-2.5-flare",
        provider: "openai-compatible",
        amountUsd: "0.100000",
        state: "reserved",
      });
      await tx.insert(orderDesignModelCalls).values({
        id,
        tenantId: a.tenantId,
        runId,
        stepId,
        requestId,
        attempt: 1,
        claimToken,
        budgetLedgerId: budgetId,
        requestedBy: a.userId,
      });
      if (tokenUsage)
        await tx
          .update(orderDesignModelCalls)
          .set({ receivedAt: new Date(), costReportState: "unknown", tokenUsage })
          .where(eq(orderDesignModelCalls.id, id));
      await tx
        .update(orderDesignAgentSteps)
        .set({ status: "failed", errorCode: "synthetic_failure" })
        .where(eq(orderDesignAgentSteps.id, stepId));
      await tx
        .update(orderDesignAgentRuns)
        .set({ status: "needs_attention", processingToken: null, errorCode: "synthetic_failure" })
        .where(eq(orderDesignAgentRuns.id, runId));
    });
    return { id, runId, stepId, budgetId };
  }
  async function orderBalances(call: Awaited<ReturnType<typeof orderCall>>) {
    return withTenant(database.db, a, async (tx) => ({
      call: await tx
        .select()
        .from(orderDesignModelCalls)
        .where(eq(orderDesignModelCalls.id, call.id)),
      run: await tx
        .select()
        .from(orderDesignAgentRuns)
        .where(eq(orderDesignAgentRuns.id, call.runId)),
      step: await tx
        .select()
        .from(orderDesignAgentSteps)
        .where(eq(orderDesignAgentSteps.id, call.stepId)),
      budget: await tx.select().from(ledger).where(eq(ledger.id, call.budgetId)),
      receipts: await tx.select().from(receipts).where(eq(receipts.subjectId, call.id)),
    }));
  }

  it("reads the official catalog and original native Assist usage without changing fees or budgets", async () => {
    const id = await run({
      modelId: "gpt-6.1-sol",
      tokenUsage: solUsage,
      cost: "0.003000",
      budget: "0.010000",
    });
    const before = await balances(id);
    const workspace = ModelBillingWorkspaceSchema.parse(
      await service.workspace(a, { scope: "all" }),
    );
    expect(workspace.officialPriceCatalog).toMatchObject({
      currency: "USD",
      unitTokens: 1_000_000,
      basis: "official_standard_list_price",
    });
    expect(workspace.officialPriceCatalog?.rates.map((row) => row.modelId)).toEqual([
      "gpt-6.1-sol",
      "gpt-image-2",
      "gpt-image-2.5-flare",
      "gpt-image-2.5-sunburst",
    ]);
    expect(workspace.items.find((row) => row.id === id)).toMatchObject({
      owner: "assist",
      state: "failed",
      reconciled: false,
    });
    const basis = ModelBillingBasisSchema.parse(await service.basis(a, "assist", id));
    expect(basis.officialPriceCheck).toMatchObject({
      modelId: "gpt-6.1-sol",
      status: "calculated",
      amountUsd: "0.00224000",
      usage: solUsage,
      endpointKind: "responses",
    });
    expect(basis.history).toEqual([]);
    expect(before.runs[0]?.costUsd).toBe("0.003000");
    expect(before.ledger[0]).toMatchObject({ amountUsd: "0.010000", state: "released" });
    expect(await balances(id)).toEqual(before);
  });

  it("retains failed and cancelled submissions with unknown usage separately from reported zero", async () => {
    for (const status of ["failed", "cancelled"] as const) {
      const unknown = await run({ modelId: "gpt-6.1-sol", status, budget: "0.010000" });
      const zero = await run({
        modelId: "gpt-6.1-sol",
        status,
        tokenUsage: {
          ...solUsage,
          inputTokens: 0,
          outputTokens: 0,
          cachedInputTokens: 0,
          totalTokens: 0,
        },
      });
      const unknownBefore = await balances(unknown),
        zeroBefore = await balances(zero);
      expect((await service.basis(a, "assist", unknown)).officialPriceCheck).toMatchObject({
        status: "usage_missing",
        amountUsd: null,
        knownSubtotalUsd: null,
      });
      expect((await service.basis(a, "assist", zero)).officialPriceCheck).toMatchObject({
        status: "calculated",
        amountUsd: "0.00000000",
      });
      const page = await service.workspace(a, { scope: "all" });
      expect(page.items.find((row) => row.id === unknown)).toMatchObject({
        owner: "assist",
        state: status,
      });
      expect(page.items.find((row) => row.id === zero)).toMatchObject({
        owner: "assist",
        state: status,
      });
      expect(await balances(unknown)).toEqual(unknownBefore);
      expect(await balances(zero)).toEqual(zeroBefore);
    }
  });

  it("keeps POD transport and cache uncertainty independent from the immutable provider-reported amount", async () => {
    const id = await podReceipt();
    const before = await withTenant(database.db, a, (tx) =>
      tx.select().from(podArtworkInvocations).where(eq(podArtworkInvocations.id, id)),
    );
    const basis = ModelBillingBasisSchema.parse(await service.basis(a, "pod", id));
    expect(basis.officialPriceCheck).toMatchObject({
      modelId: "gpt-image-2.5-flare",
      status: "partial",
      amountUsd: null,
      knownSubtotalUsd: "0.00900000",
      endpointKind: "unknown",
      usage: imageUsage,
    });
    expect(basis.originalInvocation?.billing).toMatchObject({
      amountUsd: "0.01000000",
      needsProviderEvidence: true,
    });
    expect(basis.history).toEqual([]);
    expect(
      await withTenant(database.db, a, (tx) =>
        tx.select().from(podArtworkInvocations).where(eq(podArtworkInvocations.id, id)),
      ),
    ).toEqual(before);
    expect((await balances(id)).ledger).toEqual([]);
    expect((await balances(id)).receipts).toEqual([]);
  });

  it("exposes original order-design image usage read-only and rejects confirmation without changing its reserved ledger", async () => {
    const known = await orderCall(imageUsage),
      unknown = await orderCall();
    const knownBefore = await orderBalances(known),
      unknownBefore = await orderBalances(unknown);
    const basis = ModelBillingBasisSchema.parse(await service.basis(a, "order_design", known.id));
    expect(basis).toMatchObject({
      owner: "order_design",
      subjectId: known.id,
      state: "received",
      providerRequestId: null,
      canConfirm: false,
      originalInvocation: null,
      history: [],
      hasMoreHistory: false,
    });
    expect(basis.blockers.length).toBeGreaterThan(0);
    expect(basis.officialPriceCheck).toMatchObject({
      modelId: "gpt-image-2.5-flare",
      status: "calculated",
      amountUsd: "0.01110000",
      usage: imageUsage,
      endpointKind: "images",
    });
    expect((await service.basis(a, "order_design", unknown.id)).officialPriceCheck).toMatchObject({
      status: "usage_missing",
      amountUsd: null,
    });
    const page = await service.workspace(a, { scope: "all" });
    expect(page.items.find((row) => row.id === known.id)).toMatchObject({
      owner: "order_design",
      state: "received",
      reconciled: false,
    });
    expect(page.items.find((row) => row.id === unknown.id)).toMatchObject({
      owner: "order_design",
      state: "uncertain",
      reconciled: false,
    });
    await expect(
      service.confirm(a, "order_design", known.id, {
        commandId: createEntityId(),
        expectedFingerprint: basis.fingerprint,
        amountUsd: "0.0111",
        currency: "USD",
        evidenceKind: "provider_invoice",
        invoiceReference: "synthetic-unaccepted-invoice",
        providerRequestId: "synthetic-original-call",
        proofChecksum: checksum(known.id),
        matchesOriginalRequest: true,
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(service.basis(b, "order_design", known.id)).rejects.toMatchObject({ status: 404 });
    expect(
      (await service.workspace(b, { scope: "all" })).items.some(
        (row) => row.id === known.id || row.id === unknown.id,
      ),
    ).toBe(false);
    expect(await orderBalances(known)).toEqual(knownBefore);
    expect(await orderBalances(unknown)).toEqual(unknownBefore);
    expect(knownBefore.budget[0]).toMatchObject({ amountUsd: "0.100000", state: "reserved" });
    expect(knownBefore.call[0]?.reportedCostUsd).toBeNull();
  });

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
        tx.insert(receipts).values({
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
