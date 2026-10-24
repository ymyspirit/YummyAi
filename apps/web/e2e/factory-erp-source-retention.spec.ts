import { expect, test } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Sql } from "../../../packages/database/node_modules/postgres";
import {
  FACTORY_ERP_HEADERS, ApplyFactoryErpImportSchema, FactoryErpImportViewSchema,
  FactoryErpApplyResultSchema, FactoryErpSourceLifecycleSchema,
} from "@yummyai/contracts/order/factory-erp-import";
import type { ProductionDeliveryPackageView, ProductionDeliveryWorkspace } from "@yummyai/contracts/order/production-delivery";
import { requireDisposableIntegrationEnvironment } from "../../../tools/testing/require-disposable-integration.mjs";
import { centerApi } from "./order-centers-fixture";
import { prepareDeliveryOrder } from "./production-delivery-fixture";
import { startProductionEditorWorker, stopProductionEditorWorker } from "./production-editor-fixture";
import { loginErp } from "./erp-identity-fixture";

const workspace = fileURLToPath(new URL("../../../", import.meta.url));
const ownedRoot = resolve(workspace, "tmp/factory-erp-lifecycle-20261021-a9f6d812/frontend-browser-draft");
const dbRequire = createRequire(new URL("../../../packages/database/package.json", import.meta.url));
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const scheduler = "factoryErpSourceRetentionScheduler";
type LifecycleEvent = { type: "worker.lifecycle"; state: string; queues: string[]; schedulers: string[]; clean?: boolean };
type MaintenanceEvent = { type: "worker.maintenance"; scheduler: string; state: string; tenants: number; redacted: number;
  failures: number; claimed: number; purged: number; deletedVersions: number; leaseLost: number };
type SafeEvent = LifecycleEvent | MaintenanceEvent;
type Exit = { code: number | null; signal: NodeJS.Signals | null };
type Stopped = Exit & { clean: boolean; forced: boolean };

function isolation() {
  const url = new URL(requireDisposableIntegrationEnvironment());
  const nonce = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(url.pathname)?.[1];
  if (!nonce || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    process.env.E2E_FACTORY_ERP_SOURCE_RETENTION_ISOLATED !== "1" || process.env.E2E_FACTORY_ERP_IMPORT_ISOLATED !== "1" ||
    process.env.E2E_LEGACY_SCHEMA_TARGET !== "current" || process.env.E2E_COMPILED_WEB !== "1" ||
    process.env.S3_PRIVATE_BUCKET !== `order-daily-e2e-${nonce}`)
    throw new Error("Exact current-schema compiled disposable factory source environment required before connection");
  return { url, nonce, databaseName: `order_daily_e2e_${nonce}` };
}

// Only fixed counters and lifecycle labels are retained, never raw child output.
function safeEvent(value: unknown): SafeEvent | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  const names = (v: unknown): v is string[] => Array.isArray(v) && v.length <= 50 &&
    v.every(name => typeof name === "string" && /^[A-Za-z0-9:_-]{1,100}$/.test(name));
  if (item.type === "worker.lifecycle" && typeof item.state === "string" &&
    ["starting", "ready", "stopping", "stopped", "error"].includes(item.state) && names(item.queues) && names(item.schedulers))
    return { type: "worker.lifecycle", state: item.state, queues: [...item.queues], schedulers: [...item.schedulers],
      ...(typeof item.clean === "boolean" ? { clean: item.clean } : {}) };
  const counts = ["tenants", "redacted", "failures", "claimed", "purged", "deletedVersions", "leaseLost"] as const;
  if (item.type !== "worker.maintenance" || item.scheduler !== scheduler || typeof item.state !== "string" ||
    !["completed", "deferred", "failed"].includes(item.state) ||
    counts.some(key => typeof item[key] !== "number" || !Number.isSafeInteger(item[key]) || (item[key] as number) < 0)) return null;
  return { type: "worker.maintenance", scheduler, state: item.state,
    tenants: item.tenants as number, redacted: item.redacted as number, failures: item.failures as number,
    claimed: item.claimed as number, purged: item.purged as number, deletedVersions: item.deletedVersions as number, leaseLost: item.leaseLost as number };
}

