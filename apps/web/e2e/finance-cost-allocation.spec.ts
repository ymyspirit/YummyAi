import { randomUUID } from "node:crypto";
import { expect, test, type Page, type Route } from "@playwright/test";
import { eq, sql } from "drizzle-orm";
import { Permission } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { FinanceProfitMetricViewSchema, FinanceProfitRunViewSchema, FinanceStatementViewSchema, type FinanceFactInput } from "@yummyai/contracts/finance";
import { FinanceAllocatedProfitRunPageSchema, FinanceAllocatedProfitRunViewSchema, FinanceAllocatedProfitSlicePageSchema,
  FinanceCostAllocationPreviewViewSchema, FinanceCostAllocationVersionPageSchema, FinanceCostAllocationVersionViewSchema } from "@yummyai/contracts/finance/cost-allocation";
import { connectDatabase, roles, withTenant } from "@yummyai/database";
import { actors, changeErpRights, loginErp } from "./erp-identity-fixture";
import { FinanceCommandDetailSchema, PrepareFinanceCommandSchema, type FinanceCommandDetail } from "@yummyai/contracts/finance/finance-command";
import { acknowledgeFinanceCommand, executeFinanceCommand, financeCommandEndpoint, prepareFinanceCommand, readFinanceCommandOriginal } from "./finance-command-fixture";

const target = new URL(process.env.DATABASE_URL ?? "postgres://invalid/invalid"), nonce = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(target.pathname)?.[1];
if (process.env.E2E_ISOLATED_DAILY !== "1" || process.env.E2E_FINANCE_COST_ALLOCATION_ISOLATED !== "1" || process.env.WEB_AUTH_MODE !== "personal"
  || !["postgres:", "postgresql:"].includes(target.protocol) || !nonce || process.env.S3_PRIVATE_BUCKET !== `order-daily-e2e-${nonce}`)
  throw new Error("Personal disposable explicit cost allocation fixture required before connection");
const apiBase = process.env.API_BASE_URL!.replace(/\/$/, ""), endpoint = "/api/finance/cost-allocations", at = "2026-07-15T00:00:00.000Z";
const key = () => `synthetic-cost-${randomUUID()}`;
test.describe.configure({ mode: "serial" });

