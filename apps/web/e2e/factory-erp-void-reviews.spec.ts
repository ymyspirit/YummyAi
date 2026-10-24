import { expect, test, type Locator, type Page, type Route } from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Sql } from "../../../packages/database/node_modules/postgres";
import { Permission } from "@yummyai/authz";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import type { ProductionEditorDetailView } from "@yummyai/contracts";
import { ProductionFactoryChoiceSchema } from "@yummyai/contracts/suppliers/factory-directory";
import {
  FACTORY_ERP_HEADERS, ApplyFactoryErpImportSchema, FactoryErpImportViewSchema, FactoryErpApplyResultSchema,
  FactoryErpSourceLifecycleSchema, type FactoryErpImportView, type FactoryErpItemSelection,
} from "@yummyai/contracts/order/factory-erp-import";
import { FactoryErpBindingViewSchema } from "@yummyai/contracts/order/factory-erp-binding";
import {
  ReviewFactoryErpVoidSchema, FactoryErpVoidReviewResultSchema, FactoryErpVoidObservationPageSchema,
  FactoryErpVoidObservationDetailSchema, FactoryErpVoidReviewPageSchema,
  type ReviewFactoryErpVoid, type FactoryErpVoidReviewResult,
} from "@yummyai/contracts/order/factory-erp-void-review";
import type { ProductionDeliveryPackageView, ProductionDeliveryWorkspace } from "@yummyai/contracts/order/production-delivery";
import type { OrderWorkDetail } from "@yummyai/contracts/order/workspace";
import { requireDisposableIntegrationEnvironment } from "../../../tools/testing/require-disposable-integration.mjs";
import { centerApi } from "./order-centers-fixture";
import { prepareDeliveryOrder } from "./production-delivery-fixture";
import { startProductionEditorWorker, stopProductionEditorWorker } from "./production-editor-fixture";
import { actors, changeErpRights, loginErp } from "./erp-identity-fixture";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const ownedRoot = resolve(root, "tmp/factory-erp-void-review-20261021-b8d4c307/frontend-browser");
const databaseRequire = createRequire(new URL("../../../packages/database/package.json", import.meta.url));
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const physicalTables = ["production_orders", "production_order_versions", "production_manufacturing_bindings", "production_milestone_events",
  "production_delivery_feedback", "factory_capacity_reservations", "factory_capacity_events", "factory_capacity_stop_effects",
  "production_quantity_reports", "production_quantity_reviews", "quality_inspections", "quality_inspection_groups", "quality_group_defects",
  "shipments", "shipment_versions", "shipment_production_allocations", "inventory_movements", "inventory_reservation_events"] as const;

function isolation() {
  const url = new URL(requireDisposableIntegrationEnvironment());
  const nonce = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(url.pathname)?.[1];
  const api = new URL(process.env.API_BASE_URL ?? "http://invalid.invalid");
  if (!nonce || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(api.hostname) || api.port !== "8130" ||
    process.env.E2E_FACTORY_ERP_VOID_REVIEW_ISOLATED !== "1" || process.env.E2E_FACTORY_ERP_BINDING_ISOLATED !== "1" ||
    process.env.E2E_FACTORY_ERP_IMPORT_ISOLATED !== "1" || process.env.E2E_FACTORY_ERP_SOURCE_RETENTION_ISOLATED !== "1" ||
    process.env.E2E_ISOLATED_DAILY !== "1" || process.env.E2E_LEGACY_SCHEMA_TARGET !== "current" ||
    process.env.E2E_COMPILED_WEB !== "1" || process.env.WEB_AUTH_MODE !== "personal" ||
    process.env.S3_PRIVATE_BUCKET !== "order-daily-e2e-" + nonce)
    throw new Error("Exact current compiled personal nonce void-review database, API and bucket required before connection");
  return { url, nonce, databaseName: "order_daily_e2e_" + nonce };
}

