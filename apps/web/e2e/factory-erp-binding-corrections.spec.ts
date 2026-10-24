import { expect, test, type Locator, type Page } from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Sql } from "../../../packages/database/node_modules/postgres";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import {
  FACTORY_ERP_HEADERS, ApplyFactoryErpImportSchema, FactoryErpImportViewSchema, FactoryErpApplyResultSchema,
  FactoryErpSourceLifecycleSchema, type FactoryErpItemSelection,
} from "@yummyai/contracts/order/factory-erp-import";
import {
  ChangeFactoryErpBindingSchema, FactoryErpBindingViewSchema, FactoryErpBindingChangeResultSchema,
  type ChangeFactoryErpBinding, type FactoryErpBindingChangeResult,
} from "@yummyai/contracts/order/factory-erp-binding";
import type { ProductionDeliveryPackageView, ProductionDeliveryWorkspace } from "@yummyai/contracts/order/production-delivery";
import { requireDisposableIntegrationEnvironment } from "../../../tools/testing/require-disposable-integration.mjs";
import { centerApi } from "./order-centers-fixture";
import { prepareDeliveryOrder } from "./production-delivery-fixture";
import { startProductionEditorWorker, stopProductionEditorWorker } from "./production-editor-fixture";
import { actors, loginErp } from "./erp-identity-fixture";

const workspace = fileURLToPath(new URL("../../../", import.meta.url));
const ownedRoot = resolve(workspace, "tmp/factory-erp-binding-20261021-c6b2e941/frontend-browser");
const databaseRequire = createRequire(new URL("../../../packages/database/package.json", import.meta.url));
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const physicalTables = ["production_orders", "production_order_versions", "production_manufacturing_bindings", "production_milestone_events",
  "production_delivery_feedback", "factory_capacity_reservations", "factory_capacity_events", "factory_capacity_stop_effects",
  "production_quantity_reports", "production_quantity_reviews", "quality_inspections", "quality_inspection_groups", "quality_group_defects",
  "shipments", "shipment_versions", "shipment_production_allocations", "inventory_movements", "inventory_reservation_events"] as const;

function isolation() {
  const url = new URL(requireDisposableIntegrationEnvironment());
  const nonce = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(url.pathname)?.[1];
  if (!nonce || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    process.env.E2E_FACTORY_ERP_BINDING_ISOLATED !== "1" || process.env.E2E_FACTORY_ERP_IMPORT_ISOLATED !== "1" ||
    process.env.E2E_FACTORY_ERP_SOURCE_RETENTION_ISOLATED !== "1" || process.env.E2E_LEGACY_SCHEMA_TARGET !== "current" ||
    process.env.E2E_COMPILED_WEB !== "1" || process.env.WEB_AUTH_MODE !== "personal" || process.env.S3_PRIVATE_BUCKET !== `order-daily-e2e-${nonce}`)
    throw new Error("Exact current-schema compiled nonce factory binding database and bucket required before connection");
  return { url, nonce, databaseName: `order_daily_e2e_${nonce}` };
}

let database: Sql | undefined, renderer: ChildProcess | undefined;
let originalClock: string | undefined, clockChanged = false, databaseName = "", outputDirectory: string | undefined;
const proof: { nonce?: string; originalDdlSha256?: string; restoredDdlSha256?: string; restored?: boolean; rendererStopped?: boolean;
  originalBindingId?: string; replacementBindingId?: string; correctionId?: string; releaseId?: string;
  correctRequestSha256?: string; releaseRequestSha256?: string; physicalBefore?: unknown; physicalAfter?: unknown;
  cleanupErrors?: string[]; cleanupAttempts?: string[][] } = {};