async function api(path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`${apiBase}/v1/${path}`, { method: body === undefined ? "GET" : "POST", redirect: "error",
    headers: { authorization: `Bearer ${process.env.API_ACCESS_TOKEN}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  if (!response.ok) {
    const value = await response.json().catch(() => null) as { code?: unknown } | null;
    const safe = typeof value?.code === "string" && /^[a-z_]{1,100}$/.test(value.code) ? value.code : "unavailable";
    throw new Error(`Synthetic cost allocation fixture failed ${response.status} ${path} ${safe}`);
  }
  return response.json();
}
async function savedRights() {
  const actor = actors().readonly, database = connectDatabase();
  try {
    const [role] = await withTenant(database.db, { tenantId: actor.tenantId, userId: actor.userId, permissions: [], dataScope: "tenant" },
      tx => tx.select({ permissions: roles.permissions }).from(roles).where(eq(roles.id, actor.roleId)));
    if (!role) throw new Error("Synthetic cost reader role missing"); return [...role.permissions];
  } finally { await database.client.end(); }
}
const rights = (original: string[], review = false) => [...new Set([...original.filter(value => value !== Permission.FinanceWrite && value !== Permission.FinanceReview),
  Permission.FinanceRead, ...(review ? [Permission.FinanceReview] : [])])];

async function basis() {
  const actor = actors().operator, context: TenantContext = { tenantId: actor.tenantId, userId: actor.userId, permissions: [], dataScope: "tenant" };
  const database = connectDatabase(), targets: Array<{ orderId: string; lineId: string; skuId: string }> = [];
  try {
    // Neutral synthetic order/catalog references only. Every monetary fact,
    // source identity, rate, metric and calculation below uses its real owner.
    for (let index = 0; index < 3; index++) await withTenant(database.db, context, async tx => {
      const accountId = createEntityId(), planId = createEntityId(), spuId = createEntityId(), skuId = createEntityId(), snapshotId = createEntityId(),
        orderId = createEntityId(), lineId = createEntityId(), code = `COST-${skuId.toUpperCase()}`;
      await tx.execute(sql`insert into marketplace_accounts(id,tenant_id,platform,display_name,region,marketplace_ids,authorization_mode,status)
        values(${accountId},${actor.tenantId},'etsy',${`Synthetic browser allocation ${accountId}`},'GLOBAL','["US"]'::jsonb,'etsy_oauth','active')`);
      await tx.execute(sql`insert into product_plans(id,tenant_id,name,customization) values(${planId},${actor.tenantId},${`Synthetic browser plan ${planId}`},'{"version":1,"fields":[]}'::jsonb)`);
      await tx.execute(sql`insert into spus(id,tenant_id,product_plan_id,code,name,customization) values(${spuId},${actor.tenantId},${planId},${`SPU-${code}`},${`Synthetic browser SPU ${spuId}`},'{"version":1,"fields":[]}'::jsonb)`);
      await tx.execute(sql`insert into skus(id,tenant_id,spu_id,code,status) values(${skuId},${actor.tenantId},${spuId},${code},'active')`);
      await tx.execute(sql`insert into order_source_snapshots(id,tenant_id,account_id,platform,external_event_id,external_order_id,normalized_order_id,redacted_payload,payload_checksum)
        values(${snapshotId},${actor.tenantId},${accountId},'etsy',${key()},${orderId},${orderId},'{}'::jsonb,${"a".repeat(64)})`);
      await tx.execute(sql`insert into orders(id,tenant_id,account_id,source_snapshot_id,platform,external_order_id,provider_status,order_total_minor,order_currency,line_count,placed_at)
        values(${orderId},${actor.tenantId},${accountId},${snapshotId},'etsy',${orderId},'paid',1000,'USD',1,'2026-07-15T00:00:00Z')`);
      await tx.execute(sql`insert into order_lines(id,tenant_id,order_id,external_line_id,sku_code,title,quantity,unit_price_minor,unit_price_currency)
        values(${lineId},${actor.tenantId},${orderId},${lineId},${code},'Synthetic attribution reference No buyer input',1,1000,'USD')`);
      await tx.execute(sql`insert into order_line_catalog_links(id,tenant_id,order_line_id,sku_id,match_source,linked_by)
        values(${createEntityId()},${actor.tenantId},${lineId},${skuId},'manual',${actor.userId})`);
      targets.push({ orderId, lineId, skuId });
    });
  } finally { await database.client.end(); }
  const fact = (type: FinanceFactInput["factType"], amountMinor: number, refs: Partial<FinanceFactInput> = {}): FinanceFactInput => ({
    sourceEntryId: key(), lineKey: key(), factType: type, direction: type === "sale_revenue" ? "credit" : "debit", currency: "USD", amountMinor,
    occurredAt: at, externalReference: null, orderId: null, orderLineId: null, skuId: null, listingId: null, supplierId: null,
    correctionKind: "original", correctsFactId: null, ...refs });
  const statement = async (lines: FinanceFactInput[]) => FinanceStatementViewSchema.parse(await api("finance/statements", {
    sourceIdentity: { schemaVersion: 2, kind: "named_source", sourceName: "SYNTHETIC-COST-ALLOCATION-BROWSER" }, accountId: null, provider: "manual",
    statementKind: "operational_cost", externalStatementId: key(), periodStart: at, periodEnd: at, observedAt: at, sourceCurrency: "USD", lines, idempotencyKey: key() }));
  const direct = await statement(targets.flatMap(row => {
    const refs = { orderId: row.orderId, orderLineId: row.lineId, skuId: row.skuId };
    return [fact("sale_revenue", 1000, refs), fact("production_cost", 100, refs), fact("marketplace_commission", 50, refs)];
  })), shared = await statement([fact("carrier_cost", 101)]);
  const metric = FinanceProfitMetricViewSchema.parse(await api("finance/profit-metrics", { metricId: null, name: key(), reportingCurrency: "USD",
    revenueFactTypes: ["sale_revenue"], costFactTypes: ["production_cost", "carrier_cost", "marketplace_commission"],
    requiredFactTypes: ["sale_revenue", "production_cost", "carrier_cost", "marketplace_commission"], reasonCode: "SYNTHETIC", idempotencyKey: key() }));
  const base = FinanceProfitRunViewSchema.parse(await api("finance/profit-runs", { metricId: metric.id, expectedMetricVersion: 1, statementIds: [direct.id, shared.id],
    fxRateIds: [], coverageDimension: "aggregate", idempotencyKey: key() }));
  expect(base).toMatchObject({ status: "complete", revenueMinor: 3000, costMinor: 551, profitMinor: 2449 });
  return { base, targets, shared, root: shared.lines[0]! };
}
type Basis = Awaited<ReturnType<typeof basis>>;
async function load(page: Page, value: Basis) {
  const form = page.getByRole("form", { name: "读取原汇总利润", exact: true });
  await form.getByLabel("原汇总利润计算 ID", { exact: true }).fill(value.base.id);
  const response = page.waitForResponse(reply => new URL(reply.url()).pathname === `${endpoint}/bases/${value.base.id}`);
  await form.getByRole("button", { name: "读取原利润计算", exact: true }).click(); expect((await response).status()).toBe(200);
  await expect(page.getByRole("region", { name: "原汇总计算依据", exact: true })).toContainText(value.base.id);
}
async function prepare(page: Page, value: Basis) {
  const sourceRead = page.waitForResponse(reply => { const url = new URL(reply.url()); return url.pathname === `${endpoint}/bases/${value.base.id}/sources` && url.searchParams.get("dimension") === "order_line"; });
  await page.getByLabel("归属维度", { exact: true }).selectOption("order_line");
  expect((await sourceRead).status()).toBe(200); await expect(page.getByLabel("归属维度", { exact: true })).toHaveValue("order_line");
  const sources = page.getByRole("region", { name: "原费用来源", exact: true }), option = sources.getByRole("listitem").filter({ hasText: value.root.id });
  await option.getByRole("button", { name: "添加费用", exact: true }).click();
  const picker = page.getByRole("region", { name: "真实归属目标", exact: true });
  for (const target of value.targets) {
    await picker.getByLabel("真实目标 ID", { exact: true }).fill(target.lineId);
    const read = page.waitForResponse(reply => { const url = new URL(reply.url()); return url.pathname === `${endpoint}/targets` && url.searchParams.get("key") === target.lineId; });
    await picker.getByRole("button", { name: "查找目标", exact: true }).click(); expect((await read).status()).toBe(200);
    await picker.getByRole("listitem").filter({ hasText: target.lineId }).getByRole("button", { name: "添加目标", exact: true }).click();
    await expect(page.getByRole("region", { name: `本次费用 ${value.root.id}`, exact: true })).toContainText(target.lineId);
  }
  await page.getByLabel("人工分摊依据", { exact: true }).fill("Synthetic operator chose these three exact order lines Equal shares retain original minor total and deterministic remainder");
  const read = page.waitForResponse(reply => new URL(reply.url()).pathname === `${endpoint}/preview` && reply.request().method() === "POST");
  await page.getByRole("button", { name: "预览精确分摊", exact: true }).click(); const response = await read;
  expect(response.status()).toBe(200); const preview = FinanceCostAllocationPreviewViewSchema.parse(await response.json());
  expect(preview.sources[0]!.shares.map(row => row.amountMinor)).toEqual([34, 34, 33]);
  expect(preview.sources[0]!.shares.map(row => row.target.key)).toEqual(value.targets.map(row => row.lineId).sort());
  await expect(page.getByRole("region", { name: "精确分摊核对", exact: true })).toContainText("余数 2000000000 / 3000000000");
  return { preview, original: response.request().postDataJSON() as Record<string, unknown> };
}
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  for (const element of await page.locator(".finance-cost-workspace, dialog[open], .finance-cost-code, .finance-cost-table").all())
    expect(await element.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
}
async function openRun(page: Page, id: string) {
  const history = page.getByRole("region", { name: "批准版本与归属计算历史", exact: true });
  await history.getByRole("button", { name: "归属计算", exact: true }).click();
  await history.getByLabel("历史归属计算 ID", { exact: true }).fill(id);
  await history.getByRole("button", { name: "按 ID 读取历史详情", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "归属利润计算详情", exact: true }); await expect(dialog).toContainText(id);
  await expect(dialog.getByRole("region", { name: "原计算分配行", exact: true })).toBeVisible(); return dialog;
}

test("a personal reviewer retains one approved version after a lost response and reads exact attributed results at desktop and mobile widths", async ({ page }, info) => {
  test.setTimeout(240_000); const original = await savedRights(), errors: string[] = [], bodies: string[] = [], receipts: FinanceCommandDetail[] = [];
  page.on("pageerror", error => errors.push(error.message)); const pattern = `**${financeCommandEndpoint}`;
  const intercept = async (route: Route) => {
    if (route.request().method() !== "POST") { await route.continue(); return; }
    const input = PrepareFinanceCommandSchema.parse(route.request().postDataJSON()); expect(input.kind).toBe("cost_version_approve");
    bodies.push(route.request().postData()!); const response = await route.fetch(); expect(response.status()).toBe(201);
    receipts.push(FinanceCommandDetailSchema.parse(await response.json()));
    if (bodies.length === 1) await route.abort("failed"); else await route.fulfill({ response });
  };
  try {
    const value = await basis(); await changeErpRights("readonly", rights(original, true)); await page.setViewportSize({ width: 1440, height: 1000 });
    await loginErp(page, "readonly", "/finance/cost-allocations"); await load(page, value); await prepare(page, value); await page.route(pattern, intercept);
    await page.getByRole("checkbox", { name: "我已核对原费用、全部目标、权重、人工依据及尾差 准备此版本原提交", exact: true }).check();
    await page.getByRole("button", { name: "保存分摊批准原填写并核对", exact: true }).click();
    await expect.poll(() => receipts.length, { timeout: 30_000 }).toBe(1);
    const retry = page.getByRole("button", { name: "重试保存同一笔原提交", exact: true }); await expect(retry).toBeVisible();
    await expect(page.getByText("准备响应未知时只保存同一原文与键", { exact: false })).toBeVisible(); await expect(page.getByLabel("归属维度", { exact: true })).toBeDisabled();
    expect(FinanceCostAllocationVersionPageSchema.parse(await api(`finance/cost-allocations/versions?baseRunId=${value.base.id}`)).items).toEqual([]);
    const recovered = await prepareFinanceCommand(page, page.locator('[aria-label="分摊批准原请求"]'), "重试保存同一笔原提交");
    expect(bodies).toHaveLength(2); expect(bodies[1]).toBe(bodies[0]); expect(receipts[1]).toEqual(receipts[0]); expect(recovered.detail.id).toBe(receipts[0]!.id);
    expect(await readFinanceCommandOriginal(page, recovered.detail)).toEqual(recovered.original);
    const approval = await executeFinanceCommand(page, recovered.detail);
    const approved = FinanceCostAllocationVersionViewSchema.parse(await api(`finance/cost-allocations/versions/${approval.result!.id}`));
    expect(approval.result).toEqual({ kind: "cost_version_approve", id: approved.id, parentId: approved.allocationId, version: approved.versionNumber });
    const versions = FinanceCostAllocationVersionPageSchema.parse(await api(`finance/cost-allocations/versions?baseRunId=${value.base.id}&limit=100`));
    expect(versions.items.map(row => row.id)).toEqual([approved.id]);
    await page.unroute(pattern, intercept); await acknowledgeFinanceCommand(page, approval);
    const history = page.getByRole("region", { name: "批准版本与归属计算历史", exact: true });
    await history.getByLabel("历史批准版本 ID", { exact: true }).fill(approved.id); await history.getByRole("button", { name: "按 ID 读取历史详情", exact: true }).click();
    const approvedDetail = page.getByRole("dialog", { name: "批准分摊版本详情", exact: true });
    const approvedId = approvedDetail.locator("dl.finance-cost-pairs > div").filter({ has: page.getByText("实际批准版本 ID", { exact: true }) }).locator("dd");
    await expect(approvedId).toHaveCount(1); await expect(approvedId).toHaveText(approved.id);
    await approvedDetail.getByRole("button", { name: "按此版本准备归属计算", exact: true }).click(); await expect(approvedDetail).toHaveCount(0);
    await expect(page.getByRole("list", { name: "本次固定分摊版本", exact: true })).toContainText(approved.id);
    await page.getByRole("checkbox", { name: "我已核对原计算、归属维度及以上固定版本 准备一次归属利润计算", exact: true }).check();
    const calculation = await prepareFinanceCommand(page, page.locator("body"), "保存归属计算原填写并核对");
    expect(await readFinanceCommandOriginal(page, calculation.detail)).toEqual(calculation.original); const completed = await executeFinanceCommand(page, calculation.detail);
    const run = FinanceAllocatedProfitRunViewSchema.parse(await api(`finance/cost-allocations/runs/${completed.result!.id}`)); expect(run).toMatchObject({ baseRunId: value.base.id, status: "complete", revenueMinor: 3000, costMinor: 551, profitMinor: 2449 });
    expect(run.id).not.toBe(value.base.id); expect(run.versionPins.map(row => row.id)).toEqual([approved.id]);
    await acknowledgeFinanceCommand(page, completed); const detail = await openRun(page, run.id), receipt = detail.getByRole("region", { name: "归属利润原计算结果", exact: true });
    await expect(receipt).toContainText("USD 24.49"); await expect(detail.getByRole("heading", { name: "归属利润计算详情", exact: true })).toBeInViewport(); await noOverflow(page);
    await page.screenshot({ path: info.outputPath("cost-allocation-desktop.png"), fullPage: true, animations: "disabled" });
    await page.setViewportSize({ width: 390, height: 844 }); await receipt.scrollIntoViewIfNeeded(); await noOverflow(page);
    await page.screenshot({ path: info.outputPath("cost-allocation-mobile.png"), fullPage: true, animations: "disabled" });
    await detail.getByRole("button", { name: "关闭历史详情", exact: true }).click(); await expect(detail).toHaveCount(0); await page.reload();
    const persisted = await openRun(page, run.id); await expect(persisted).toContainText(value.base.id); await expect(persisted).toContainText(approved.id);
    await expect(persisted.getByRole("region", { name: "归属利润原计算结果", exact: true })).toContainText("USD 24.49");
    const slicesReply = await page.request.get(`${endpoint}/runs/${run.id}/slices?limit=100`); expect(slicesReply.status()).toBe(200);
    const slices = FinanceAllocatedProfitSlicePageSchema.parse(await slicesReply.json()), shared = slices.items.filter(row => row.sourceFactId === value.root.id);
    expect(shared.map(row => row.amountMinor).sort((a, b) => b - a)).toEqual([34, 34, 33]); expect(shared.reduce((sum, row) => sum + row.amountMinor, 0)).toBe(101);
    expect(shared.every(row => row.allocationVersionId === approved.id && row.originalReportingAmountMinor === 101)).toBe(true); await noOverflow(page); expect(errors).toEqual([]);
  } finally { try { await page.unroute(pattern, intercept); } finally { await changeErpRights("readonly", original); } }
});

test("a FinanceRead-only personal operator can preview real weights but cannot approve or calculate a financial projection", async ({ page }) => {
  const original = await savedRights();
  try {
    const value = await basis(); await changeErpRights("readonly", rights(original)); await loginErp(page, "readonly", "/finance/cost-allocations");
    await load(page, value); const { preview, original: body } = await prepare(page, value);
    await expect(page.getByRole("button", { name: "保存分摊批准原填写并核对", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "保存归属计算原填写并核对", exact: true })).toHaveCount(0);
    const origin = new URL(page.url()).origin;
    expect((await page.request.post(`${endpoint}/versions`, { headers: { origin }, data: { ...body, previewChecksum: preview.previewChecksum, idempotencyKey: key() } })).status()).toBe(403);
    expect((await page.request.post(`${endpoint}/runs`, { headers: { origin }, data: { baseRunId: value.base.id, baseInputChecksum: value.base.inputChecksum,
      dimension: "order_line", versionIds: [], idempotencyKey: key() } })).status()).toBe(403);
    expect(FinanceCostAllocationVersionPageSchema.parse(await api(`finance/cost-allocations/versions?baseRunId=${value.base.id}`)).items).toEqual([]);
    expect(FinanceAllocatedProfitRunPageSchema.parse(await api(`finance/cost-allocations/runs?baseRunId=${value.base.id}`)).items).toEqual([]);
    await page.setViewportSize({ width: 390, height: 844 }); await noOverflow(page);
  } finally { await changeErpRights("readonly", original); }
});

test("unallocated evidence stays incomplete and current approval withdrawal blocks an already previewed personal decision", async ({ page }) => {
  const original = await savedRights();
  try {
    const value = await basis(), unknown = FinanceAllocatedProfitRunViewSchema.parse(await api("finance/cost-allocations/runs", {
      baseRunId: value.base.id, baseInputChecksum: value.base.inputChecksum, dimension: "order_line", versionIds: [], idempotencyKey: key() }));
    expect(unknown).toMatchObject({ status: "incomplete", revenueMinor: null, costMinor: null, profitMinor: null, breakdowns: [] });
    const contribution = value.base.contributions.find(row => row.factId === value.root.id)!;
    expect(unknown.diagnostics.unallocatedContributionIds).toContain(contribution.id);
    await changeErpRights("readonly", rights(original, true)); await loginErp(page, "readonly", "/finance/cost-allocations");
    const dialog = await openRun(page, unknown.id), summary = dialog.getByRole("region", { name: "归属利润原计算结果", exact: true });
    await expect(summary).toContainText("归属待核对"); await expect(summary).toContainText(contribution.id); await expect(summary).not.toContainText("USD 0.00");
    await expect(summary.getByRole("table", { name: "归属利润目标汇总", exact: true })).toHaveCount(0);
    await expect(dialog.getByRole("region", { name: "原计算分配行", exact: true })).toContainText("尚未归属 未使用分摊版本");
    await dialog.getByRole("button", { name: "关闭历史详情", exact: true }).click(); await expect(dialog).toHaveCount(0);
    await load(page, value); await prepare(page, value); await changeErpRights("readonly", rights(original));
    await page.getByRole("checkbox", { name: "我已核对原费用、全部目标、权重、人工依据及尾差 准备此版本原提交", exact: true }).check();
    const blocked = page.waitForResponse(reply => new URL(reply.url()).pathname === financeCommandEndpoint && reply.request().method() === "POST");
    await page.getByRole("button", { name: "保存分摊批准原填写并核对", exact: true }).click(); expect((await blocked).status()).toBe(403);
    const workspace = page.getByRole("region", { name: "费用分摊与归属利润", exact: true });
    await expect(workspace.getByRole("alert")).toContainText("当前权限不足"); await expect(workspace).toContainText("原请求与填写已清除");
    await expect(page.getByRole("form", { name: "读取原汇总利润", exact: true })).toHaveCount(0);
    await expect(page.getByRole("region", { name: "精确分摊核对", exact: true })).toHaveCount(0);
    expect(FinanceCostAllocationVersionPageSchema.parse(await api(`finance/cost-allocations/versions?baseRunId=${value.base.id}`)).items).toEqual([]);
  } finally { await changeErpRights("readonly", original); }
});