type Owned = Awaited<ReturnType<typeof ownEnvironment>>;
const unfinished = new Set<{ cleanup(): Promise<void> }>();
async function ownEnvironment(leaf: string) {
  const isolated = isolation();
  const directory = resolve(ownedRoot, isolated.nonce, leaf); await mkdir(directory, { recursive: true });
  const sql = (databaseRequire("postgres") as (url: string, options: { max: number }) => Sql)(isolated.url.toString(), { max: 1 });
  let renderer: ChildProcess | undefined, clockChanged = false, closed = false;
  let savedRole: string[] | undefined;
  const proof: Record<string, unknown> = { nonce: isolated.nonce, leaf,
    admission: "synthetic approved owned artwork and order report; real scan, preflight, JPG renderer, manufacturing review, finite capacity and submitted-only owners",
    cleanupOwner: "This test restores exact role/source-clock and drains renderer; outer disposable runner removes all nonce data, bucket and identity resources" };
  async function check() {
    if (closed || isolation().databaseName !== isolated.databaseName) throw new Error("Owned void-review database changed");
    const [actual] = await sql.unsafe<{ name: string }[]>("select current_database() as name");
    if (actual?.name !== isolated.databaseName) throw new Error("Exact nonce database required before source-clock or role access");
  }
  let originalClock: string;
  try {
    await check();
    const [clock] = await sql.unsafe<{ definition: string }[]>("select pg_get_functiondef('public.factory_erp_source_now()'::regprocedure) as definition");
    if (!clock || !/AS \$function\$\s*SELECT\s+clock_timestamp\(\)\s*;?\s*\$function\$/i.test(clock.definition))
      throw new Error("Fresh original factory source-clock DDL required");
    originalClock = clock.definition;
  } catch (error) { await sql.end({ timeout: 5 }); throw error; }
  proof.originalDdlSha256 = sha(originalClock);
  const owner = {
    ...isolated, sql, proof, directory, check,
    async startRenderer() { renderer = await startProductionEditorWorker(); },
    async stopRenderer() { await stopProductionEditorWorker(renderer); renderer = undefined; proof.rendererStopped = true; },
    async saveReadonlyRole() {
      await check(); const actor = actors().readonly;
      const rows = await sql.unsafe<{ permissions: string[] }[]>("select permissions from roles where id=$1::uuid and tenant_id=$2::uuid", [actor.roleId, actor.tenantId]);
      if (rows.length !== 1 || !Array.isArray(rows[0]!.permissions)) throw new Error("Exact synthetic readonly role required");
      savedRole = [...rows[0]!.permissions];
    },
    async expire(source: FactoryErpImportView) {
      await check();
      const instant = new Date(Date.parse(source.expiresAt) + 1).toISOString();
      if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(instant)) throw new Error("Exact synthetic source expiry instant required");
      const changed = originalClock.replace(/AS \$function\$[\s\S]*?\$function\$/, "AS $function$ SELECT '" + instant + "'::timestamptz $function$");
      if (changed === originalClock) throw new Error("Unexpected original source-clock DDL body");
      clockChanged = true; await sql.unsafe(changed); proof.expiredSourceId = source.id;
    },
    async cleanup() {
      if (closed) return;
      const errors: string[] = [];
      try { await owner.stopRenderer(); } catch { errors.push("production_renderer_not_drained"); }
      try { if (savedRole) { await check(); await changeErpRights("readonly", savedRole); savedRole = undefined; proof.roleRestored = true; } }
      catch { errors.push("synthetic_role_not_restored"); }
      try {
        await check(); if (clockChanged) await sql.unsafe(originalClock);
        const [actual] = await sql.unsafe<{ definition: string }[]>("select pg_get_functiondef('public.factory_erp_source_now()'::regprocedure) as definition");
        proof.restoredDdlSha256 = sha(actual?.definition ?? ""); proof.clockRestored = proof.restoredDdlSha256 === proof.originalDdlSha256;
        if (!proof.clockRestored) throw new Error("Source-clock restoration SHA differs"); clockChanged = false;
      } catch { errors.push("source_clock_not_exactly_restored"); }
      proof.cleanupErrors = errors;
      await writeFile(resolve(directory, "safe-proof-and-cleanup.json"), JSON.stringify(proof, null, 2) + "\n");
      if (errors.length) throw new Error("Void-review acceptance cleanup incomplete: " + errors.join(","));
      await sql.end({ timeout: 5 }); closed = true; unfinished.delete(owner);
    },
  };
  unfinished.add(owner); return owner;
}
test.afterAll(async () => { for (const owner of [...unfinished]) await owner.cleanup(); });

async function physicalState(owner: Owned) {
  await owner.check(); const state: Record<string, { rows: number; hash: string }> = {};
  for (const table of physicalTables) {
    const [row] = await owner.sql.unsafe<{ rows: number; hash: string }[]>("select count(*)::integer as rows,md5(coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text)::text,'[]')) as hash from " + table + " t");
    if (!row) throw new Error("Owned physical fact hash missing"); state[table] = row;
  }
  expect(Object.keys(state)).toHaveLength(18); return state;
}
async function reviewCounts(owner: Owned, bindingId: string) {
  await owner.check(); const [row] = await owner.sql.unsafe<{ reviews: number; audits: number }[]>(
    "select (select count(*)::integer from factory_erp_void_reviews where binding_id=$1::uuid) as reviews," +
    "(select count(*)::integer from audit_events a join factory_erp_void_reviews r on r.id=a.entity_id where r.binding_id=$1::uuid and a.action='factory_erp.void_reviewed' and a.entity_type='factory_erp_void_review') as audits", [bindingId]);
  if (!row) throw new Error("Owned review/audit counts missing"); return row;
}
async function storedReview(owner: Owned, result: FactoryErpVoidReviewResult, input: ReviewFactoryErpVoid, actor: string) {
  await owner.check(); const [row] = await owner.sql.unsafe<{ actor: string; request_key: string; request_canonical: string; request_checksum: string; input: unknown; result: unknown }[]>(
    "select created_by::text as actor,idempotency_key::text as request_key,request_canonical,request_checksum,input,result from factory_erp_void_reviews where id=$1::uuid", [result.id]);
  expect(row?.actor).toBe(actor); expect(row?.request_key).toBe(input.idempotencyKey);
  const canonical = canonicalJson({ version: 1, operation: "factory-erp-void-review", bindingId: result.bindingId, input });
  expect(row?.request_canonical).toBe(canonical); expect(row?.request_checksum).toBe(sha(canonical)); expect(result.requestChecksum).toBe(sha(canonical));
  expect(ReviewFactoryErpVoidSchema.parse(row?.input)).toEqual(input); expect(FactoryErpVoidReviewResultSchema.parse(row?.result)).toEqual(result); return row;
}