async function deadline<T>(promise: Promise<T>, milliseconds: number, message: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); })]); }
  finally { clearTimeout(timer); }
}

function startRetentionRuntime() {
  isolation();
  const child = spawn(process.execPath, ["--import", "./node_modules/tsx/dist/loader.mjs",
    resolve(workspace, "tools/scripts/factory-erp-source-retention-runtime.mjs")], {
    cwd: resolve(workspace, "apps/api"), env: { ...process.env, TSX_DISABLE_CACHE: "1" },
    stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true,
  });
  child.stdout?.resume(); child.stderr?.resume();
  const events: SafeEvent[] = [];
  type Waiter = { predicate(value: SafeEvent): boolean; resolve(value: SafeEvent): void; reject(error: Error): void };
  const waiting = new Set<Waiter>();
  let ended = false;
  const closed = new Promise<Exit>(done => {
    child.once("error", () => undefined);
    child.once("close", (code, signal) => {
      ended = true; done({ code, signal });
      for (const waiter of waiting) waiter.reject(new Error("Owned retention runtime exited before its required IPC receipt"));
      waiting.clear();
    });
  });
  child.on("message", message => {
    const value = safeEvent(message); if (!value) return;
    if (events.length < 100) events.push(value);
    for (const waiter of waiting) if (waiter.predicate(value)) waiter.resolve(value);
  });
  const wait = (predicate: (value: SafeEvent) => boolean, milliseconds = 30_000) => {
    const found = events.find(predicate); if (found) return Promise.resolve(found);
    if (ended) return Promise.reject(new Error("Owned retention runtime already exited"));
    return new Promise<SafeEvent>((done, fail) => {
      const finish = (error?: Error, value?: SafeEvent) => {
        clearTimeout(timer); waiting.delete(waiter);
        if (error) fail(error); else if (value) done(value);
      };
      const waiter: Waiter = { predicate, resolve: value => finish(undefined, value), reject: error => finish(error) };
      const timer = setTimeout(() => finish(new Error("Required retention runtime IPC receipt did not arrive")), milliseconds);
      waiting.add(waiter);
    });
  };
  const stop = async (): Promise<Stopped> => {
    let forced = false;
    if (!ended) {
      try {
        if (!child.connected) throw new Error("Owned worker IPC disconnected");
        await deadline(new Promise<void>((done, fail) => child.send({ type: "worker.shutdown" }, error => error ? fail(new Error("Owned worker shutdown IPC failed")) : done())),
          5_000, "Owned worker shutdown IPC timed out");
        await wait(value => value.type === "worker.lifecycle" && value.state === "stopped", 35_000);
      } catch { forced = true; child.kill("SIGKILL"); }
    }
    const exit = await deadline(closed, 10_000, "Owned retention runtime did not terminate");
    const stopped = events.find(value => value.type === "worker.lifecycle" && value.state === "stopped");
    return { ...exit, clean: !forced && exit.code === 0 && stopped?.type === "worker.lifecycle" && stopped.clean === true, forced };
  };
  return { child, events, wait, stop };
}

let database: Sql | undefined, renderer: ChildProcess | undefined, retention: ReturnType<typeof startRetentionRuntime> | undefined;
let originalClock: string | undefined, clockChanged = false, outputDirectory: string | undefined, databaseName = "";
const proof: { nonce?: string; originalDdlSha256?: string; restoredDdlSha256?: string; restored?: boolean;
  workerEvents?: SafeEvent[]; workerStopped?: Stopped; rendererStopped?: boolean; cleanupErrors?: string[]; cleanupAttempts?: string[][] } = {};
