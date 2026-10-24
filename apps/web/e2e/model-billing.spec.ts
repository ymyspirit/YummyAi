import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { Permission } from "../../../packages/authz/src/index";
import {
  connectDatabase,
  withTenant,
  aiAssistRuns,
  aiAssistExecutions,
  aiBudgetLedger,
  modelProviderConfigs,
  roles,
  membershipRoles,
  memberships,
} from "@yummyai/database";
import { and, eq } from "drizzle-orm";
import type { ModelBillingBasis } from "@yummyai/contracts/ai/model-billing";
import type { AssistView } from "@yummyai/contracts/ai/assist";
import { getApiHeaders } from "../src/server-api";
import { centerApi } from "./order-centers-fixture";

test("manual model fee review preserves original evidence, keeps conflict drafts and clears revoked access", async ({
  page,
}, testInfo) => {
  const url = new URL(process.env.DATABASE_URL ?? "postgres://invalid/invalid");
  if (
    process.env.E2E_ISOLATED_DAILY !== "1" ||
    !/^\/order_daily_e2e_[a-f0-9]{32}$/.test(url.pathname)
  )
    throw new Error("Billing browser requires disposable resources");
  const database = connectDatabase(),
    headers = await getApiHeaders(),
    claims = JSON.parse(Buffer.from(headers.authorization!.split(".")[1]!, "base64url").toString());
  const [identity] = await database.client.unsafe<{ tenant_id: string; user_id: string }[]>(
    "select m.tenant_id,m.user_id from memberships m join app_users u on u.id=m.user_id where u.oidc_subject=$1 and m.status='active'",
    [claims.sub],
  );
  if (!identity) {
    await database.client.end();
    throw new Error("Synthetic billing identity unavailable");
  }
  const context: TenantContext = {
    tenantId: identity.tenant_id,
    userId: identity.user_id,
    permissions: Object.values(Permission),
    dataScope: "tenant",
  };
  const grants = await withTenant(database.db, context, (tx) =>
    tx
      .select({ id: roles.id, permissions: roles.permissions })
      .from(roles)
      .innerJoin(membershipRoles, eq(membershipRoles.roleId, roles.id))
      .innerJoin(memberships, eq(memberships.id, membershipRoles.membershipId))
      .where(eq(memberships.userId, context.userId)),
  );
  const id = createEntityId(),
    proof = Buffer.from("Synthetic model usage invoice no actual provider charge"),
    proofChecksum = createHash("sha256").update(proof).digest("hex"),
    errors: string[] = [],
    posts: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (request.method() === "POST") posts.push(request.postData() ?? "");
  });
  try {
    await withTenant(database.db, context, async (tx) => {
      const [provider] = await tx
        .select({ id: modelProviderConfigs.id })
        .from(modelProviderConfigs)
        .where(eq(modelProviderConfigs.label, "Synthetic acceptance only"));
      if (!provider) throw new Error("Missing synthetic provider");
      const now = new Date();
      await tx.insert(aiAssistRuns).values({
        id,
        tenantId: context.tenantId,
        ownerId: context.userId,
        requestId: createEntityId(),
        kind: "knowledge_answer",
        scope: "synthetic-billing",
        status: "failed",
        inputFingerprint: "a".repeat(64),
        requestFingerprint: "b".repeat(64),
        modelSnapshot: {
          id: createEntityId(),
          label: "Synthetic billing browser",
          model: "synthetic-model",
          providerLabel: "Synthetic provider",
          providerConfigId: provider.id,
          inputUsdPerMillion: 1,
          outputUsdPerMillion: 2,
          maxTaskCostUsd: 1,
        },
        promptVersion: "synthetic-billing",
        costUsd: "0.003",
        inputTokens: 1000,
        outputTokens: 1000,
        reservedCostUsd: "1",
        startedAt: now,
        completedAt: now,
        expiresAt: new Date(Date.now() + 86400000),
      });
      await tx.insert(aiAssistExecutions).values({
        tenantId: context.tenantId,
        runId: id,
        inputFingerprint: "a".repeat(64),
        policyChecksum: "b".repeat(64),
        phase: "failed",
        submissionState: "submitted",
        submittedAt: now,
        providerRequestId: "synthetic-request-" + id,
      });
      await tx.insert(aiBudgetLedger).values({
        id: createEntityId(),
        tenantId: context.tenantId,
        requestId: id,
        taskType: "knowledge_answer",
        modelKey: "synthetic-model",
        provider: "openai-compatible",
        amountUsd: "1",
        state: "released",
      });
    });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`/model-billing?owner=assist&id=${id}`);
    await expect(page.getByRole("heading", { name: "模型费用核对", exact: true })).toBeVisible();
    const form = page.getByRole("form", { name: "人工费用核对" });
    await expect(form.getByRole("checkbox")).not.toBeChecked();
    await expect(form.getByLabel("渠道原请求号")).toHaveValue("synthetic-request-" + id);
    await form.getByLabel("确认费用 USD").fill("0.12345678");
    await form.getByLabel("账单或凭证编号").fill("synthetic-invoice-001");
    await form
      .getByLabel("原凭证文件")
      .setInputFiles({ name: "synthetic-invoice.txt", mimeType: "text/plain", buffer: proof });
    await expect(page.locator(".model-billing-checksum")).toContainText(proofChecksum);
    await expect(form.getByRole("button", { name: "保存人工核对" })).toBeDisabled();
    await form.getByRole("checkbox").check();
    await form.getByRole("button", { name: "保存人工核对" }).click();
    await expect(page.getByRole("region", { name: "人工核对历史" })).toContainText(
      "第 1 次 · $0.12345678",
    );
    await expect(form.getByLabel("原凭证文件")).toHaveValue("");
    const view = await centerApi<AssistView>(`ai-assists/runs/${id}`);
    expect(view.costUsd).toBe(0.003);
    expect(view.invocations?.[0]?.billing).toMatchObject({
      amountUsd: "0.00300000",
      budgetAmountUsd: "0.12345700",
      reconciliation: { amountUsd: "0.12345678" },
    });
    await page.getByRole("button", { name: "调用与费用记录", exact: true }).click();
    await expect(
      page
        .getByRole("region", { name: "调用与费用记录" })
        .getByText("人工核对 $0.12345678", { exact: false }),
    ).toBeVisible();
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "下载核对记录" }).click();
    const file = await download,
      path = testInfo.outputPath("manual-reconciliation.json");
    await file.saveAs(path);
    const exported = JSON.parse(await readFile(path, "utf8"));
    expect(exported).toMatchObject({
      providerInvoiceVerified: false,
      verificationMode: "operator_attestation_only",
    });
    expect(exported.invocations[0].billing.reconciliation.proofChecksum).toBe(proofChecksum);
    expect(JSON.stringify(exported)).not.toContain("synthetic-invoice-001");
    for (const width of [1440, 1024, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      if (width === 1024) {
        await page.getByRole("button", { name: "深色", exact: true }).click();
        await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
      }
      await form.getByLabel("确认费用 USD").scrollIntoViewIfNeeded();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
      ).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`billing-${width}.png`) });
    }
    await form.getByLabel("确认费用 USD").fill("0.4");
    await form.getByLabel("账单或凭证编号").fill("synthetic-draft-preserved");
    await form
      .getByLabel("原凭证文件")
      .setInputFiles({ name: "synthetic-invoice.txt", mimeType: "text/plain", buffer: proof });
    await expect(page.locator(".model-billing-checksum")).toContainText(proofChecksum);
    await form.getByRole("checkbox").check();
    const basis = await centerApi<ModelBillingBasis>(`model-billing/assist/${id}`);
    await centerApi(`model-billing/assist/${id}/confirm`, {
      commandId: createEntityId(),
      expectedFingerprint: basis.fingerprint,
      amountUsd: "0.3",
      currency: "USD",
      evidenceKind: "provider_invoice",
      invoiceReference: "synthetic-concurrent-review",
      providerRequestId: basis.providerRequestId,
      proofChecksum,
      matchesOriginalRequest: true,
    });
    await form.getByRole("button", { name: "保存人工核对" }).click();
    await expect(
      page.getByRole("region", { name: "费用核对详情" }).getByRole("alert"),
    ).toContainText("依据已变化");
    await expect(form.getByLabel("账单或凭证编号")).toHaveValue("synthetic-draft-preserved");
    await page.getByRole("button", { name: "重新读取核对依据" }).click();
    await expect(page.getByRole("button", { name: "重新读取核对依据" })).toHaveCount(0);
    await expect(form.getByLabel("确认费用 USD")).toHaveValue("0.4");
    await expect(form.getByRole("checkbox")).not.toBeChecked();
    await form.getByRole("checkbox").check();
    await form.getByRole("button", { name: "保存人工核对" }).click();
    await expect(page.getByRole("region", { name: "人工核对历史" })).toContainText(
      "第 3 次 · $0.40000000",
    );
    for (const grant of grants)
      await withTenant(database.db, context, (tx) =>
        tx
          .update(roles)
          .set({
            permissions: grant.permissions.filter(
              (value) => value !== Permission.ModelBillingReconcile,
            ),
          })
          .where(eq(roles.id, grant.id)),
      );
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(
      page.getByRole("region", { name: "费用核对详情" }).getByRole("alert"),
    ).toContainText("没有模型费用核对权限");
    await expect(page.getByRole("region", { name: "人工核对历史" })).toHaveCount(0);
    await expect(form).toHaveCount(0);
    await expect(page.getByText("已保存第 3 次人工核对", { exact: false })).toHaveCount(0);
    expect(posts.join("\n")).not.toContain(proof.toString());
    expect(posts.join("\n")).not.toContain("synthetic-invoice.txt");
    expect(errors).toEqual([]);
  } finally {
    for (const grant of grants)
      await withTenant(database.db, context, (tx) =>
        tx
          .update(roles)
          .set({ permissions: grant.permissions })
          .where(and(eq(roles.id, grant.id), eq(roles.tenantId, context.tenantId))),
      );
    await database.client.end();
  }
});