function observations(page: Page, abortPath?: string) {
  const errors: string[] = [], writes: Array<{ path: string; input: ReviewFactoryErpVoid }> = [];
  const revokedOrderReads: string[] = []; let revocationStarted = false;
  const consoleDiagnostics: Array<{ text: string; textSha256: string; path: string; line: number; column: number; intentionalAbort: boolean }> = [];
  const consoleAborts: string[] = []; let abortBudget = 0;
  page.on("pageerror", () => errors.push("pageerror"));
  page.on("console", value => {
    if (value.type() !== "error") return;
    const location = value.location(), text = value.text();
    let path = "";
    try {
      const url = new URL(location.url);
      if (url.origin === new URL(page.url()).origin && /^\/api\/(?:factory-erp-import|order-centers)\/[A-Za-z0-9/_-]+$/.test(url.pathname)) path = url.pathname;
    } catch { /* Missing request identity is never exempt. No query or headers are retained. */ }
    const intentionalAbort = text === "Failed to load resource: net::ERR_FAILED" && path === abortPath && abortBudget === 1;
    const resourceError = /^Failed to load resource: (?:net::ERR_[A-Z_]+|the server responded with a status of \d{3}(?: \([A-Za-z ]+\))?)$/.test(text);
    consoleDiagnostics.push({ text: resourceError ? text : "Non-resource console error text withheld", textSha256: sha(text),
      path: path || "Other or missing location withheld", line: location.lineNumber, column: location.columnNumber, intentionalAbort });
    if (intentionalAbort) {
      abortBudget = 0; consoleAborts.push(path);
    } else errors.push("consoleerror");
  });
  page.on("request", request => {
    const path = new URL(request.url()).pathname;
    if (revocationStarted && request.method() === "GET" && /^\/api\/order-centers\/lines\/[a-f0-9-]+\/order-detail$/.test(path)) revokedOrderReads.push(path);
    if (request.method() !== "POST" || !path.startsWith("/api/factory-erp-import/")) return;
    if (!/^\/api\/factory-erp-import\/bindings\/[a-f0-9-]+\/void-reviews$/.test(path)) { errors.push("unexpected_factory_write"); return; }
    const input = ReviewFactoryErpVoidSchema.safeParse(request.postDataJSON());
    if (input.success) writes.push({ path, input: input.data }); else errors.push("invalid_void_request");
  });
  return { errors, writes, consoleAborts, consoleDiagnostics, revokedOrderReads, beginCurrentRevocation() { revocationStarted = true; },
    expectOneAbort() { if (!abortPath || abortBudget || consoleAborts.length) throw new Error("Only one intentional network abort is allowed"); abortBudget = 1; } };
}
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  for (const element of await page.locator(".fei-workspace,.fei-void-workspace,.fei-void-detail,.fei-void-history,.fei-binding-detail,.fei-receipt").all())
    expect(await element.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
}
async function openWorkspace(page: Page, factoryId?: string) {
  const summary = page.locator("summary").filter({ hasText: /^工厂交付与回执/ }); await expect(summary).toHaveCount(1);
  if (await summary.locator("..").getAttribute("open") === null) await summary.click();
  const area = page.getByRole("region", { name: "工厂 Excel／CSV 状态同步", exact: true }); await expect(area).toBeVisible();
  if (factoryId) await area.getByRole("combobox", { name: /^导入工厂/ }).selectOption(factoryId);
  return area;
}
async function readSource(area: Locator, source: FactoryErpImportView) {
  await area.getByLabel("工厂导入 ID", { exact: true }).fill(source.id);
  await area.getByRole("button", { name: "按导入 ID 读取", exact: true }).click();
  const coverage = area.getByRole("region", { name: "原工厂文件与覆盖范围", exact: true });
  await expect(coverage.getByText(source.id, { exact: true })).toBeVisible(); await expect(coverage).toContainText(source.fileName);
}
async function readBinding(area: Locator, bindingId: string) {
  const value = area.getByRole("region", { name: "工厂作废观察核对", exact: true });
  await value.getByLabel("作废核对绑定 ID", { exact: true }).fill(bindingId);
  await value.getByRole("button", { name: "读取绑定全部作废观察", exact: true }).click();
  await expect(value.getByRole("region", { name: "原工厂绑定完整依据", exact: true }).getByText(bindingId, { exact: true })).toBeVisible();
  await expect(value.getByRole("button", { name: "重新读取完整作废依据", exact: true })).toBeEnabled(); return value;
}
async function expectCounts(value: Locator, total: number, pending: number, requiresOrderHandling: number) {
  await expect(value.locator(':scope > [aria-label="全部作废观察核对计数"]')).toContainText(
    "全部作废观察 " + total + " 条 · 待核对 " + pending + " 条 · 已核对但需订单后续 " + requiresOrderHandling + " 条");
}
async function readObservation(value: Locator, id: string) {
  await value.getByLabel("原作废观察 ID", { exact: true }).fill(id);
  await value.getByRole("button", { name: "按观察 ID 读取作废详情", exact: true }).click();
  const detail = value.getByRole("region", { name: "准确原作废观察与核对状态", exact: true });
  await expect(detail.getByText(id, { exact: true })).toBeVisible(); return detail;
}
async function prepareReview(area: Locator, bindingId: string, observationId: string, source: FactoryErpImportView,
  outcome: ReviewFactoryErpVoid["outcome"], reason: ReviewFactoryErpVoid["reasonCode"]) {
  await readSource(area, source);
  await area.getByRole("button", { name: "选作本次作废核对来源 第 2 行", exact: true }).click();
  const value = await readBinding(area, bindingId), detail = await readObservation(value, observationId);
  await detail.getByRole("button", { name: "核对这条原作废观察", exact: true }).click();
  const form = value.getByRole("form", { name: "登记单条工厂作废核对", exact: true }); await expect(form.locator("fieldset")).toBeEnabled();
  await form.getByRole("combobox", { name: /^核对结论/ }).selectOption(outcome);
  await form.getByRole("combobox", { name: /^核对依据类型/ }).selectOption(reason);
  await form.getByRole("checkbox", { name: /我已核对这条准确作废观察/ }).check();
  await form.getByRole("button", { name: "固定原核对请求并复核", exact: true }).click();
  await expect(value.getByRole("region", { name: "固定原工厂作废核对请求", exact: true })).toContainText(observationId);
  return value;
}
async function executeReview(page: Page, value: Locator, bindingId: string) {
  const path = "/api/factory-erp-import/bindings/" + bindingId + "/void-reviews";
  const [response] = await Promise.all([page.waitForResponse(item => new URL(item.url()).pathname === path && item.request().method() === "POST"),
    value.getByRole("button", { name: "确认登记这条原作废核对", exact: true }).click()]);
  expect(response.status()).toBe(201);
  const result = FactoryErpVoidReviewResultSchema.parse(await response.json()), input = ReviewFactoryErpVoidSchema.parse(response.request().postDataJSON());
  const receipt = value.getByRole("region", { name: "工厂作废核对原回执", exact: true });
  await expect(receipt.getByText(result.id, { exact: true })).toBeVisible(); return { input, result, receipt };
}
async function acknowledge(value: Locator) {
  await value.getByRole("button", { name: "确认原作废核对回执并读取当前状态", exact: true }).click();
  await expect(value.getByRole("region", { name: "工厂作废核对原回执", exact: true })).toHaveCount(0);
}
async function openDetails(area: Locator, title: RegExp) {
  const summary = area.locator("summary").filter({ hasText: title }); await expect(summary).toHaveCount(1);
  if (await summary.locator("..").getAttribute("open") === null) await summary.click(); return summary.locator("..");
}
async function reviewHistory(value: Locator, expected: FactoryErpVoidReviewResult[]) {
  await value.getByRole("button", { name: "读取本绑定全部核对历史", exact: true }).click();
  const history = value.getByRole("region", { name: "工厂作废核对完整历史", exact: true });
  await expect(history).toContainText("本页 " + expected.length + " 笔 本次查询已到末页");
  for (const item of expected) await expect(history.getByText(item.id, { exact: true })).toBeVisible();
  await expect(history.getByRole("button", { name: "下一页作废核对历史", exact: true })).toBeDisabled(); return history;
}