function connection() { if (!database) throw new Error("Owned disposable binding database connection missing"); return database; }
async function checkDatabase() {
  const isolated = isolation();
  if (isolated.databaseName !== databaseName) throw new Error("Owned binding database scope changed");
  const [actual] = await connection()<{ name: string }[]>`select current_database() as name`;
  if (actual?.name !== databaseName) throw new Error("Exact nonce binding database identity changed; refusing source-clock DDL");
}
async function restoreClock() {
  if (!originalClock || !database) return;
  await checkDatabase();
  if (clockChanged) await database.unsafe(originalClock);
  const [row] = await database<{ definition: string }[]>`select pg_get_functiondef('public.factory_erp_source_now()'::regprocedure) as definition`;
  proof.restoredDdlSha256 = sha(row?.definition ?? "");
  proof.restored = proof.restoredDdlSha256 === proof.originalDdlSha256;
  if (!proof.restored) throw new Error("Original source-clock DDL restoration SHA differs");
  clockChanged = false;
}
async function cleanup() {
  const errors: string[] = [];
  try { await stopProductionEditorWorker(renderer); renderer = undefined; proof.rendererStopped = true; }
  catch { errors.push("production_renderer_not_terminated"); }
  if (!database && originalClock && clockChanged) {
    try {
      const isolated = isolation();
      if (isolated.databaseName !== databaseName) throw new Error("Original source-clock database changed");
      database = (databaseRequire("postgres") as (url: string, options: { max: number }) => Sql)(isolated.url.toString(), { max: 1 });
    } catch { errors.push("source_clock_restore_reconnection_refused"); }
  }
  try { await restoreClock(); } catch { errors.push("source_clock_not_restored"); }
  if (database) {
    try { await database.end({ timeout: 5 }); database = undefined; }
    catch { errors.push("owned_binding_database_connection_not_closed"); }
  }
  proof.cleanupErrors = errors; (proof.cleanupAttempts ??= []).push([...errors]);
  if (outputDirectory) await writeFile(resolve(outputDirectory, "binding-clock-and-renderer-cleanup.json"), JSON.stringify(proof, null, 2) + "\n");
  if (errors.length) throw new Error("Factory binding acceptance cleanup incomplete: " + errors.join(","));
}
test.afterAll(cleanup);

async function physicalState() {
  await checkDatabase();
  const snapshot: Record<string, { rows: number; hash: string }> = {};
  for (const table of physicalTables) {
    const [row] = await connection().unsafe<{ rows: number; hash: string }[]>(
      `select count(*)::integer as rows,md5(coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text)::text,'[]')) as hash from ${table} t`);
    if (!row) throw new Error("Owned physical fact snapshot missing");
    snapshot[table] = row;
  }
  return snapshot;
}
async function bindingCounts(factoryId: string) {
  await checkDatabase();
  const [row] = await connection()<{ bindings: number; active: number; changes: number; applications: number; observations: number; change_audits: number }[]>`
    select (select count(*)::integer from factory_erp_bindings where factory_id=${factoryId}::uuid) as bindings,
      (select count(*)::integer from factory_erp_bindings where factory_id=${factoryId}::uuid and released_by is null) as active,
      (select count(*)::integer from factory_erp_binding_changes where factory_id=${factoryId}::uuid) as changes,
      (select count(*)::integer from factory_erp_applications a join factory_erp_imports i on i.id=a.import_id where i.factory_id=${factoryId}::uuid) as applications,
      (select count(*)::integer from factory_erp_observations o join factory_erp_bindings b on b.id=o.binding_id where b.factory_id=${factoryId}::uuid) as observations,
      (select count(*)::integer from audit_events a join factory_erp_binding_changes c on c.id=a.entity_id where c.factory_id=${factoryId}::uuid and a.action='factory_erp.binding_changed') as change_audits`;
  if (!row) throw new Error("Owned binding counts missing");
  return row;
}
async function savedChange(result: FactoryErpBindingChangeResult, input: ChangeFactoryErpBinding) {
  await checkDatabase();
  const [row] = await connection()<{ actor: string; request_key: string; request_checksum: string; request_canonical: string; input: unknown; result: unknown }[]>`
    select created_by::text as actor,idempotency_key::text as request_key,request_checksum,request_canonical,input,result
    from factory_erp_binding_changes where id=${result.id}::uuid`;
  expect(row?.actor).toBe(actors().operator.userId);
  expect(row?.request_key).toBe(input.idempotencyKey);
  expect(row?.request_canonical).toBe(canonicalJson({ version: 1, operation: "factory-erp-binding-change", bindingId: result.bindingId, input }));
  expect(row?.request_checksum).toBe(result.requestChecksum);
  expect(ChangeFactoryErpBindingSchema.parse(row?.input)).toEqual(input);
  expect(FactoryErpBindingChangeResultSchema.parse(row?.result)).toEqual(result);
  return row;
}