function connection() { if (!database) throw new Error("Owned disposable database connection missing"); return database; }
async function checkDatabase() {
  const [actual] = await connection()<{ name: string }[]>`select current_database() as name`;
  if (actual?.name !== databaseName) throw new Error("Exact nonce database identity changed; refusing source-clock DDL");
}
async function restoreClock() {
  if (!originalClock || !database) return;
  await checkDatabase();
  if (clockChanged) await database.unsafe(originalClock);
  const [current] = await database<{ definition: string }[]>`select pg_get_functiondef('public.factory_erp_source_now()'::regprocedure) as definition`;
  proof.restoredDdlSha256 = sha(current?.definition ?? "");
  proof.restored = proof.restoredDdlSha256 === proof.originalDdlSha256;
  if (!proof.restored) throw new Error("Original source-clock DDL restoration hash differs");
  clockChanged = false;
}
async function cleanup() {
  const errors: string[] = [];
  if (!database && originalClock && clockChanged) {
    try {
      const isolated = isolation();
      if (isolated.databaseName !== databaseName) throw new Error("Original disposable clock scope changed");
      database = (dbRequire("postgres") as (url: string, options: { max: number }) => Sql)(isolated.url.toString(), { max: 1 });
    } catch { errors.push("source_clock_restore_reconnection_refused"); }
  }
  let runtimeEnded = !retention;
  if (retention) {
    try {
      proof.workerStopped = await retention.stop(); runtimeEnded = true; proof.workerEvents = [...retention.events]; retention = undefined;
      if (!proof.workerStopped.clean) errors.push("retention_runtime_not_clean");
    } catch { errors.push("retention_runtime_not_terminated"); }
  }
  try { await stopProductionEditorWorker(renderer); renderer = undefined; proof.rendererStopped = true; }
  catch { errors.push("production_renderer_not_terminated"); }
  if (runtimeEnded) { try { await restoreClock(); } catch { errors.push("source_clock_not_restored"); } }
  else errors.push("source_clock_restore_blocked_by_owned_runtime");
  if (database) { try { await database.end({ timeout: 5 }); database = undefined; } catch { errors.push("owned_database_connection_not_closed"); } }
  proof.cleanupErrors = errors;
  (proof.cleanupAttempts ??= []).push([...errors]);
  if (outputDirectory) await writeFile(resolve(outputDirectory, "clock-and-worker-cleanup.json"), JSON.stringify(proof, null, 2) + "\n");
  if (errors.length) throw new Error("Factory source acceptance cleanup incomplete: " + errors.join(","));
}
test.afterAll(cleanup);

