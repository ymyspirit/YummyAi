import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, test, type Locator, type Page, type Request, type Response as PlaywrightResponse, type Route } from "@playwright/test";
import { z } from "zod";
import { TenantContextSchema, type TenantContext } from "@yummyai/contracts";
import { ErpSessionViewSchema, erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { CreativeOwnerResponseAdoptionCommandSchema, CreativeOwnerResponseAdoptionRequestSchema,
  CreativeOwnerResponseAdoptionWorkspaceSchema } from "@yummyai/contracts/harness/creative-owner-response-adoption";
import { CREATIVE_RESPONSE_ADOPTION_ARTIFACT_HEADER, CREATIVE_RESPONSE_ADOPTION_BASIS_HEADER,
  CREATIVE_RESPONSE_ADOPTION_CHECKSUM_HEADER } from "@yummyai/contracts/harness/creative-response-adoption";
import { CREATIVE_OWNER_RESPONSE_ADOPTION_INTENT_PREFIX } from "../src/features/execution/creative-owner-response-adoption-intent";
import { requireCreativeOwnerResponseAdoptionEnvironment } from "../../../tools/testing/creative-owner-response-adoption-environment.mjs";
import type { CreativeOwnerResponseAdoptionBrowserRequest } from "../../../tools/testing/creative-owner-response-adoption-browser.mjs";
import { STUDIO_DOCUMENT_TRANSFER_BROWSER_LOCK_SHA256 } from "../../../tools/testing/require-studio-document-transfer-browser-lock.mjs";
import { P2_CI_BROWSER_REGISTRY_SHA256, requireP2BrowserLock } from "../../../tools/testing/require-p2-browser-lock.mjs";
import { actors, loginErp } from "./erp-identity-fixture.js";
import { deferred, originalScreenshot, originalSha } from "./studio-original-helpers.js";

const Id = z.uuidv7(), Hash = z.string().regex(/^[a-f0-9]{64}$/), Count = z.number().int().nonnegative();
const Seed = z.object({ nonce: z.string().regex(/^[a-f0-9]{32}$/), executionId: Id, ownerId: Id, batchId: Id,
  parentExecutionId: z.null(), stepKey: z.string(), inputFingerprint: Hash, basis: Hash, identityStamp: Hash,
  originalPhase: z.enum(["failed", "uncertain"]), responseChecksum: Hash, artifactChecksum: Hash,
  imageBytes: Count.positive(), width: Count.positive(), height: Count.positive(), authorityHash: Hash }).strict();
const Table = z.object({ count: Count, hash: Hash }).strict();
const Facts = z.object({ role: z.literal("yummyai_app"), original: z.object({ executionId: Id, parentExecutionId: z.null(),
  phase: z.string(), inputFingerprint: Hash, responseChecksum: Hash.nullable(), encryptedChecksum: Hash.nullable(),
  executionsSha256: Hash, ledgerSha256: Hash, ledgerCount: Count,
  calls: z.object({ candidateDispatches: Count, adaptationDispatches: Count, compileDispatches: Count, renderDispatches: Count,
    podGatewayCalls: Count, paidGatewayCalls: z.literal(0), paidQueue: z.array(z.unknown()).length(0) }).strict() }).strict(),
  archive: z.object({ encryptedSha256: Hash, objectKeySha256: Hash }).strict(),
  batch: z.object({ id: Id, status: z.string(), archived: z.boolean() }).strict(),
  versions: z.array(z.object({ id: Id, status: z.string(), reviewedAt: z.string().nullable(), reviewedBy: Id.nullable() }).strict()),
  links: z.array(z.object({ id: Id, role: z.string(), assetId: Id }).strict()),
  requests: z.array(CreativeOwnerResponseAdoptionRequestSchema),
  assets: z.array(z.object({ id: Id, checksumSha256: Hash.nullable(), actualSha256: Hash, byteSize: Count.positive(),
    actualByteSize: Count.positive(), mediaType: z.string(), rightsStatus: z.string(), version: Count.positive() }).strict()),
  tables: z.record(z.string(), Table), liveAuthorityHash: Hash, providerCalls: z.literal(0), ordinaryWorkerProcesses: z.literal(0),
  modelSecretReads: z.literal(0) }).strict();
const Cleanup = z.object({ role: z.literal("yummyai_app"), batchId: Id, status: z.literal("cancelled"), archived: z.literal(true),
  originalExecutionExact: z.literal(true), originalBudgetExact: z.literal(true), originalDispatchAndGatewayCallsExact: z.literal(true),
  originalSessionAuthorityRestored: z.literal(true), remainingPreparedOrProcessing: z.literal(0), retainedAdoptionHistory: Count,
  registeredUnreviewedAssets: Count, retainedUntilOuterNonceDeletion: z.literal(true) }).strict();
type Basis = z.infer<typeof Seed>;
type Fact = z.infer<typeof Facts>;
const ownerPattern = /^\/api\/creative-executions\/[0-9a-f-]+\/owner-response-adoption(?:s(?:\/by-request\/[0-9a-f-]+|\/[0-9a-f-]+\/cancel)?|\/preview)?$/;

function childFor(nonce: string) {
  const child = spawn(process.execPath, ["--import", new URL("../../api/node_modules/tsx/dist/loader.mjs", import.meta.url).href,
    fileURLToPath(new URL("../../../tools/testing/creative-owner-response-adoption-browser.mts", import.meta.url)), "--creative-owner-response-adoption-browser-child"], {
    cwd: fileURLToPath(new URL("../../../", import.meta.url)), env: { ...process.env, NODE_OPTIONS: "", TSX_DISABLE_CACHE: "1",
      TSX_TSCONFIG_PATH: fileURLToPath(new URL("../../api/tsconfig.json", import.meta.url)) },
    stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true,
  });
  const waiting = new Map<number, ReturnType<typeof deferred<unknown>>>(), exit = deferred<{ code: number | null; signal: string | null }>();
  let next = 0, exited = false;
  child.on("message", (raw: unknown) => {
    const packet = z.union([z.object({ id: z.number().int().positive(), ok: z.literal(true), result: z.unknown() }).strict(),
      z.object({ id: Count, ok: z.literal(false), errorCode: z.string().regex(/^creative_owner_adoption_(?:browser|fixture)_[a-z_]+$/) }).strict()]).safeParse(raw);
    if (!packet.success) { for (const value of waiting.values()) value.reject(new Error("creative_owner_adoption_child_packet_invalid")); waiting.clear(); return; }
    const pending = waiting.get(packet.data.id); if (!pending) return; waiting.delete(packet.data.id);
    if (packet.data.ok) pending.resolve(packet.data.result); else pending.reject(new Error(packet.data.errorCode));
  });
  child.once("error", () => { for (const value of waiting.values()) value.reject(new Error("creative_owner_adoption_child_start_failed")); waiting.clear(); });
  child.once("exit", (code, signal) => { exited = true; exit.resolve({ code, signal });
    for (const value of waiting.values()) value.reject(new Error("creative_owner_adoption_child_exited")); waiting.clear(); });
  async function rpc(operation: "seed" | "facts" | "close", context?: TenantContext) {
    if (!child.connected || exited) throw new Error("creative_owner_adoption_child_closed");
    const id = ++next, pending = deferred<unknown>(); waiting.set(id, pending);
    const packet: CreativeOwnerResponseAdoptionBrowserRequest = operation === "seed"
      ? { id, nonce, operation, context: TenantContextSchema.parse(context) } : { id, nonce, operation };
    child.send(packet, error => { if (error) { waiting.delete(id); pending.reject(new Error("creative_owner_adoption_child_send_failed")); } });
    const timer = setTimeout(() => { waiting.delete(id); pending.reject(new Error("creative_owner_adoption_child_timeout")); }, 90_000);
    try { return await pending.promise; } finally { clearTimeout(timer); }
  }
  return { rpc, async close() {
    let acknowledged = false, cleanup: z.infer<typeof Cleanup> | undefined;
    try { const reply = z.object({ closed: z.literal(true), cleanup: Cleanup }).strict().parse(await rpc("close")); acknowledged = true; cleanup = reply.cleanup; } catch { /* Report cleanup failure with the original test error. */ }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const terminal = await Promise.race([exit.promise, new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 10_000); })]);
    if (timer) clearTimeout(timer); if (!terminal) { child.kill("SIGKILL"); await exit.promise; }
    return { nonce, pid: child.pid ?? null, acknowledged, cleanup, exited, forced: !terminal, code: terminal?.code ?? null,
      failed: !acknowledged || !terminal || terminal.code !== 0 };
  } };
}
type Child = ReturnType<typeof childFor>;
const facts = async (child: Child) => Facts.parse(await child.rpc("facts"));
const panelFor = (page: Page, value: Basis) => page.getByRole("region", { name: "原业务响应安全恢复", exact: true })
  .and(page.locator(`[data-execution-id="${value.executionId}"]`));