async function openWorkspace(page: Page, factoryId?: string) {
  const summary = page.locator("summary").filter({ hasText: /^工厂交付与回执/ });
  await expect(summary).toHaveCount(1);
  if (await summary.locator("..").getAttribute("open") === null) await summary.click();
  const area = page.getByRole("region", { name: "工厂 Excel／CSV 状态同步", exact: true });
  await expect(area).toBeVisible();
  if (factoryId) await area.getByRole("combobox", { name: "导入工厂", exact: true }).selectOption(factoryId);
  return area;
}
async function readSource(area: Locator, id: string) {
  await area.getByLabel("工厂导入 ID", { exact: true }).fill(id);
  await area.getByRole("button", { name: "按导入 ID 读取", exact: true }).click();
  await expect(area.getByRole("region", { name: "原工厂文件与覆盖范围", exact: true }).getByText(id, { exact: true })).toBeVisible();
}
async function reopen(page: Page) {
  page.once("dialog", dialog => dialog.accept());
  await page.reload();
  return openWorkspace(page);
}
async function restoreOriginal(page: Page, area: Locator, bindingId: string, input: ChangeFactoryErpBinding) {
  const retry = area.getByRole("button", { name: "按原请求恢复绑定变更结果", exact: true });
  await expect(retry).toBeEnabled();
  const [response] = await Promise.all([
    page.waitForResponse(value => new URL(value.url()).pathname === `/api/factory-erp-import/bindings/${bindingId}/changes` && value.request().method() === "POST"),
    retry.click(),
  ]);
  expect(response.status()).toBe(201);
  expect(ChangeFactoryErpBindingSchema.parse(response.request().postDataJSON())).toEqual(input);
  return FactoryErpBindingChangeResultSchema.parse(await response.json());
}