test("factory source private rows expire naturally and a real zero-queue runtime permanently purges them while immutable personal receipts remain readable", async ({ page }) => {
  test.setTimeout(240_000);
  const isolated = isolation(); databaseName = isolated.databaseName; proof.nonce = isolated.nonce;
  await mkdir(ownedRoot, { recursive: true });
  outputDirectory = resolve(ownedRoot, isolated.nonce); await mkdir(outputDirectory);
  database = (dbRequire("postgres") as (url: string, options: { max: number }) => Sql)(isolated.url.toString(), { max: 1 });
  const errors: string[] = []; page.on("pageerror", () => errors.push("pageerror"));
  page.on("console", message => { if (message.type() === "error") errors.push("consoleerror"); });
  const pageWrites: string[] = [], sourceGets: string[] = [];
  page.on("request", request => {
    const path = new URL(request.url()).pathname;
    if (!path.startsWith("/api/factory-erp-import/")) return;
    if (request.method() === "GET") sourceGets.push(path);
    else pageWrites.push(request.method() + " " + path);
  });
  try {
    await checkDatabase();
    const [clock] = await connection()<{ definition: string }[]>`select pg_get_functiondef('public.factory_erp_source_now()'::regprocedure) as definition`;
    if (!clock || !/AS \$function\$\s*SELECT\s+clock_timestamp\(\)\s*;?\s*\$function\$/i.test(clock.definition))
      throw new Error("Fresh original source-clock DDL required");
    originalClock = clock.definition; proof.originalDdlSha256 = sha(originalClock);

    renderer = await startProductionEditorWorker();
    const order = await prepareDeliveryOrder(2);
    const delivery = await centerApi<ProductionDeliveryWorkspace>(`order-centers/deliveries?factory=${order.factoryId}`);
    const selected = delivery.candidates.filter(item => order.lines.includes(item.orderLineId));
    expect(selected).toHaveLength(2);
    const packet = await centerApi<ProductionDeliveryPackageView>("order-centers/deliveries", {
      factoryId: order.factoryId, supplierId: order.supplierId, idempotencyKey: randomUUID(),
      items: selected.map(item => ({ productionOrderId: item.productionOrderId, productionVersionId: item.productionVersionId, expectedProjectionVersion: item.projectionVersion })),
    });
    expect(packet.items).toHaveLength(2);
    for (const item of packet.items) {
      expect(item.snapshot?.file.path).toMatch(/\.jpe?g$/i);
      expect(item.snapshot?.file).toMatchObject({ mediaType: "image/jpeg", dpi: 150 });
      await centerApi(`order-centers/deliveries/${packet.id}/items/${item.id}/feedback`, {
        kind: "submitted", expectedSequence: 0, fileChecksum: item.snapshot!.file.checksum, manufacturingChecksum: item.snapshot!.manufacturing!.plan.checksum,
        idempotencyKey: randomUUID(), reference: "SYNTHETIC_RETENTION_ORIGINAL_SUBMISSION", note: "Synthetic operator checked actual original JPG submission",
        occurredAt: new Date().toISOString(), verifiedByOperator: true,
      });
    }
    await stopProductionEditorWorker(renderer); renderer = undefined; proof.rendererStopped = true;
    const externalHead = "SYNTHETIC-SOURCE-HEAD-" + randomUUID(), tracking = "SYNTHETIC-SOURCE-TRACK-" + randomUUID();
    const rawMarker = "Synthetic private raw cell " + randomUUID();
    const rawRow = [externalHead, "Synthetic original factory export", order.externalId, tracking, "", rawMarker,
      "2", "4", "Synthetic source carrier", "Synthetic source service", "已出库", "2026-10-21 08:09:10", "2026-10-21 09:10:11"];
    const bytes = Buffer.from([FACTORY_ERP_HEADERS, rawRow].map(row => row.map(value => `"${value.replaceAll('"', '""')}"`).join(",")).join("\r\n"));
    const fileName = `synthetic-private-retention-${isolated.nonce}.csv`;
    const source = FactoryErpImportViewSchema.parse(await centerApi("factory-erp-imports", {
      factoryId: order.factoryId, fileName, contentBase64: bytes.toString("base64"), checksumSha256: sha(bytes),
      options: { csvEncoding: "utf-8", delimiter: "," }, idempotencyKey: randomUUID(),
    }));
    const originalInput = ApplyFactoryErpImportSchema.parse({ fileChecksum: source.fileChecksum, previewChecksum: source.previewChecksum,
      idempotencyKey: randomUUID(), confirmed: true, rows: [{ rowNumber: 2, wholeGroupConfirmed: true,
        items: packet.items.map(item => ({ deliveryItemId: item.id, productionOrderId: item.productionOrderId, productionVersionId: item.snapshot!.productionVersionId,
          fileChecksum: item.snapshot!.file.checksum, manufacturingChecksum: item.snapshot!.manufacturing!.plan.checksum })) }] });
    const application = FactoryErpApplyResultSchema.parse(await centerApi(`factory-erp-imports/${source.id}/apply`, originalInput));
    expect(application.observations.map(item => item.status)).toEqual(["shipped"]);

    await page.setViewportSize({ width: 1440, height: 1000 });
    await loginErp(page, "operator", `/production?q=${order.externalId}&line=${order.lines[0]}`);
    await page.locator("summary").filter({ hasText: /^工厂交付与回执/ }).click();
    const area = page.getByRole("region", { name: "工厂 Excel／CSV 状态同步", exact: true });
    await area.getByRole("combobox", { name: "导入工厂", exact: true }).selectOption(order.factoryId);
    const sourceIndexes = page.getByText("核对工厂表格原来源", { exact: true }); await expect(sourceIndexes).toHaveCount(2);
    for (const index of await sourceIndexes.all()) {
      await index.click(); await expect(index.locator("..")).not.toContainText(externalHead); await expect(index.locator("..")).not.toContainText(tracking);
    }

    // Change only the nonce-local source clock, preserving all other production clocks.
    await checkDatabase();
    const [offset] = await connection()<{ micros: string }[]>`select floor(extract(epoch from (expires_at-clock_timestamp()-interval '10 seconds'))*1000000)::text as micros from factory_erp_imports where id=${source.id}::uuid`;
    if (!offset || !/^-?\d{1,18}$/.test(offset.micros)) throw new Error("Exact synthetic source-clock offset required");
    const replacement = originalClock.replace(/AS \$function\$[\s\S]*?\$function\$/,
      `AS $function$ SELECT clock_timestamp() + '${offset.micros} microseconds'::interval $function$`);
    if (replacement === originalClock) throw new Error("Source-clock DDL replacement did not change its body");
    clockChanged = true; await connection().unsafe(replacement);
    await area.getByLabel("工厂导入 ID", { exact: true }).fill(source.id);
    await area.getByRole("button", { name: "按导入 ID 读取", exact: true }).click();
    const lifecycle = area.getByRole("region", { name: "工厂来源保留与清理凭据", exact: true });
    const privateSummary = area.getByRole("region", { name: "原工厂文件与覆盖范围", exact: true });
    await expect(lifecycle.locator(".fei-lifecycle-state").filter({ hasText: /^仍在保留期$/ })).toBeVisible();
    await expect(privateSummary).toContainText(fileName);
    await area.getByText("读取第 2 行全部 13 个原始列值", { exact: true }).click();
    await expect(area.getByText(rawMarker, { exact: true })).toBeVisible();
    await expect(area.getByRole("button", { name: `读取原应用回执 ${application.id.slice(-8)}`, exact: true })).toBeVisible();
    const getsBeforeDeadline = sourceGets.length;
    await expect(lifecycle.getByText("已到期 原文已隐藏 清理状态待读取", { exact: true })).toBeVisible({ timeout: 20_000 });
    expect(sourceGets).toHaveLength(getsBeforeDeadline);
    await expect(privateSummary).toHaveCount(0);
    for (const value of [rawMarker, fileName, externalHead, tracking]) await expect(page.getByText(value, { exact: false })).toHaveCount(0);
    await expect(area.getByRole("button", { name: "核对整组绑定 第 2 行", exact: true })).toHaveCount(0);

    retention = startRetentionRuntime();
    const ready = await retention.wait(value => value.type === "worker.lifecycle" && value.state === "ready");
    expect(ready).toMatchObject({ type: "worker.lifecycle", state: "ready", queues: [], schedulers: [scheduler] });
    const maintained = await retention.wait(value => value.type === "worker.maintenance" && value.scheduler === scheduler, 45_000);
    expect(maintained).toMatchObject({ type: "worker.maintenance", scheduler, state: "completed", failures: 0, leaseLost: 0 });
    if (maintained.type !== "worker.maintenance") throw new Error("Actual maintenance IPC receipt required");
    expect(maintained.redacted).toBeGreaterThanOrEqual(1); expect(maintained.purged).toBeGreaterThanOrEqual(1); expect(maintained.deletedVersions).toBeGreaterThanOrEqual(1);
    const [purged] = await connection()<{ private_cleared: boolean; object_deleted: boolean; deleted_versions: number; applications: number }[]>`
      select i.encrypted_payload is null and i.private_redacted_at is not null as private_cleared,
        p.purged_at is not null as object_deleted,p.deleted_versions,
        (select count(*)::integer from factory_erp_applications a where a.import_id=i.id) as applications
      from factory_erp_imports i join factory_erp_source_purges p on p.import_id=i.id where i.id=${source.id}::uuid`;
    expect(purged).toMatchObject({ private_cleared: true, object_deleted: true, applications: 1 }); expect(purged.deleted_versions).toBeGreaterThanOrEqual(1);
    await area.getByRole("button", { name: "重新读取清理状态", exact: true }).click();
    await expect(lifecycle.getByText("已清理 原 ID 校验值与审计仍保留", { exact: true })).toBeVisible();
    await expect(lifecycle.getByText("下一次重试时间", { exact: true })).toHaveCount(0);
    await expect(lifecycle.getByText(source.id, { exact: true })).toBeVisible(); await expect(lifecycle.getByText(source.fileChecksum, { exact: true })).toBeVisible();
    await area.getByLabel("原应用 ID", { exact: true }).fill(application.id);
    await area.getByRole("button", { name: "读取原应用回执", exact: true }).click();
    const receipt = area.getByRole("region", { name: "工厂原应用历史回执", exact: true });
    await expect(receipt.getByText(application.id, { exact: true })).toBeVisible();
    await expect(receipt.getByText(application.requestChecksum, { exact: true })).toBeVisible();

    proof.workerStopped = await retention.stop(); proof.workerEvents = [...retention.events]; retention = undefined;
    expect(proof.workerStopped).toMatchObject({ clean: true, forced: false, code: 0, signal: null });
    await restoreClock();
    const afterCorrection = FactoryErpSourceLifecycleSchema.parse(await centerApi(`factory-erp-imports/${source.id}/lifecycle`));
    expect(Date.parse(afterCorrection.expiresAt)).toBeGreaterThan(Date.parse(afterCorrection.checkedAt));
    expect(afterCorrection).toMatchObject({ access: "expired", purgeStatus: "purged" }); expect(afterCorrection.privateRedactedAt).not.toBeNull();
    await area.getByRole("button", { name: "重新读取清理状态", exact: true }).click();
    await expect(lifecycle.getByText("已清理 原 ID 校验值与审计仍保留", { exact: true })).toBeVisible();
    for (const value of [rawMarker, fileName, externalHead, tracking]) await expect(page.getByText(value, { exact: false })).toHaveCount(0);
    const saved = await centerApi<ProductionDeliveryPackageView>(`order-centers/deliveries/${packet.id}`);
    expect(saved.items.map(item => item.factoryErp?.status)).toEqual(["shipped", "shipped"]);
    for (const item of saved.items) {
      expect(item.feedback.map(feedback => feedback.kind)).toEqual(["submitted"]);
      expect(item.factoryErp).toMatchObject({ shippedQuantity: null, privateSourceExpired: true, externalId: "", trackingReference: "" });
      const production = await centerApi<{ productionOrder: { status: string }; milestones: { type: string }[]; inspections: unknown[] }>(`production/orders/${item.productionOrderId}`);
      expect(production.productionOrder.status).toBe("submitted"); expect(production.milestones.map(milestone => milestone.type)).toEqual(["submitted"]); expect(production.inspections).toEqual([]);
    }
    // Only page requests are observed here; real setup API mutations occurred above.
    expect(pageWrites).toEqual([]); expect(errors).toEqual([]);
    await lifecycle.scrollIntoViewIfNeeded(); await page.screenshot({ path: resolve(outputDirectory, "factory-erp-source-retention-desktop.png"), fullPage: false });
    await page.setViewportSize({ width: 390, height: 844 }); await receipt.scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: resolve(outputDirectory, "factory-erp-source-retention-mobile.png"), fullPage: false });
  } finally { await cleanup(); }
});
