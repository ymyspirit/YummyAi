import { createHash, randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { Permission } from "../../../packages/authz/src/index";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { StudioGenerateSchema } from "@yummyai/contracts/pod/creative-studio";
import { connectDatabase, creativeExecutions, creativeStudioGenerations, loadCurrentMembershipContext,
  modelProviderConfigs, modelRoutes, visualDeliveryModelFingerprint, withTenant } from "@yummyai/database";
import { stageCreativeExecution } from "../../../packages/pod-core/src/index";
import { createEnvironmentSecretVault } from "../../../packages/ai-core/src/index";
import { eq, sql } from "drizzle-orm";
import { getApiHeaders } from "../src/server-api";
import { centerApi } from "./order-centers-fixture";
import { knowledgeGovernanceFixture } from "./knowledge-governance-fixture";

test.setTimeout(180_000);
async function fixture(phase: "pending" | "failed") {
  if (process.env.E2E_ISOLATED_DAILY !== "1" || !/^\/order_daily_e2e_[a-f0-9]{32}$/.test(new URL(process.env.DATABASE_URL!).pathname))
    throw new Error("Creative operator browser fixtures require disposable resources");
  const actor = await knowledgeGovernanceFixture(`creative-operator-${randomUUID().slice(0, 8)}`), database = connectDatabase();
  try {
    const headers = await getApiHeaders(), claims = JSON.parse(Buffer.from(headers.authorization!.split(".")[1]!, "base64url").toString()) as { sub: string };
    const [identity] = await database.client.unsafe<{ tenant_id: string; user_id: string }[]>(
      "select m.tenant_id,m.user_id from memberships m join app_users u on u.id=m.user_id where u.oidc_subject=$1 and m.status='active'", [claims.sub]);
    if (!identity) throw new Error("Synthetic operator identity unavailable");
    const context: TenantContext = { tenantId: identity.tenant_id, userId: identity.user_id, permissions: Object.values(Permission), dataScope: "tenant" };
    const brief = await centerApi<{ id: string }>("canvas-bridge/briefs", { requestId: randomUUID(), name: "Synthetic execution operator project", prompt: "Synthetic isolated fixture", referenceAssetIds: [] });
    const generationId = createEntityId();
    const execution = await withTenant(database.db, context, async tx => {
      const authority = await loadCurrentMembershipContext(tx, context);
      const [provider] = await tx.insert(modelProviderConfigs).values({ id: createEntityId(), tenantId: context.tenantId, provider: "openai-compatible", label: `Synthetic no-call ${generationId}`, endpoint: "http://127.0.0.1:9/v1",
        encryptedApiKey: createEnvironmentSecretVault("MODEL_CREDENTIAL_ENCRYPTION_KEY", "yummyai:model-config").encrypt("synthetic-not-a-real-credential"), createdBy: context.userId }).returning();
      const modelKey = `synthetic-operator-${generationId}`, target = { providerConfigId: provider!.id, providerModel: modelKey, timeoutMs: 1000 };
      const [route] = await tx.insert(modelRoutes).values({ id: createEntityId(), tenantId: context.tenantId, modelKey, taskType: "studio_image", targets: [target] }).returning();
      await tx.insert(creativeStudioGenerations).values({ id: generationId, tenantId: context.tenantId, ownerId: context.userId, scope: brief.id, requestId: randomUUID(),
        input: StudioGenerateSchema.parse({ requestId: randomUUID(), modelId: route!.id, prompt: "Synthetic private execution operator fixture" }), references: [],
        modelSnapshot: { providerConfigId: provider!.id, model: modelKey, capability: "image", routeId: route!.id, providerFingerprint: visualDeliveryModelFingerprint(provider!, target) } });
      const row = await stageCreativeExecution(tx, authority, { kind: "studio_generation", ownerId: generationId, stepKey: "generate" }, "external_request");
      if (phase === "failed") {
        await tx.update(creativeExecutions).set({ phase: "failed", errorCode: "SYNTHETIC_LOCAL_FAILURE" }).where(eq(creativeExecutions.id, row.id));
        await tx.update(creativeStudioGenerations).set({ status: "failed", errorCode: "SYNTHETIC_LOCAL_FAILURE" }).where(eq(creativeStudioGenerations.id, generationId));
      }
      return row;
    });
    return { actor, brief, execution,
      // Controlled concurrent Worker-state fixture; the UI, auth, RLS and audit remain real.
      async startPreparing() { await withTenant(database.db, context, tx => tx.update(creativeExecutions).set({ phase: "preparing", attemptCount: 1,
        leaseToken: createEntityId(), leaseExpiresAt: sql`clock_timestamp()+interval '5 minutes'` }).where(eq(creativeExecutions.id, execution.id))); },
      async close() { try { await actor.close(); } finally { await database.client.end(); } } };
  } catch (error) { await actor.close(); await database.client.end(); throw error; }
}
async function open(page: Page, briefId: string) {
  await page.goto(`/creative-designs/studio/canvas?brief=${briefId}`);
  await expect(page.locator(".studio-save-bar [role=status]")).toHaveText("自动保存已开启", { timeout: 30_000 });
  await page.getByRole("button", { name: "生成任务", exact: true }).click();
  await page.getByRole("button", { name: "执行依据与恢复", exact: true }).click();
  return page.getByRole("article", { name: "工作台生成执行记录" });
}

for (const width of [1365, 390]) test(`creative operator shows actual evidence and records an immutable check at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 });
  const input = await fixture("failed"), errors: string[] = [];
  const commands: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => { if (request.method() === "POST" && request.url().includes("/api/creative-executions/")) commands.push(request.postData() ?? ""); });
  try {
    const row = await open(page, input.brief.id);
    await expect(row).toContainText(input.execution.id);
    await expect(row).toContainText("尚未提交渠道");
    await expect(row.getByRole("button", { name: "申请原任务续做" })).toBeDisabled();
    await row.getByRole("combobox", { name: "核对结论", exact: true }).selectOption("needs_owner_review");
    if (width === 1365) {
      await row.getByLabel("核对凭据", { exact: true }).setInputFiles({ name: "synthetic-oversized.txt", mimeType: "text/plain", buffer: Buffer.alloc(10 * 1024 * 1024 + 1) });
      await expect(row).toContainText("核对凭据不能超过 10 MiB");
      await expect(row.getByRole("button", { name: "记录人工核对", exact: true })).toBeDisabled();
    }
    const proof = Buffer.from("Synthetic local provider check evidence No real account data");
    await row.getByLabel("核对凭据", { exact: true }).setInputFiles({ name: "synthetic-provider-check.txt", mimeType: "text/plain", buffer: proof });
    await expect(row).toContainText(createHash("sha256").update(proof).digest("hex"));
    await row.getByLabel("已核对凭据对应本次原请求", { exact: true }).check();
    await row.getByRole("button", { name: "记录人工核对", exact: true }).click();
    await expect(row.getByRole("list", { name: "人工处理记录" })).toContainText("交由业务负责人核对");
    await expect(row).toContainText("执行未完成");
    await expect(row).toContainText("尚未提交渠道");
    const evidence = await centerApi<{ entries: Array<{ id: string; phase: string; events: Array<{ proofChecksum: string }> }> }>(`creative-executions/history/studio_generation/${input.execution.studioGenerationId}`);
    expect(evidence.entries[0]).toMatchObject({ id: input.execution.id, phase: "failed" }); expect(evidence.entries[0]!.events).toHaveLength(1);
    expect(evidence.entries[0]!.events[0]!.proofChecksum).toBe(createHash("sha256").update(proof).digest("hex"));
    expect(commands).toHaveLength(1);
    expect(commands[0]).not.toContain("synthetic-provider-check.txt");
    expect(commands[0]).not.toContain(proof.toString());
    await page.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      document.querySelector(".studio-record-list")?.scrollTo(0, 0);
      window.scrollTo(0, 0);
    });
    await expect(row.getByText(input.execution.id, { exact: true })).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await page.screenshot({ path: info.outputPath(`operator-${width}.png`), fullPage: true });
    expect(errors).toEqual([]);
  } finally { await input.close(); }
});

test("creative operator requests the same original and hides temporarily unverifiable and revoked histories", async ({ page }) => {
  const input = await fixture("pending");
  try {
    const row = await open(page, input.brief.id);
    await expect(row.getByRole("button", { name: "申请原任务续做" })).toBeEnabled();
    await row.getByRole("button", { name: "申请原任务续做" }).click();
    await expect(row.getByRole("list", { name: "人工处理记录" })).toContainText("已申请原任务续做");
    await row.getByLabel("核对凭据", { exact: true }).setInputFiles({ name: "synthetic-concurrent-proof.txt", mimeType: "text/plain", buffer: Buffer.from("Synthetic pending original") });
    await expect(row).toContainText("凭据校验");
    await row.getByLabel("已核对凭据对应本次原请求", { exact: true }).check();
    await expect(row.getByRole("button", { name: "记录人工核对", exact: true })).toBeEnabled();
    await input.startPreparing();
    await page.locator(".creative-execution-history").getByRole("button", { name: "刷新", exact: true }).click();
    await expect(row).toContainText("原执行仍持有有效租约");
    await expect(row.getByLabel("已核对凭据对应本次原请求", { exact: true })).not.toBeChecked();
    await expect(row.getByRole("button", { name: "记录人工核对", exact: true })).toBeDisabled();
    const pattern = `**/api/creative-executions/history/studio_generation/${input.execution.studioGenerationId}`;
    await page.route(pattern, route => route.fulfill({ status: 503, contentType: "application/json", body: "{}" }));
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.getByRole("alert").filter({ hasText: "执行记录暂时无法核对" })).toBeVisible();
    await expect(row).toHaveCount(0);
    await page.unroute(pattern);
    await page.locator(".creative-execution-history").getByRole("button", { name: "刷新", exact: true }).click();
    await expect(row).toContainText(input.execution.id);
    let entered!: () => void, release!: () => void, finished!: () => void;
    const pending = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; }), handled = new Promise<void>(resolve => { finished = resolve; });
    let hold = true;
    await page.route(pattern, async route => {
      if (!hold) return route.continue();
      hold = false;
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      expect(await response.text()).toContain(input.execution.id);
      entered(); await gate;
      try { await route.fulfill({ response }); } finally { finished(); }
    });
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await pending;
    await input.actor.setPermissions(Object.values(Permission).filter(permission => permission !== Permission.DesignRead));
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    try {
      await expect(page.getByText(input.execution.id, { exact: true })).toHaveCount(0);
      await expect(row).toHaveCount(0);
    } finally { release(); await handled; }
    await expect(page.getByText(input.execution.id, { exact: true })).toHaveCount(0);
    await expect(row).toHaveCount(0);
  } finally { await input.close(); }
});