type Scene = Awaited<ReturnType<typeof createScene>>;
async function createScene(owner: Owned, crossOrder: boolean) {
  await owner.startRenderer();
  const first = await prepareDeliveryOrder(1), originalOrders = [first];
  if (crossOrder) {
    const second = await prepareDeliveryOrder(1, false, { release: false }); originalOrders.push(second);
    const lineId = second.lines[0]!, detail = await centerApi<OrderWorkDetail>("order-centers/lines/" + lineId);
    const editor = await centerApi<ProductionEditorDetailView>("production-editor/projects/" + detail.line.editorProjectId);
    const render = editor.renders.find(item => item.versionId === editor.version.id && item.purpose === "production" && item.status === "completed");
    if (!render) throw new Error("Actual reviewed second-order JPG is required before selecting the shared factory");
    const choices = ProductionFactoryChoiceSchema.array().parse(await centerApi("order-centers/lines/" + lineId + "/factories?" + new URLSearchParams({ renderId: render.id, quantity: "2" })));
    const choice = choices.find(item => item.pin.factoryId === first.factoryId && !item.blockers.length);
    if (!choice) throw new Error("Actual shared factory must support the second order; no synthetic pin substitution");
    await centerApi("order-centers/lines/" + lineId + "/release", {
      factoryId: choice.pin.factoryId, factoryVersionId: choice.pin.factoryVersionId, capabilityVersionId: choice.pin.capabilityVersionId,
      supplierId: choice.pin.supplierId, capacityPlan: first.capacity.capacityPlan,
      manufacturing: { versionId: second.manufacturing.versionId, orderUnitConfirmed: true }, quantity: 2,
      expectedRevision: detail.line.revision, expectedProjectionVersion: detail.line.projectionVersion, renderId: render.id,
      expectedCompletionAt: first.capacity.expectedCompletionAt, instructions: "Synthetic explicit same-factory cross-order whole group", idempotencyKey: randomUUID(),
    });
  }
  const packets: ProductionDeliveryPackageView[] = [], items: FactoryErpItemSelection[] = [];
  for (const order of originalOrders) {
    const delivery = await centerApi<ProductionDeliveryWorkspace>("order-centers/deliveries?factory=" + first.factoryId);
    const candidates = order.lines.map(id => delivery.candidates.find(item => item.orderLineId === id));
    if (candidates.some(item => !item)) throw new Error("Actual same-factory cross-order production candidates missing");
    let packet = await centerApi<ProductionDeliveryPackageView>("order-centers/deliveries", { factoryId: first.factoryId, supplierId: first.supplierId,
      items: candidates.map(item => ({ productionOrderId: item!.productionOrderId, productionVersionId: item!.productionVersionId, expectedProjectionVersion: item!.projectionVersion })), idempotencyKey: randomUUID() });
    for (const item of packet.items) {
      if (!item.snapshot?.manufacturing) throw new Error("Real original JPG, quantity and manufacturing pins required");
      expect(item.snapshot.file).toMatchObject({ mediaType: "image/jpeg", dpi: 150 }); expect(item.snapshot.file.path).toMatch(/\.jpe?g$/i);
      expect(item.snapshot.quantity).toBe(2); expect(item.snapshot.factoryStandardId).toBe("ps-pillow-2026-09-17");
      expect(item.snapshot.templateVersionId).not.toBeNull();
      if (item.snapshot.ruleSnapshotStatus === "legacy_missing") expect(item.snapshot.ruleSnapshotChecksum).toBeNull();
      else expect(item.snapshot.ruleSnapshotChecksum).toMatch(/^[a-f0-9]{64}$/);
      packet = await centerApi("order-centers/deliveries/" + packet.id + "/items/" + item.id + "/feedback", {
        kind: "submitted", expectedSequence: 0, fileChecksum: item.snapshot.file.checksum, manufacturingChecksum: item.snapshot.manufacturing.plan.checksum,
        idempotencyKey: randomUUID(), reference: "SYNTHETIC_VOID_ORIGINAL_SUBMISSION", note: "Synthetic actual fixed-file submission receipt only",
        occurredAt: new Date().toISOString(), verifiedByOperator: true,
      });
    }
    for (const item of packet.items) {
      if (!item.snapshot?.manufacturing) throw new Error("Actual submitted original delivery lost its pins");
      expect(item.feedback.map(feedback => feedback.kind)).toEqual(["submitted"]);
      items.push({ deliveryItemId: item.id, productionOrderId: item.productionOrderId, productionVersionId: item.snapshot.productionVersionId,
        fileChecksum: item.snapshot.file.checksum, manufacturingChecksum: item.snapshot.manufacturing.plan.checksum });
    }
    packets.push(packet);
  }
  await owner.stopRenderer();
  const head = "SYNTHETIC-VOID-HEAD-" + randomUUID(), tracking = "SYNTHETIC-VOID-TRACK-" + randomUUID(), marker = "Synthetic private void source " + randomUUID();
  let ordinal = 0;
  async function upload(status: "已审核" | "已出库" | "已作废") {
    ordinal++;
    const row = [head, "Synthetic owned exact factory export", originalOrders.map(item => item.externalId).join(" / "), tracking, "", marker,
      String(items.length), String(items.length * 2), "Synthetic carrier", "Synthetic service", status,
      "2026-10-21 00:00:00", new Date(Date.UTC(2026, 9, 21, 8, 0, ordinal)).toISOString().slice(0, 19).replace("T", " ")];
    const bytes = Buffer.from([FACTORY_ERP_HEADERS, row].map(values => values.map(value => '"' + value.replaceAll('"', '""') + '"').join(",")).join("\r\n"));
    return FactoryErpImportViewSchema.parse(await centerApi("factory-erp-imports", { factoryId: first.factoryId,
      fileName: "synthetic-void-" + ordinal + "-" + owner.nonce + ".csv", contentBase64: bytes.toString("base64"), checksumSha256: sha(bytes),
      options: { csvEncoding: "utf-8", delimiter: "," }, idempotencyKey: randomUUID() }));
  }
  // Same actual owner path as observe/reviewInput in the integration fixture;
  // fixture admission stays separate from the personal compiled-page writes.
  async function observe(status: "已审核" | "已出库" | "已作废") {
    const view = await upload(status), association = view.rows[0]?.association;
    if (!association) throw new Error("Actual owner current association pin required");
    const input = ApplyFactoryErpImportSchema.parse({ fileChecksum: view.fileChecksum, previewChecksum: view.previewChecksum,
      idempotencyKey: randomUUID(), confirmed: true, rows: [{ rowNumber: 2, items, wholeGroupConfirmed: true, association: {
        expectedActiveBindingId: association.activeBindingId, expectedRevision: association.revision, expectedReleaseId: association.releaseId, confirmed: true,
      } }] });
    const result = FactoryErpApplyResultSchema.parse(await centerApi("factory-erp-imports/" + view.id + "/apply", input));
    return { view, result, bindingId: result.observations[0]!.bindingId, observationId: result.observations[0]!.observationId };
  }
  return { first, originalOrders, factoryId: first.factoryId, packets, items, head, tracking, marker, upload, observe };
}
async function assertUnchangedPhysical(owner: Owned, scene: Scene, before: Awaited<ReturnType<typeof physicalState>>) {
  for (const packet of scene.packets) {
    const actual = await centerApi<ProductionDeliveryPackageView>("order-centers/deliveries/" + packet.id);
    for (const item of actual.items) {
      expect(item.feedback.map(value => value.kind)).toEqual(["submitted"]); expect(item.factoryErp?.shippedQuantity).toBeNull();
      const production = await centerApi<{ productionOrder: { status: string }; milestones: { type: string }[]; inspections: unknown[] }>("production/orders/" + item.productionOrderId);
      expect(production.productionOrder.status).toBe("submitted"); expect(production.milestones.map(value => value.type)).toEqual(["submitted"]); expect(production.inspections).toEqual([]);
    }
  }
  const after = await physicalState(owner); owner.proof.physicalBefore = before; owner.proof.physicalAfter = after; expect(after).toEqual(before);
}