function originalsExact(before: Fact, after: Fact) {
  expect(after.original).toEqual(before.original); expect(after.archive).toEqual(before.archive);
  expect(after.liveAuthorityHash).toBe(before.liveAuthorityHash);
  for (const name of ["creative_studio_entries", "creative_studio_revisions", "creative_studio_generations", "creative_executions",
    "ai_budget_ledger", "ai_budget_policies", "model_provider_configs", "model_routes"]) expect(after.tables[name]).toEqual(before.tables[name]);
  expect(after.modelSecretReads).toBe(0); expect(after.providerCalls).toBe(0); expect(after.ordinaryWorkerProcesses).toBe(0);
}
async function openPanel(page: Page, value: Basis) {
  await page.goto(`/creative-designs?batch=${value.batchId}`);
  const history = page.getByRole("region", { name: "创作执行依据与恢复", exact: true });
  await history.getByRole("button", { name: "执行依据与恢复", exact: true }).click();
  const panel = panelFor(page, value); await panel.getByRole("button", { name: "查看原业务归档响应", exact: true }).click();
  await expect(panel).not.toHaveAttribute("data-state", "loading");
  await expect(panel.getByText("原服务报告费用", { exact: true }).first()).toBeVisible(); return panel;
}
async function stable(page: Page, target: Locator) {
  await target.evaluate(element => element.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" }));
  let last = "", stableMeasurements = 0;
  await expect.poll(async () => {
    const bounds = await target.boundingBox(), viewport = page.viewportSize(), signature = JSON.stringify(bounds);
    const inside = !!bounds && !!viewport && bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= viewport.width + 1 && bounds.y + bounds.height <= viewport.height + 1;
    stableMeasurements = inside ? signature === last ? stableMeasurements + 1 : 1 : 0; last = signature; return stableMeasurements;
  }, { intervals: [100, 200, 500] }).toBeGreaterThanOrEqual(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  return { viewport: page.viewportSize(), bounds: await target.boundingBox(), stableMeasurements };
}

test.beforeEach(async ({ browser }, info) => {
  const version = browser.version(), pin = info.config.metadata.browserLock as Record<string, unknown> | undefined;
  let product: string;
  if (process.platform === "win32") {
    expect(version).toBe("157.0.8103.6"); expect(pin?.lockSha256).toBe(STUDIO_DOCUMENT_TRANSFER_BROWSER_LOCK_SHA256);
    expect(pin?.executableSha256).toBe("c86303c78d1333c725f2f57cca3d89a3bbe1d6a0aa4f51c2a3e0ce6c8637322d");
    expect(pin?.payloadReceiptSha256).toBe("5485a838933494f27ca1b542870406e838a93d49ff1f359e42b5cf8017cc14dc"); product = "HeadlessChrome/157.0.8103.6";
  } else {
    expect(process.platform).toBe("linux"); expect(process.env.CI).toBe("true"); expect(pin?.family).toBe("p2_linux_ci_official_headless_shell_v2");
    expect(version).toBe("157.0.8103.6"); expect(pin?.browserVersion).toBe("157.0.8103.6"); expect(pin?.driverVersion).toBe("1.61.1");
    expect(pin?.sourcePackageVersion).toBe("1.65.0-alpha-2026-10-23"); expect(pin?.revision).toBe("1251"); expect(pin?.registrySha256).toBe(P2_CI_BROWSER_REGISTRY_SHA256);
    const actual = requireP2BrowserLock(); expect(actual.metadata).toEqual(pin); expect(actual.executableSha256).toBe(pin?.executableSha256);
    product = "HeadlessChrome/157.0.8103.6";
  }
  const cdp = await browser.newBrowserCDPSession();
  try { const value = await cdp.send("Browser.getVersion"); expect(value.product).toBe(product); expect(value.revision).toMatch(/^@[a-f0-9]{40}$/);
    await info.attach("actual-browser.json", { contentType: "application/json", body: JSON.stringify({ version, ...value, ...pin }) }); }
  finally { await cdp.detach(); }
});

test("real adaptation owner preview recovers its original lost ACK by read only key without confusing business and execution parents", async ({ page }, info) => {
  const environment = requireCreativeOwnerResponseAdoptionEnvironment(process.env, true), child = childFor(environment.nonce);
  const proof: Record<string, unknown> = { family: "creative_owner_response_adoption", nonce: environment.nonce,
    realPaidCall: false, ordinaryWorkerStarted: false, retainedHistoryUntilOuterNonceDeletion: true };
  const rows: Array<{ request: Request; path: string; method: string; authoritySha256: string; status?: number; failed?: string }> = [];
  const errors: string[] = [], consoleErrors: Array<{ path: string; sha256: string; expectedDrop: boolean }> = [];
  let primary: unknown, routeHandler: ((route: Route) => Promise<void>) | undefined, routePattern: string | undefined, intercepted = false;
  const drained = deferred<void>();
  page.on("request", request => { const url = new URL(request.url()); if (url.pathname.startsWith("/api/")) rows.push({ request,
    path: url.pathname, method: request.method(), authoritySha256: originalSha(request.headers()["x-yummyai-context-authority"] ?? "") }); });
  page.on("response", response => { const row = rows.find(value => value.request === response.request()); if (row) row.status = response.status(); });
  page.on("requestfailed", request => { const row = rows.find(value => value.request === request); if (row) row.failed = request.failure()?.errorText ?? "unknown"; });
  page.on("pageerror", error => errors.push(originalSha(error.message)));
  page.on("console", message => { if (message.type() !== "error") return;
    let path = ""; try { path = new URL(message.location().url).pathname; } catch { /* Non-URL messages are retained as a hash. */ }
    consoleErrors.push({ path, sha256: originalSha(message.text()), expectedDrop: /^Failed to load resource: net::ERR_(?:FAILED|ABORTED)$/.test(message.text()) }); });
  try {
    await loginErp(page, "operator", "/navigation");
    const response = await page.request.get("/api/erp-auth/session"); expect(response.status()).toBe(200);
    const session = ErpSessionViewSchema.parse(await response.json()); expect(session.userId).toBe(actors().operator.userId); expect(session.tenantId).toBe(actors().operator.tenantId);
    const value = Seed.parse(await child.rpc("seed", TenantContextSchema.parse(session)));
    expect(value.nonce).toBe(environment.nonce); expect(value.authorityHash).toBe(originalSha(erpSessionAuthority(session)));
    const before = await facts(child), writeStart = rows.length, workspaceReads: z.infer<typeof CreativeOwnerResponseAdoptionWorkspaceSchema>[] = [];
    const workspacePath = `/api/creative-executions/${value.executionId}/owner-response-adoption`;
    const workspaceTransport: Array<{ phase: string; status: number; authoritySha256: string; bodySha256: string; bytes: number; finished: true }> = [];
    const readWorkspace = async (answer: PlaywrightResponse, phase: string) => {
      expect(answer.request().method()).toBe("GET"); expect(new URL(answer.url()).pathname).toBe(workspacePath);
      expect(answer.status()).toBe(200); expect(await answer.finished()).toBeNull();
      expect(originalSha(answer.headers()["x-yummyai-context-authority"] ?? "")).toBe(value.authorityHash);
      expect(answer.headers()["content-type"]?.split(";")[0]?.trim()).toBe("application/json");
      const bytes = await answer.body(), workspace = CreativeOwnerResponseAdoptionWorkspaceSchema.parse(JSON.parse(bytes.toString("utf8")));
      expect(workspace).toMatchObject({ ownerId: value.ownerId, parentId: value.batchId, parentExecutionId: null,
        kind: "creative_adaptation", stepKey: value.stepKey, source: { inputFingerprint: value.inputFingerprint } });
      workspaceReads.push(workspace); workspaceTransport.push({ phase, status: answer.status(), authoritySha256: value.authorityHash,
        bodySha256: originalSha(bytes), bytes: bytes.byteLength, finished: true });
    };
    const originalWorkspace = page.waitForResponse(answer => new URL(answer.url()).pathname === workspacePath);
    void originalWorkspace.catch(() => {}); // Still awaited below; an earlier primary failure must not leak a teardown rejection.
    const panel = await openPanel(page, value);
    await readWorkspace(await originalWorkspace, "initial-before-preview-or-interception");
    expect(workspaceReads[0]).toMatchObject({ ownerId: value.ownerId, parentId: value.batchId, parentExecutionId: null,
      kind: "creative_adaptation", stepKey: value.stepKey, source: { inputFingerprint: value.inputFingerprint } });
    const previewResponse = page.waitForResponse(answer => new URL(answer.url()).pathname === workspacePath + "/preview");
    await panel.getByRole("button", { name: "读取原图预览", exact: true }).click();
    const preview = await previewResponse; expect(preview.status()).toBe(200);
    expect(preview.headers()[CREATIVE_RESPONSE_ADOPTION_BASIS_HEADER]).toBe(value.basis);
    expect(preview.headers()[CREATIVE_RESPONSE_ADOPTION_CHECKSUM_HEADER]).toBe(value.responseChecksum);
    expect(preview.headers()[CREATIVE_RESPONSE_ADOPTION_ARTIFACT_HEADER]).toBe(value.artifactChecksum);
    const image = panel.getByRole("img", { name: "原业务响应图片预览", exact: true });
    await expect(image).toBeVisible();
    await expect.poll(() => image.evaluate((node: HTMLImageElement) => ({ complete: node.complete, width: node.naturalWidth, height: node.naturalHeight })))
      .toEqual({ complete: true, width: value.width, height: value.height });
    const confirmation = panel.getByRole("checkbox", { name: "我已查看这份原图预览 仅恢复原任务的未审核产物 其他文件及权利仍需核对 未送审 未批准生产", exact: true });
    await expect(confirmation).toBeEnabled(); expect(await facts(child)).toEqual(before);
    expect(rows.slice(writeStart).filter(row => !["GET", "HEAD"].includes(row.method))).toEqual([]);
    proof.previewBounds1440 = await stable(page, image); proof.previewImage = await originalScreenshot(page, info, "owner-original-preview-1440");
    await confirmation.check();
    const path = `/api/creative-executions/${value.executionId}/owner-response-adoptions`;
    const dropped = deferred<{ request: Request; command: z.infer<typeof CreativeOwnerResponseAdoptionCommandSchema>; committed: z.infer<typeof CreativeOwnerResponseAdoptionRequestSchema> }>();
    routeHandler = async route => {
      const request = route.request(); if (intercepted || request.method() !== "POST" || new URL(request.url()).pathname !== path) { await route.fallback(); return; }
      intercepted = true;
      try {
        const command = CreativeOwnerResponseAdoptionCommandSchema.parse(request.postDataJSON()); expect(command.expectedBasis).toBe(value.basis);
        expect(originalSha(request.headers()["x-yummyai-context-authority"] ?? "")).toBe(value.authorityHash); expect(request.frame()).toBe(page.mainFrame());
        const upstream = await route.fetch();
        try {
          expect(upstream.status()).toBe(200); const committed = CreativeOwnerResponseAdoptionRequestSchema.parse(await upstream.json());
          expect(committed).toMatchObject({ executionId: value.executionId, requestId: command.requestId, command, status: "committed", attempts: 1 });
          const actual = await facts(child); originalsExact(before, actual); expect(actual.requests).toEqual([committed]);
          await route.abort("failed"); dropped.resolve({ request, command, committed });
        } finally { await upstream.dispose(); }
      } catch (cause) { try { await route.abort("failed"); } catch { /* Keep the upstream failure. */ }
        dropped.reject(cause instanceof Error ? cause : new Error("creative_owner_adoption_drop_failed")); }
      finally { drained.resolve(); }
    };
    routePattern = "**" + path; await page.route(routePattern, routeHandler);
    await panel.getByRole("button", { name: "恢复原业务归档响应", exact: true }).click();
    const original = await dropped.promise; await drained.promise; await page.unroute(routePattern, routeHandler); routeHandler = undefined;
    await expect(panel).toHaveAttribute("data-state", "unknown");
    await expect.poll(() => rows.find(row => row.request === original.request)?.failed).toBe("net::ERR_FAILED");
    expect(rows.find(row => row.request === original.request)?.status).toBeUndefined();
    const committedFacts = await facts(child), readOnlyStart = rows.length;
    const marker = await page.evaluate(({ prefix, executionId, identityStamp }) => {
      const key = prefix + identityStamp + ":" + executionId, raw = sessionStorage.getItem(key);
      if (raw === null) throw new Error("original_owner_request_marker_missing");
      const result: unknown = JSON.parse(raw); sessionStorage.removeItem(key);
      if (sessionStorage.getItem(key) !== null) throw new Error("original_owner_request_marker_not_removed"); return result;
    }, { prefix: CREATIVE_OWNER_RESPONSE_ADOPTION_INTENT_PREFIX, executionId: value.executionId, identityStamp: value.identityStamp });
    expect(marker).toEqual({ executionId: value.executionId, identityStamp: value.identityStamp, command: original.command });
    const recoveredWorkspace = page.waitForResponse(answer => new URL(answer.url()).pathname === workspacePath);
    void recoveredWorkspace.catch(() => {}); // Still awaited below; an earlier primary failure must not leak a teardown rejection.
    await page.reload();
    const history = page.getByRole("region", { name: "创作执行依据与恢复", exact: true });
    await history.getByRole("button", { name: "执行依据与恢复", exact: true }).click();
    await panel.getByRole("button", { name: "查看原业务归档响应", exact: true }).click();
    await expect(panel).toHaveAttribute("data-state", "committed");
    await readWorkspace(await recoveredWorkspace, "reloaded-original-recovery");
    const receipt = panel.getByRole("region", { name: "原业务响应恢复回执", exact: true });
    await expect(receipt.getByText("原产物已登记 · 权利未核对 · 仍需业务审核 · 未送审 · 未批准生产", { exact: true })).toBeVisible();
    await expect(receipt.getByText(original.committed.receipt!.id, { exact: true })).toBeVisible();
    await expect(panel.locator('[aria-label="原采用请求"]').getByText(original.command.requestId, { exact: true })).toBeVisible();
    const final = await facts(child); expect(final).toEqual(committedFacts); originalsExact(before, final);
    expect(final.versions).toEqual([{ id: value.ownerId, status: "pending_review", reviewedAt: null, reviewedBy: null }]);
    expect(final.links.filter(row => row.role === "aspect_variant")).toHaveLength(1);
    const artifact = original.committed.receipt!.artifacts[0]!;
    expect(original.committed.receipt).toMatchObject({ kind: "creative_adaptation", ownerId: value.ownerId, parentId: value.batchId,
      disposition: "aspect_ready", originalPhase: value.originalPhase, rightsStatus: "unverified", approval: "review_required", noNewModelCall: true });
    expect(final.assets).toEqual([{ id: artifact.assetId, checksumSha256: value.artifactChecksum, actualSha256: value.artifactChecksum,
      byteSize: value.imageBytes, actualByteSize: value.imageBytes, mediaType: "image/png", rightsStatus: "unverified", version: 1 }]);
    const recovery = rows.slice(readOnlyStart).filter(row => ownerPattern.test(row.path));
    expect(recovery.every(row => row.method === "GET")).toBe(true);
    expect(recovery.filter(row => row.path === workspacePath)).toHaveLength(1);
    expect(recovery.filter(row => row.path === `${path}/by-request/${original.command.requestId}`)).toHaveLength(1);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 960 });
      proof[`receiptBounds${width}`] = await stable(page, receipt.getByRole("heading").first());
      const fixed = receipt.getByRole("region", { name: "恢复产物固定清单", exact: true }); await expect(fixed.getByRole("article")).toHaveCount(1);
      proof[`receiptImage${width}`] = await originalScreenshot(page, info, `owner-original-receipt-${width}`);
    }
    expect(rows.slice(writeStart).filter(row => !["GET", "HEAD"].includes(row.method))).toEqual([expect.objectContaining({ path, method: "POST" })]);
    expect(rows.filter(row => ownerPattern.test(row.path)).every(row => row.authoritySha256 === value.authorityHash)).toBe(true);
    expect(errors).toEqual([]);
    expect(consoleErrors.filter(row => !(row.path === path && row.expectedDrop))).toEqual([]);
    expect(consoleErrors.filter(row => row.path === path && row.expectedDrop).length).toBeLessThanOrEqual(1);
    proof.originalCommand = original.command; proof.receipt = original.committed.receipt; proof.originalFacts = before.original;
    proof.finalFacts = final; proof.recoveryMutationCount = 0; proof.originalTerminalAndFeeExact = true;
    proof.businessParentId = value.batchId; proof.parentExecutionId = null; proof.lostAckUpstreamStatus = 200;
    proof.workspaceTransport = workspaceTransport;
    await page.goto("/navigation");
  } catch (cause) {
    primary = cause; try { await page.screenshot({ path: info.outputPath("primary-failure.png"), timeout: 5000 }); proof.failureScreenshot = true; } catch { proof.failureScreenshotFailed = true; }
  } finally {
    if (routeHandler && routePattern) try { await page.unroute(routePattern, routeHandler); } catch (cause) { primary ??= cause; }
    if (intercepted) await drained.promise;
    try { const closed = await child.close(); proof.fixture = closed; if (closed.failed) primary ??= new Error("creative_owner_adoption_fixture_cleanup_failed"); }
    catch (cause) { proof.fixtureCleanupFailed = true; primary ??= cause; }
    proof.network = rows.map(({ request: _request, ...row }) => { void _request; return row; }); proof.pageErrors = errors; proof.consoleErrors = consoleErrors;
    try { await mkdir(info.outputDir, { recursive: true }); await writeFile(info.outputPath("creative-owner-response-adoption-proof.json"), JSON.stringify(proof, null, 2) + "\n"); }
    catch (cause) { primary ??= cause; }
  }
  if (primary) throw primary;
});