test("personal factory binding partially overlaps a new group without moving old shipped facts and restores an expired-source release with its exact original request", async ({ page }) => {
  test.setTimeout(240_000);
  const isolated = isolation(); databaseName = isolated.databaseName; proof.nonce = isolated.nonce;
  await mkdir(ownedRoot, { recursive: true }); outputDirectory = resolve(ownedRoot, isolated.nonce); await mkdir(outputDirectory);
  database = (databaseRequire("postgres") as (url: string, options: { max: number }) => Sql)(isolated.url.toString(), { max: 1 });
  const errors: string[] = [], writes: Array<{ path: string; input: ChangeFactoryErpBinding }> = [];
  const expectedAborts = new Map<string, number>(), observedAbortConsole: string[] = [];
  page.on("pageerror", () => errors.push("pageerror"));
  page.on("console", message => {
    if (message.type() !== "error") return;
    let path = ""; try { path = new URL(message.location().url).pathname; } catch { /* No request identity means no exception. */ }
    // Chromium may log its deliberate aborted fetch once. No other console error is exempt.
    if (message.text() === "Failed to load resource: net::ERR_FAILED" && (expectedAborts.get(path) ?? 0) > 0) {
      expectedAborts.set(path, expectedAborts.get(path)! - 1); observedAbortConsole.push(path);
    } else errors.push("consoleerror");
  });
  page.on("request", request => {
    const path = new URL(request.url()).pathname;
    if (request.method() === "POST" && path.startsWith("/api/factory-erp-import/"))
      writes.push({ path, input: ChangeFactoryErpBindingSchema.parse(request.postDataJSON()) });
  });
  try {
    await checkDatabase();
    const [clock] = await connection()<{ definition: string }[]>`select pg_get_functiondef('public.factory_erp_source_now()'::regprocedure) as definition`;
    if (!clock || !/AS \$function\$\s*SELECT\s+clock_timestamp\(\)\s*;?\s*\$function\$/i.test(clock.definition))
      throw new Error("Fresh original factory source-clock DDL required");
    originalClock = clock.definition; proof.originalDdlSha256 = sha(originalClock);

    renderer = await startProductionEditorWorker();
    const order = await prepareDeliveryOrder(3);
    const delivery = await centerApi<ProductionDeliveryWorkspace>(`order-centers/deliveries?factory=${order.factoryId}`);
    const candidates = order.lines.map(lineId => {
      const selected = delivery.candidates.find(item => item.orderLineId === lineId);
      if (!selected) throw new Error("Real synthetic production candidate missing");
      expect(selected.quantity).toBe(2); return selected;
    });
    const packet = await centerApi<ProductionDeliveryPackageView>("order-centers/deliveries", {
      factoryId: order.factoryId, supplierId: order.supplierId, idempotencyKey: randomUUID(),
      items: candidates.map(item => ({ productionOrderId: item.productionOrderId, productionVersionId: item.productionVersionId, expectedProjectionVersion: item.projectionVersion })),
    });
    expect(packet.items).toHaveLength(3);
    const items = candidates.map(candidate => {
      const item = packet.items.find(value => value.productionOrderId === candidate.productionOrderId);
      if (!item?.snapshot?.manufacturing) throw new Error("Real original delivery JPG and manufacturing evidence required");
      expect(item.snapshot.file.path).toMatch(/\.jpe?g$/i);
      expect(item.snapshot.file).toMatchObject({ mediaType: "image/jpeg", dpi: 150 });
      expect(item.snapshot.quantity).toBe(2); expect(item.snapshot.factoryStandardId).toBe("ps-pillow-2026-09-17");
      expect(item.snapshot.templateVersionId).not.toBeNull();
      // This is the real pinned historical value, never a backfilled Rule Center snapshot.
      if (item.snapshot.ruleSnapshotStatus === "legacy_missing") expect(item.snapshot.ruleSnapshotChecksum).toBeNull();
      else expect(item.snapshot.ruleSnapshotChecksum).toMatch(/^[a-f0-9]{64}$/);
      return item;
    });
    for (const item of items) await centerApi(`order-centers/deliveries/${packet.id}/items/${item.id}/feedback`, {
      kind: "submitted", expectedSequence: 0, fileChecksum: item.snapshot!.file.checksum, manufacturingChecksum: item.snapshot!.manufacturing!.plan.checksum,
      idempotencyKey: randomUUID(), reference: "SYNTHETIC_BINDING_ORIGINAL_SUBMISSION", note: "Synthetic operator checked actual original JPG submission",
      occurredAt: new Date().toISOString(), verifiedByOperator: true,
    });
    await stopProductionEditorWorker(renderer); renderer = undefined; proof.rendererStopped = true;
    const physicalBefore = await physicalState(); proof.physicalBefore = physicalBefore;
    const selections: FactoryErpItemSelection[] = items.map(item => ({ deliveryItemId: item.id, productionOrderId: item.productionOrderId,
      productionVersionId: item.snapshot!.productionVersionId, fileChecksum: item.snapshot!.file.checksum, manufacturingChecksum: item.snapshot!.manufacturing!.plan.checksum }));
    const head = "SYNTHETIC-BINDING-HEAD-" + randomUUID(), tracking = "SYNTHETIC-BINDING-TRACK-" + randomUUID(), rawMarker = "Synthetic binding source private cell " + randomUUID();
    async function uploadSource(status: "已审核" | "已出库", name: string) {
      const row = [head, "Synthetic owned binding export", order.externalId, tracking, "", rawMarker, "2", "4", "Synthetic carrier", "Synthetic service", status,
        "2026-10-21 08:09:10", "2026-10-21 09:10:11"];
      const bytes = Buffer.from([FACTORY_ERP_HEADERS, row].map(values => values.map(value => `"${value.replaceAll('"', '""')}"`).join(",")).join("\r\n"));
      return FactoryErpImportViewSchema.parse(await centerApi("factory-erp-imports", { factoryId: order.factoryId, fileName: name,
        contentBase64: bytes.toString("base64"), checksumSha256: sha(bytes), options: { csvEncoding: "utf-8", delimiter: "," }, idempotencyKey: randomUUID() }));
    }
    const initial = await uploadSource("已出库", `synthetic-binding-original-${isolated.nonce}.csv`), association = initial.rows[0]?.association;
    if (!association) throw new Error("Owner current association evidence required before original seeding");
    const initialInput = ApplyFactoryErpImportSchema.parse({ fileChecksum: initial.fileChecksum, previewChecksum: initial.previewChecksum,
      idempotencyKey: randomUUID(), confirmed: true, rows: [{ rowNumber: 2, wholeGroupConfirmed: true, items: selections.slice(0, 2),
        association: { expectedActiveBindingId: association.activeBindingId, expectedRevision: association.revision, expectedReleaseId: association.releaseId, confirmed: true } }] });
    const originalApplication = FactoryErpApplyResultSchema.parse(await centerApi(`factory-erp-imports/${initial.id}/apply`, initialInput));
    const originalBindingId = originalApplication.observations[0]!.bindingId; proof.originalBindingId = originalBindingId;
    const original = FactoryErpBindingViewSchema.parse(await centerApi(`factory-erp-imports/bindings/${originalBindingId}`));
    expect(original).toMatchObject({ revision: 1, state: "active", quantity: 4, recordedStatus: "shipped", observationSequence: 1 });
    const fileName = `synthetic-binding-current-${isolated.nonce}.csv`, source = await uploadSource("已审核", fileName);
    expect(source.rows[0]!.binding?.id).toBe(originalBindingId);
    expect(source.rows[0]!.association).toEqual({ activeBindingId: originalBindingId, revision: 1, releaseId: null });

    await page.setViewportSize({ width: 1440, height: 1000 });
    await loginErp(page, "operator", `/production?q=${order.externalId}&line=${order.lines[0]}`);
    let area = await openWorkspace(page, order.factoryId); await readSource(area, source.id);
    await area.getByRole("button", { name: "解除或更正原绑定 第 2 行", exact: true }).click();
    let editor = area.getByRole("region", { name: "解除或更正原工厂绑定", exact: true });
    await expect(editor.getByRole("region", { name: "原工厂绑定完整依据", exact: true }).getByText(original.itemsChecksum, { exact: true })).toBeVisible();
    await editor.getByRole("combobox", { name: /^绑定变更方式/ }).selectOption("correct");
    await editor.getByRole("combobox", { name: /^绑定变更原因/ }).selectOption("wrong_group");
    await editor.getByLabel("查询更正新组原生产文件", { exact: true }).fill(order.externalId);
    await editor.getByRole("button", { name: "查询更正原生产候选", exact: true }).click();
    for (const item of items) await expect(editor.getByRole("checkbox", { name: `选择更正原交付项 ${item.id}`, exact: true })).toBeEnabled();
    await editor.getByRole("checkbox", { name: `选择更正原交付项 ${items[0]!.id}`, exact: true }).check();
    await editor.getByRole("checkbox", { name: `选择更正原交付项 ${items[1]!.id}`, exact: true }).check();
    await editor.getByRole("checkbox", { name: /我已核对完整原组/ }).check();
    await expect(editor.getByText("新旧完整组完全相同 不能作为更正 请核对真正需要替换的原生产组", { exact: true })).toBeVisible();
    await expect(editor.getByRole("button", { name: "固定原请求并核对变更", exact: true })).toBeDisabled();
    await editor.getByRole("checkbox", { name: `选择更正原交付项 ${items[0]!.id}`, exact: true }).uncheck();
    await editor.getByRole("checkbox", { name: `选择更正原交付项 ${items[2]!.id}`, exact: true }).check();
    await expect(editor.getByText("已选原生产计数 4 · 当前原表商品总数 4", { exact: true })).toBeVisible();
    await editor.getByRole("checkbox", { name: /我已核对完整原组/ }).check();
    await editor.getByRole("button", { name: "固定原请求并核对变更", exact: true }).click();
    const lostCorrection: { input?: ChangeFactoryErpBinding; result?: FactoryErpBindingChangeResult } = {};
    await page.route(`**/api/factory-erp-import/bindings/${originalBindingId}/changes`, async route => {
      lostCorrection.input = ChangeFactoryErpBindingSchema.parse(route.request().postDataJSON());
      const response = await route.fetch(); expect(response.status()).toBe(201);
      lostCorrection.result = FactoryErpBindingChangeResultSchema.parse(await response.json());
      expectedAborts.set(`/api/factory-erp-import/bindings/${originalBindingId}/changes`, 1);
      await route.abort("failed");
    }, { times: 1 });
    await area.getByRole("button", { name: "确认更正并应用本行到新组", exact: true }).click();
    await expect(area.getByRole("button", { name: "按原请求恢复绑定变更结果", exact: true })).toBeEnabled();
    if (!lostCorrection.input || !lostCorrection.result?.replacementBindingId) throw new Error("Actual committed correction receipt missing");
    expect(lostCorrection.input).toMatchObject({ action: "correct", expectedRevision: 1, expectedItemsChecksum: original.itemsChecksum, expectedObservationSequence: 1 });
    expect(lostCorrection.result.requestChecksum).toBe(sha(canonicalJson({ version: 1, operation: "factory-erp-binding-change", bindingId: originalBindingId, input: lostCorrection.input })));
    if (lostCorrection.input.action !== "correct") throw new Error("Actual correction request required");
    expect(new Set(lostCorrection.input.items.map(item => item.deliveryItemId))).toEqual(new Set([items[1]!.id, items[2]!.id]));
    const correctedCounts = await bindingCounts(order.factoryId);
    const correctionFact = await savedChange(lostCorrection.result, lostCorrection.input);
    expect(correctedCounts).toEqual({ bindings: 2, active: 1, changes: 1, applications: 2, observations: 2, change_audits: 1 });
    area = await reopen(page);
    const correction = await restoreOriginal(page, area, originalBindingId, lostCorrection.input);
    expect(correction).toEqual(lostCorrection.result); expect(await bindingCounts(order.factoryId)).toEqual(correctedCounts);
    expect(await savedChange(correction, lostCorrection.input)).toEqual(correctionFact);
    proof.correctionId = correction.id; proof.replacementBindingId = correction.replacementBindingId!; proof.correctRequestSha256 = correction.requestChecksum;
    let receipt = area.getByRole("region", { name: "原工厂绑定变更回执", exact: true });
    await expect(receipt.getByText(correction.id, { exact: true })).toBeVisible();
    await receipt.scrollIntoViewIfNeeded(); await page.screenshot({ path: resolve(outputDirectory, "factory-erp-binding-correction-desktop.png"), fullPage: false });
    await area.getByRole("button", { name: "确认原绑定变更回执并读取当前状态", exact: true }).click();
    const newBindingId = correction.replacementBindingId!;
    const historical = FactoryErpBindingViewSchema.parse(await centerApi(`factory-erp-imports/bindings/${originalBindingId}`));
    const current = FactoryErpBindingViewSchema.parse(await centerApi(`factory-erp-imports/bindings/${newBindingId}`));
    expect(historical).toMatchObject({ state: "released", recordedStatus: "shipped", revision: 1, releasedBy: correction.id, nextBindingId: newBindingId });
    expect(current).toMatchObject({ state: "active", recordedStatus: "scheduled", revision: 2, previousBindingId: originalBindingId, quantity: 4 });
    expect(new Set(current.items.map(item => item.deliveryItemId))).toEqual(new Set([items[1]!.id, items[2]!.id]));
    const progressed = await centerApi<ProductionDeliveryPackageView>(`order-centers/deliveries/${packet.id}`);
    expect(progressed.items.find(item => item.id === items[0]!.id)?.factoryErp).toMatchObject({ bindingId: originalBindingId, bindingRevision: 1,
      bindingReleased: true, bindingReleaseId: correction.id, status: null, historicalStatus: "shipped" });
    for (const item of items.slice(1)) expect(progressed.items.find(value => value.id === item.id)?.factoryErp).toMatchObject({ bindingId: newBindingId,
      bindingRevision: 2, bindingReleased: false, bindingReleaseId: null, historicalStatus: null, status: "scheduled", shippedQuantity: null });
    expect(await physicalState()).toEqual(physicalBefore);

    const editButton = area.getByRole("button", { name: "解除或更正原绑定 第 2 行", exact: true });
    await expect(editButton).toBeEnabled(); await editButton.click();
    editor = area.getByRole("region", { name: "解除或更正原工厂绑定", exact: true });
    await expect(editor.getByRole("region", { name: "原工厂绑定完整依据", exact: true }).getByText(current.itemsChecksum, { exact: true })).toBeVisible();
    await editor.getByRole("combobox", { name: /^绑定变更原因/ }).selectOption("operator_confirmed_change");
    await editor.getByRole("checkbox", { name: /我已核对完整原组/ }).check();
    await editor.getByRole("button", { name: "固定原请求并核对变更", exact: true }).click();
    const lostRelease: { input?: ChangeFactoryErpBinding; result?: FactoryErpBindingChangeResult } = {};
    await page.route(`**/api/factory-erp-import/bindings/${newBindingId}/changes`, async route => {
      lostRelease.input = ChangeFactoryErpBindingSchema.parse(route.request().postDataJSON());
      const response = await route.fetch(); expect(response.status()).toBe(201);
      lostRelease.result = FactoryErpBindingChangeResultSchema.parse(await response.json());
      expectedAborts.set(`/api/factory-erp-import/bindings/${newBindingId}/changes`, 1);
      await route.abort("failed");
    }, { times: 1 });
    await area.getByRole("button", { name: "确认仅解除原组关联", exact: true }).click();
    await expect(area.getByRole("button", { name: "按原请求恢复绑定变更结果", exact: true })).toBeEnabled();
    if (!lostRelease.input || !lostRelease.result) throw new Error("Actual committed release receipt missing");
    expect(lostRelease.input).toMatchObject({ action: "release", expectedRevision: 2, expectedItemsChecksum: current.itemsChecksum, expectedObservationSequence: current.observationSequence });
    expect(lostRelease.result.requestChecksum).toBe(sha(canonicalJson({ version: 1, operation: "factory-erp-binding-change", bindingId: newBindingId, input: lostRelease.input })));
    const releasedCounts = await bindingCounts(order.factoryId);
    const releaseFact = await savedChange(lostRelease.result, lostRelease.input);
    expect(releasedCounts).toEqual({ bindings: 2, active: 0, changes: 2, applications: 2, observations: 2, change_audits: 2 });

    // Only the precise disposable source clock changes; production/order clocks remain untouched.
    await checkDatabase();
    const expiredAt = new Date(Date.parse(source.expiresAt) + 1).toISOString();
    if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(expiredAt)) throw new Error("Exact synthetic expiry instant required");
    const replacement = originalClock.replace(/AS \$function\$[\s\S]*?\$function\$/, `AS $function$ SELECT '${expiredAt}'::timestamptz $function$`);
    if (replacement === originalClock) throw new Error("Source-clock DDL body unchanged");
    clockChanged = true; await connection().unsafe(replacement);
    area = await reopen(page);
    const lifecycle = area.getByRole("region", { name: "工厂来源保留与清理凭据", exact: true });
    await expect(lifecycle.locator(".fei-lifecycle-state").filter({ hasText: /^已到期 原文已隐藏/ })).toBeVisible();
    await expect(area.getByRole("region", { name: "原工厂文件与覆盖范围", exact: true })).toHaveCount(0);
    await expect(area.getByRole("region", { name: "解除或更正原工厂绑定", exact: true })).toHaveCount(0);
    for (const value of [fileName, head, tracking, rawMarker]) await expect(page.getByText(value, { exact: false })).toHaveCount(0);
    const release = await restoreOriginal(page, area, newBindingId, lostRelease.input);
    expect(release).toEqual(lostRelease.result); expect(await bindingCounts(order.factoryId)).toEqual(releasedCounts);
    expect(await savedChange(release, lostRelease.input)).toEqual(releaseFact);
    expect(release).toMatchObject({ action: "release", replacementBindingId: null, replacementRevision: null, application: null });
    proof.releaseId = release.id; proof.releaseRequestSha256 = release.requestChecksum;
    receipt = area.getByRole("region", { name: "原工厂绑定变更回执", exact: true });
    await expect(receipt.getByText(release.id, { exact: true })).toBeVisible();
    await area.getByRole("button", { name: "确认原绑定变更回执并读取当前状态", exact: true }).click();

    const writesBeforeHistory = writes.length;
    await area.locator("summary").filter({ hasText: /^读取本工厂完整绑定与变更历史$/ }).click();
    const history = area.getByRole("region", { name: "工厂完整绑定修订历史", exact: true });
    await expect(history.getByText("本页 2 个关联修订 本次查询已到末页", { exact: true })).toBeVisible();
    await history.getByLabel("原绑定 ID", { exact: true }).fill(originalBindingId);
    await history.getByRole("button", { name: "按绑定 ID 读取", exact: true }).click();
    let bindingDetail = history.getByRole("region", { name: "原工厂绑定完整依据", exact: true });
    await expect(bindingDetail.getByText("工厂已发货", { exact: true })).toBeVisible();
    await bindingDetail.locator("summary").filter({ hasText: /^核对原绑定完整 2 个交付项与数量$/ }).click();
    for (const item of items.slice(0, 2)) await expect(bindingDetail.getByText(item.id, { exact: true })).toBeVisible();
    await history.getByLabel("原绑定变更 ID", { exact: true }).fill(correction.id);
    await history.getByRole("button", { name: "读取原绑定变更回执", exact: true }).click();
    await expect(history.getByRole("region", { name: "原工厂绑定变更回执", exact: true }).getByText(correction.id, { exact: true })).toBeVisible();
    await history.getByRole("button", { name: "读取后一关联修订", exact: true }).click();
    bindingDetail = history.getByRole("region", { name: "原工厂绑定完整依据", exact: true });
    await expect(bindingDetail.getByText("已排产", { exact: true })).toBeVisible();
    await expect(bindingDetail.getByText("工厂已发货", { exact: true })).toHaveCount(0);
    await history.getByLabel("原绑定变更 ID", { exact: true }).fill(release.id);
    await history.getByRole("button", { name: "读取原绑定变更回执", exact: true }).click();
    const historicalReceipt = history.getByRole("region", { name: "原工厂绑定变更回执", exact: true });
    await expect(historicalReceipt.getByText(release.id, { exact: true })).toBeVisible();
    await expect(historicalReceipt.getByText(release.requestChecksum, { exact: true })).toBeVisible();
    expect(writes).toHaveLength(writesBeforeHistory);
    expect(writes.map(value => value.path)).toEqual([
      `/api/factory-erp-import/bindings/${originalBindingId}/changes`, `/api/factory-erp-import/bindings/${originalBindingId}/changes`,
      `/api/factory-erp-import/bindings/${newBindingId}/changes`, `/api/factory-erp-import/bindings/${newBindingId}/changes`,
    ]);
    expect(writes.map(value => value.input)).toEqual([lostCorrection.input, lostCorrection.input, lostRelease.input, lostRelease.input]);
    expect(await bindingCounts(order.factoryId)).toEqual(releasedCounts);
    const finalPacket = await centerApi<ProductionDeliveryPackageView>(`order-centers/deliveries/${packet.id}`);
    for (const item of finalPacket.items) {
      expect(item.feedback.map(feedback => feedback.kind)).toEqual(["submitted"]);
      expect(item.factoryErp).toMatchObject(item.id === items[0]!.id ? {
        bindingId: originalBindingId, bindingRevision: 1, bindingReleased: true, bindingReleaseId: correction.id,
        historicalStatus: "shipped", status: null, shippedQuantity: null,
      } : {
        bindingId: newBindingId, bindingRevision: 2, bindingReleased: true, bindingReleaseId: release.id,
        historicalStatus: "scheduled", status: null, shippedQuantity: null,
      });
      const production = await centerApi<{ productionOrder: { status: string }; milestones: { type: string }[]; inspections: unknown[] }>(`production/orders/${item.productionOrderId}`);
      expect(production.productionOrder.status).toBe("submitted"); expect(production.milestones.map(milestone => milestone.type)).toEqual(["submitted"]); expect(production.inspections).toEqual([]);
    }
    const physicalAfter = await physicalState(); proof.physicalAfter = physicalAfter; expect(physicalAfter).toEqual(physicalBefore);
    const sourceState = FactoryErpSourceLifecycleSchema.parse(await centerApi(`factory-erp-imports/${source.id}/lifecycle`));
    expect(sourceState.access).toBe("expired"); expect(sourceState.purgeStatus).not.toBe("purged");
    // Expiry is not a claim of physical deletion; no retention worker runs in this test.
    await page.setViewportSize({ width: 390, height: 844 }); await historicalReceipt.scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    for (const element of await page.locator(".fei-workspace,.fei-binding-history,.fei-receipt").all())
      expect(await element.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    await page.screenshot({ path: resolve(outputDirectory, "factory-erp-binding-expired-release-mobile.png"), fullPage: false });
    expect(observedAbortConsole.length).toBeLessThanOrEqual(2);
    expect(new Set(observedAbortConsole).size).toBe(observedAbortConsole.length);
    expect(errors).toEqual([]);
  } finally { await cleanup(); }
});