test("personal cross-order void reviews keep every old pending observation and original shipped source separate from operator conclusions", async ({ page }, info) => {
  test.setTimeout(240_000); const owner = await ownEnvironment("complete-history"), observed = observations(page);
  owner.proof.pageErrors = observed.errors; owner.proof.consoleDiagnostics = observed.consoleDiagnostics;
  try {
    const scene = await createScene(owner, true); expect(scene.originalOrders).toHaveLength(2);
    const before = await physicalState(owner), shipped = await scene.observe("已出库"), first = await scene.observe("已作废"), second = await scene.observe("已作废");
    expect(first.bindingId).toBe(shipped.bindingId); expect(second.bindingId).toBe(shipped.bindingId); expect(first.observationId).not.toBe(second.observationId);
    const corrected = await scene.upload("已审核"), bindingId = shipped.bindingId;
    await page.setViewportSize({ width: 1440, height: 1000 });
    await loginErp(page, "operator", "/production?" + new URLSearchParams({ q: scene.first.externalId, line: scene.first.lines[0]! }));
    const area = await openWorkspace(page, scene.factoryId);
    const deliveryItem = page.locator(".oc-delivery-item").filter({ hasText: scene.first.externalId }); await expect(deliveryItem).toHaveCount(1);
    const originalSource = await openDetails(deliveryItem, /^核对工厂表格原来源$/);
    await expect(originalSource.getByText(shipped.view.id, { exact: true })).toBeVisible(); await expect(originalSource.getByText(shipped.observationId, { exact: true })).toBeVisible();
    await expect(originalSource).not.toContainText(first.view.id); await expect(originalSource).not.toContainText(second.view.id);
    const voidSource = await openDetails(deliveryItem, /^核对原作废观察与人工记录$/);
    // The current follow-up points to the oldest unresolved observation, not
    // the latest one. The newer exact observation is selected independently below.
    await expect(voidSource.getByText(first.observationId, { exact: true })).toBeVisible(); await expect(voidSource.getByText(first.view.id, { exact: true })).toBeVisible();
    await expect(voidSource).not.toContainText(second.observationId); await expect(voidSource).not.toContainText(second.view.id);
    await expect(voidSource).not.toContainText(shipped.view.id); await expect(voidSource).not.toContainText(shipped.observationId);

    let value = await prepareReview(area, bindingId, second.observationId, corrected, "confirmed_active", "corrected_export");
    await expectCounts(value, 2, 2, 0);
    const complete = value.getByRole("region", { name: "原工厂绑定完整依据", exact: true });
    await openDetails(complete, /^核对原绑定完整 2 个交付项与数量$/);
    for (const item of scene.items) await expect(complete.getByText(item.deliveryItemId, { exact: true })).toBeVisible();
    const newest = await executeReview(page, value, bindingId);
    expect(newest.input.source.importId).toBe(corrected.id); expect(newest.input.observation.importId).toBe(second.view.id);
    expect(newest.result).toMatchObject({ reviewRevision: 1, previousReviewId: null, observation: { id: second.observationId } });
    await storedReview(owner, newest.result, newest.input, actors().operator.userId); await acknowledge(value); await expectCounts(value, 2, 1, 0);
    await value.getByRole("button", { name: "读取下一条待核对作废", exact: true }).click();
    await expect(value.getByRole("region", { name: "准确原作废观察与核对状态", exact: true }).getByText(first.observationId, { exact: true })).toBeVisible();

    value = await prepareReview(area, bindingId, first.observationId, first.view, "followup_required", "needs_factory_confirmation");
    const followup = await executeReview(page, value, bindingId); expect(followup.result).toMatchObject({ reviewRevision: 1, previousReviewId: null });
    await expect(followup.receipt).toContainText("本条仍待跟进 不解除待核对");
    await storedReview(owner, followup.result, followup.input, actors().operator.userId); await acknowledge(value); await expectCounts(value, 2, 1, 0);
    value = await prepareReview(area, bindingId, first.observationId, first.view, "confirmed_voided", "corrected_export");
    const concluded = await executeReview(page, value, bindingId);
    expect(concluded.input.expectedPreviousReviewId).toBe(followup.result.id);
    expect(concluded.result).toMatchObject({ reviewRevision: 2, previousReviewId: followup.result.id, outcome: "confirmed_voided" });
    await expect(concluded.receipt).toContainText("核对完成不等于订单已取消或工厂已停做");
    await storedReview(owner, concluded.result, concluded.input, actors().operator.userId); await acknowledge(value); await expectCounts(value, 2, 0, 1);

    const third = await scene.observe("已作废"); await value.getByRole("button", { name: "重新读取完整作废依据", exact: true }).click();
    await expectCounts(value, 3, 1, 1); await value.getByRole("button", { name: "读取下一条待核对作废", exact: true }).click();
    const pending = value.getByRole("region", { name: "准确原作废观察与核对状态", exact: true });
    await expect(pending.getByText(third.observationId, { exact: true })).toBeVisible(); await expect(pending).toContainText("待核对");
    const pageAll = FactoryErpVoidObservationPageSchema.parse(await centerApi("factory-erp-imports/bindings/" + bindingId + "/void-observations?limit=1"));
    expect(pageAll.basis.summary).toMatchObject({ total: 3, pending: 1, requiresOrderHandling: 1, nextPending: { id: third.observationId } });
    expect(pageAll.items.map(item => item.id)).toEqual([third.observationId]); expect(pageAll.nextCursor).toBe(pageAll.items[0]!.sequence);
    const tail = FactoryErpVoidObservationPageSchema.parse(await centerApi("factory-erp-imports/bindings/" + bindingId + "/void-observations?" + new URLSearchParams({ limit: "1", cursor: String(pageAll.nextCursor) })));
    expect(tail.items.map(item => item.id)).toEqual([second.observationId]); expect(tail.basis.summary).toEqual(pageAll.basis.summary);
    await reviewHistory(value, [concluded.result, followup.result, newest.result]);
    const filtered = FactoryErpVoidReviewPageSchema.parse(await centerApi("factory-erp-imports/bindings/" + bindingId + "/void-reviews?" + new URLSearchParams({ observationId: first.observationId, limit: "1" })));
    expect(filtered.items).toEqual([concluded.result]); expect(filtered.nextCursor).toBe(concluded.result.id);
    const earlier = FactoryErpVoidReviewPageSchema.parse(await centerApi("factory-erp-imports/bindings/" + bindingId + "/void-reviews?" + new URLSearchParams({ observationId: first.observationId, limit: "1", cursor: filtered.nextCursor! })));
    expect(earlier.items).toEqual([followup.result]); expect(earlier.nextCursor).toBeNull();
    await value.getByLabel("原作废核对 ID", { exact: true }).fill(concluded.result.id);
    await value.getByRole("button", { name: "读取原作废核对回执", exact: true }).click();
    const historical = value.getByRole("region", { name: "工厂作废核对历史回执", exact: true });
    await expect(historical.getByText(concluded.result.id, { exact: true })).toBeVisible();
    const originalPins = await openDetails(historical, /^核对本次保存的准确作废来源$/);
    await expect(originalPins.getByText(first.observationId, { exact: true })).toBeVisible(); await expect(originalPins.getByText(first.view.id, { exact: true })).toBeVisible();
    const adoptedPins = await openDetails(historical, /^核对本次明确采用的证据来源$/); await expect(adoptedPins.getByText(first.view.id, { exact: true })).toBeVisible();
    for (const packet of scene.packets) {
      const actual = await centerApi<ProductionDeliveryPackageView>("order-centers/deliveries/" + packet.id);
      for (const item of actual.items) expect(item.factoryErp).toMatchObject({ status: "shipped", importId: shipped.view.id, observationId: shipped.observationId,
        shippedQuantity: null, voidSummary: { total: 3, pending: 1, requiresOrderHandling: 1, nextPending: { id: third.observationId, importId: third.view.id } } });
    }
    const retainedBinding = FactoryErpBindingViewSchema.parse(await centerApi("factory-erp-imports/bindings/" + bindingId));
    expect(retainedBinding.recordedStatus).toBe("shipped"); expect(retainedBinding.quantity).toBe(4);
    expect(await reviewCounts(owner, bindingId)).toEqual({ reviews: 3, audits: 3 });
    expect(observed.writes.map(item => item.input)).toEqual([newest.input, followup.input, concluded.input]);
    await assertUnchangedPhysical(owner, scene, before);
    const historicalHeading = historical.getByRole("heading", { name: "原工厂作废核对回执", exact: true });
    await historicalHeading.scrollIntoViewIfNeeded(); await expect(historicalHeading).toBeInViewport();
    await noOverflow(page); await page.screenshot({ path: info.outputPath("factory-erp-void-review-desktop.png"), fullPage: false });
    await page.setViewportSize({ width: 390, height: 844 }); await historicalHeading.scrollIntoViewIfNeeded(); await expect(historicalHeading).toBeInViewport(); await noOverflow(page);
    await page.screenshot({ path: info.outputPath("factory-erp-void-review-mobile.png"), fullPage: false });
    owner.proof.bindingId = bindingId; owner.proof.reviewIds = [newest.result.id, followup.result.id, concluded.result.id];
    owner.proof.pageErrors = observed.errors; owner.proof.consoleDiagnostics = observed.consoleDiagnostics;
    expect(observed.errors, JSON.stringify(observed.consoleDiagnostics)).toEqual([]); expect(observed.consoleAborts).toEqual([]);
  } finally { await owner.cleanup(); }
});

test("an exact personal void review restores its committed receipt after source expiry and a late successful read cannot survive current permission revocation", async ({ page }) => {
  test.setTimeout(240_000); const owner = await ownEnvironment("expired-response-and-authority");
  let release: (() => void) | undefined, handler: ((route: Route) => Promise<void>) | undefined, match = "", active = 0, delayedFailure = false;
  try {
    const scene = await createScene(owner, false), before = await physicalState(owner), shipped = await scene.observe("已出库"), voided = await scene.observe("已作废");
    const bindingId = shipped.bindingId, path = "/api/factory-erp-import/bindings/" + bindingId + "/void-reviews";
    const observed = observations(page, path);
    owner.proof.pageErrors = observed.errors; owner.proof.consoleDiagnostics = observed.consoleDiagnostics; owner.proof.revokedOrderReads = observed.revokedOrderReads;
    await owner.saveReadonlyRole(); await changeErpRights("readonly", Object.values(Permission));
    await loginErp(page, "readonly", "/production?" + new URLSearchParams({ q: scene.first.externalId, line: scene.first.lines[0]! }));
    let area = await openWorkspace(page, scene.factoryId);
    let value = await prepareReview(area, bindingId, voided.observationId, voided.view, "confirmed_voided", "corrected_export");
    const raw = await openDetails(area, /^读取第 2 行全部 13 个原始列值$/);
    for (const text of [scene.head, scene.tracking, scene.marker]) await expect(raw.getByText(text, { exact: true })).toBeVisible();
    const lost: { input?: ReviewFactoryErpVoid; result?: FactoryErpVoidReviewResult } = {};
    await page.route("**" + path, async route => {
      lost.input = ReviewFactoryErpVoidSchema.parse(route.request().postDataJSON());
      const actual = await route.fetch(); expect(actual.status()).toBe(201); lost.result = FactoryErpVoidReviewResultSchema.parse(await actual.json());
      observed.expectOneAbort(); await route.abort("failed");
    }, { times: 1 });
    await value.getByRole("button", { name: "确认登记这条原作废核对", exact: true }).click();
    await expect(value.getByRole("button", { name: "按原请求恢复作废核对结果", exact: true })).toBeEnabled();
    if (!lost.input || !lost.result) throw new Error("Actual committed original void-review request/receipt missing");
    const originalInput = lost.input, originalResult = lost.result;
    const stored = await storedReview(owner, originalResult, originalInput, actors().readonly.userId);
    expect(await reviewCounts(owner, bindingId)).toEqual({ reviews: 1, audits: 1 });
    await owner.expire(voided.view);
    page.once("dialog", dialog => dialog.accept()); await page.reload(); area = await openWorkspace(page);
    value = area.getByRole("region", { name: "工厂作废观察核对", exact: true });
    const lifecycle = area.getByRole("region", { name: "工厂来源保留与清理凭据", exact: true });
    await expect(lifecycle.locator(".fei-lifecycle-state").filter({ hasText: /^已到期 原文已隐藏/ })).toBeVisible();
    await expect(area.getByRole("region", { name: "原工厂文件与覆盖范围", exact: true })).toHaveCount(0);
    await expect(value.getByRole("form", { name: "登记单条工厂作废核对", exact: true })).toHaveCount(0);
    for (const text of [voided.view.fileName, scene.head, scene.tracking, scene.marker]) await expect(page.getByText(text, { exact: false })).toHaveCount(0);
    await expect(value.getByRole("region", { name: "固定原工厂作废核对请求", exact: true })).toContainText(originalInput.idempotencyKey);
    expect(await reviewCounts(owner, bindingId)).toEqual({ reviews: 1, audits: 1 });
    const [replayed] = await Promise.all([page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === "POST"),
      value.getByRole("button", { name: "按原请求恢复作废核对结果", exact: true }).click()]);
    expect(replayed.status()).toBe(201); expect(ReviewFactoryErpVoidSchema.parse(replayed.request().postDataJSON())).toEqual(originalInput);
    expect(FactoryErpVoidReviewResultSchema.parse(await replayed.json())).toEqual(originalResult);
    await expect(value.getByRole("region", { name: "工厂作废核对原回执", exact: true }).getByText(originalResult.id, { exact: true })).toBeVisible();
    expect(await storedReview(owner, originalResult, originalInput, actors().readonly.userId)).toEqual(stored);
    expect(await reviewCounts(owner, bindingId)).toEqual({ reviews: 1, audits: 1 });
    await acknowledge(value); await expectCounts(value, 1, 0, 1);
    const expiredObservation = await readObservation(value, voided.observationId);
    await expect(expiredObservation.getByRole("button", { name: "核对这条原作废观察", exact: true })).toBeDisabled();
    await expect(value.getByRole("form", { name: "登记单条工厂作废核对", exact: true })).toHaveCount(0);
    await reviewHistory(value, [originalResult]);
    await value.getByLabel("原作废核对 ID", { exact: true }).fill(originalResult.id);
    await value.getByRole("button", { name: "读取原作废核对回执", exact: true }).click();
    await expect(value.getByRole("region", { name: "工厂作废核对历史回执", exact: true }).getByText(originalResult.id, { exact: true })).toBeVisible();
    const life = FactoryErpSourceLifecycleSchema.parse(await centerApi("factory-erp-imports/" + voided.view.id + "/lifecycle"));
    expect(life.access).toBe("expired"); expect(life.purgeStatus).not.toBe("purged");
    const stale = FactoryErpVoidObservationDetailSchema.parse(await centerApi("factory-erp-imports/bindings/" + bindingId + "/void-observations/" + voided.observationId));
    expect(stale.observation).toMatchObject({ id: voided.observationId, sourceReadable: false, pending: false, latestReview: originalResult });
    await page.setViewportSize({ width: 390, height: 844 }); await noOverflow(page);

    const gate = new Promise<void>(resolve => { release = resolve; }); let captured: unknown;
    match = "**/api/factory-erp-import/bindings/" + bindingId + "/void-observations/" + voided.observationId;
    handler = async route => {
      active++;
      try {
        const actual = await route.fetch({ timeout: 15_000 }); expect(actual.status()).toBe(200);
        captured = FactoryErpVoidObservationDetailSchema.parse(await actual.json()); await gate;
        try { await route.fulfill({ response: actual }); } catch (error) { if (!route.request().failure()) throw error; }
      } catch { delayedFailure = true; } finally { active--; }
    };
    await page.route(match, handler);
    await value.getByLabel("原作废观察 ID", { exact: true }).fill(voided.observationId);
    await value.getByRole("button", { name: "按观察 ID 读取作废详情", exact: true }).click();
    await expect.poll(() => captured !== undefined, { timeout: 15_000 }).toBe(true);
    expect(FactoryErpVoidObservationDetailSchema.parse(captured)).toEqual(stale);
    await changeErpRights("readonly", Object.values(Permission).filter(permission => permission !== Permission.OrderPiiRead));
    observed.beginCurrentRevocation();
    // The real identity boundary handles pageshow; unlike focus, this does not
    // intentionally provoke unrelated background private GETs. Its current
    // session check returns 200 with a different authority and hides/reloads.
    const navigation = page.waitForNavigation({ waitUntil: "domcontentloaded" });
    await page.evaluate(() => window.dispatchEvent(new Event("pageshow"))); await navigation;
    await expect(page.getByText("当前账号缺少读取整单资料权限", { exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "工厂作废观察核对", exact: true })).toHaveCount(0);
    if (!release) throw new Error("Synthetic late successful void read gate missing"); release();
    await expect.poll(() => active, { timeout: 15_000 }).toBe(0); expect(delayedFailure).toBe(false);
    await page.unroute(match, handler); handler = undefined;
    for (const name of ["准确原作废观察与核对状态", "工厂作废核对完整历史", "工厂作废核对历史回执", "固定原工厂作废核对请求", "原工厂文件与覆盖范围"])
      await expect(page.getByRole("region", { name, exact: true })).toHaveCount(0);
    for (const text of [originalResult.id, originalInput.idempotencyKey, scene.head, scene.tracking, scene.marker, voided.view.fileName])
      await expect(page.getByText(text, { exact: false })).toHaveCount(0);
    // APIRequestContext still authenticates the same person; the actual BFF
    // permission gate must reject the absent fifth write/read prerequisite.
    const denied = await page.request.get("/api/factory-erp-import/bindings/" + bindingId + "/void-observations");
    expect(denied.status()).toBe(403);
    const deniedWrite = await page.request.post(path, { data: originalInput, headers: { Origin: new URL(page.url()).origin } });
    expect(deniedWrite.status()).toBe(403);
    expect(observed.revokedOrderReads).toEqual([]);
    expect(observed.writes.map(item => item.input)).toEqual([originalInput, originalInput]);
    expect(await reviewCounts(owner, bindingId)).toEqual({ reviews: 1, audits: 1 });
    expect(await storedReview(owner, originalResult, originalInput, actors().readonly.userId)).toEqual(stored);
    await assertUnchangedPhysical(owner, scene, before);
    owner.proof.reviewId = originalResult.id; owner.proof.requestChecksum = originalResult.requestChecksum;
    owner.proof.deliberateAbortCount = 1; owner.proof.observedAbortConsole = observed.consoleAborts;
    owner.proof.pageErrors = observed.errors; owner.proof.consoleDiagnostics = observed.consoleDiagnostics;
    expect(observed.consoleAborts.length).toBeLessThanOrEqual(1); expect(observed.errors, JSON.stringify(observed.consoleDiagnostics)).toEqual([]);
  } finally {
    release?.();
    try { await expect.poll(() => active, { timeout: 15_000 }).toBe(0); if (handler) await page.unroute(match, handler); }
    finally { await owner.cleanup(); }
  }
});
