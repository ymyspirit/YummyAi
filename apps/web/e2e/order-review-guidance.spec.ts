import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { errors, expect, test, type Locator, type Page, type Request, type TestInfo } from "@playwright/test";
import {
  CheckOrderIntakeInputSchema, OrderIntakeCheckViewSchema, OrderWorkDetailViewSchema, SaveOrderWorkDraftInputSchema,
  type OrderIntakeCheck, type OrderWorkDraft,
} from "@yummyai/contracts/order/workspace";
import { requireDisposableIntegrationEnvironment } from "../../../tools/testing/require-disposable-integration.mjs";
import { loginErp } from "./erp-identity-fixture";
import { orderIntakePillowFixture, type OrderIntakePillowFixture } from "./order-intake-pillow-fixture";

test.describe("order review guidance with native personal pillow intake", () => {
  test.beforeEach(async ({ page }) => {
    requireDisposableIntegrationEnvironment();
    expect(process.env.WEB_AUTH_MODE).toBe("personal");
    await loginErp(page);
    await page.setViewportSize({ width: 1440, height: 1000 });
  });

  test("order review guidance automatically checks the default original and confirms a routine order once", async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    const fixture = await orderIntakePillowFixture(false), audit = watch(page, fixture.lineId);
    let completed = false;
    try {
      const initial = nextCheck(page, fixture, check => check.ready);
      await page.goto(fixture.url);
      const check = await initial;
      const whole = order(page), panel = intake(page), confirm = confirmButton(page);
      await expect(panel).toContainText("可以确认审单");
      await expect(whole.getByText("先由 Agent 出稿", { exact: true })).toBeVisible();
      await expect(whole.getByRole("combobox", { name: "设计执行方式", exact: true })).toHaveCount(0);
      await expect(original(page)).toBeChecked();
      await expect(image(page).getByRole("combobox", { name: "对应图片字段", exact: true }))
        .toHaveValue("buyer_photo");
      expect(check.normalizedDraft.designExecutor).toBe("agent");
      expect(check.normalizedDraft.images).toEqual(fixture.initial.draft.images);
      expect(audit.saves).toEqual([]);
      await expect(confirm).toBeEnabled();
      const response = page.waitForResponse(value => new URL(value.url()).pathname === draftPath(fixture)
        && value.request().method() === "POST");
      await confirm.click();
      const savedResponse = await response;
      expect(savedResponse.ok()).toBe(true);
      const saved = OrderWorkDetailViewSchema.parse(await savedResponse.json());
      expect(saved.line.revision).toBe(fixture.initial.line.revision + 1);
      assertNotDispatched(saved);
      expect(saved.draft).toMatchObject({ designExecutor: "agent",
        specificationVersionId: fixture.specificationVersionId,
        artworkVersionId: fixture.artworkVersionId, printProfileVersionId: fixture.profileVersionId,
        images: fixture.initial.draft.images });
      expect(saved.draft.fields.find(field => field.key === "crop_scope")?.value).toBe("head");
      expect(saved.draft.fields.find(field => field.key === "print_sides")?.value).toBe("double_sided");
      assertSize(saved.draft);
      expect((await fixture.readDetail()).draft).toEqual(saved.draft);
      await fixture.assertOriginalPreserved();
      expect(audit.saves).toHaveLength(1);
      expect(audit.saves[0]!.status).toBe("ready_to_push");
      expect(audit.forbidden).toEqual([]);
      expect(audit.errors).toEqual([]);
      await expect(intake(page)).toContainText("审单已确认");
      await intake(page).scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath("routine-auto-check-one-confirm-desktop.png") });
      completed = true;
    } finally {
      audit.stop();
      await proof(testInfo, fixture, audit, "native_routine_one_confirmation", completed);
    }
  });

  test("order review guidance locates missing originals and preserves special requirements for Agent-first intake", async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    const fixture = await orderIntakePillowFixture(true), audit = watch(page, fixture.lineId);
    let completed = false;
    try {
      await page.setViewportSize({ width: 390, height: 844 });
      const initial = nextCheck(page, fixture, check => check.ready);
      await page.goto(fixture.url);
      const initialCheck = await initial;
      expect(initialCheck.normalizedDraft.designExecutor).toBe("agent");
      const panel = intake(page), confirm = confirmButton(page);
      await expect(order(page).getByText("先由 Agent 出稿", { exact: true })).toBeVisible();
      await expect(panel.getByRole("button", { name: "改由美工制作", exact: true })).toHaveCount(0);
      await expect(confirm).toBeEnabled();
      expect(audit.saves).toEqual([]);

      const missing = nextCheck(page, fixture, check => !check.ready && check.normalizedDraft.images.length === 0);
      await original(page).uncheck();
      await missing;
      await expect(confirm).toBeDisabled();
      await panel.getByRole("button", { name: "补齐顾客原图", exact: true }).first().click();
      await expect(original(page)).toBeInViewport();
      const restored = nextCheck(page, fixture, check => check.ready && check.normalizedDraft.images.length === 1);
      await original(page).check();
      const ready = await restored;
      await expect(confirm).toBeEnabled();
      expect((await fixture.readDetail()).draft).toEqual(fixture.initial.draft);
      expect(audit.saves).toEqual([]);
      await panel.scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath("special-requirements-agent-first-before-save-390.png") });
      expect(ready.normalizedDraft.designExecutor).toBe("agent");
      await expect(order(page).getByRole("combobox", { name: "设计执行方式", exact: true })).toHaveCount(0);
      expect(ready.normalizedDraft.images).toEqual(fixture.initial.draft.images);
      assertSpecial(ready.normalizedDraft);
      assertSize(ready.normalizedDraft);
      expect(ready.normalizedDraft).toMatchObject({
        specificationVersionId: fixture.specificationVersionId,
        printProfileVersionId: fixture.profileVersionId, artworkVersionId: fixture.artworkVersionId,
        instructions: fixture.initial.draft.instructions,
      });
      // Source interpretation does not save the draft or start an Agent task.
      expect(audit.saves).toEqual([]);
      expect((await fixture.readDetail()).draft).toEqual(fixture.initial.draft);
      await expect(confirm).toBeEnabled();
      const response = page.waitForResponse(value => new URL(value.url()).pathname === draftPath(fixture)
        && value.request().method() === "POST");
      await confirm.click();
      const savedResponse = await response;
      expect(savedResponse.ok()).toBe(true);
      const saved = OrderWorkDetailViewSchema.parse(await savedResponse.json());
      expect(saved.line.revision).toBe(fixture.initial.line.revision + 1);
      assertNotDispatched(saved);
      expect(saved.draft.designExecutor).toBe("agent");
      expect(saved.draft.images).toEqual(fixture.initial.draft.images);
      expect(saved.draft.fields).toHaveLength(fixture.initial.draft.fields.length);
      assertSpecial(saved.draft);
      assertSize(saved.draft);
      expect((await fixture.readDetail()).draft).toEqual(saved.draft);
      await fixture.assertOriginalPreserved();
      expect(audit.saves).toHaveLength(1);
      expect(audit.forbidden).toEqual([]);
      expect(audit.errors).toEqual([]);
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await expect(intake(page)).toContainText("审单已确认");
      await panel.scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath("agent-first-preserved-ready-390.png") });
      completed = true;
    } finally {
      audit.stop();
      await proof(testInfo, fixture, audit, "native_agent_first_requirements_preserved", completed);
    }
  });

  test("order review guidance rechecks edits and never enables confirmation from a delayed older ready response", async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    const fixture = await orderIntakePillowFixture(false), audit = watch(page, fixture.lineId);
    const release = latch();
    let first = true, heldRequest: Request | undefined, originalWasReady = false;
    let cancelled = false, delivered = false, completed = false, routeSettled = false;
    const cancelledRequest = (request: Request) => {
      if (request === heldRequest && request.failure()?.errorText === "net::ERR_ABORTED") cancelled = true;
    };
    page.on("requestfailed", cancelledRequest);
    const routePath = `**${intakePath(fixture)}`;
    await page.route(routePath, async route => {
      if (!first || route.request().method() !== "POST") return route.fallback();
      first = false;
      heldRequest = route.request();
      try {
        const input = CheckOrderIntakeInputSchema.parse(heldRequest.postDataJSON());
        expect(input.expectedRevision).toBe(fixture.initial.line.revision);
        expect(input.expectedSourceVersionId).toBe(fixture.sourceVersionId);
        const response = await route.fetch();
        expect(response.ok()).toBe(true);
        const originalCheck = OrderIntakeCheckViewSchema.parse(await response.json());
        expect(originalCheck.ready).toBe(true);
        originalWasReady = true;
        await release.promise;
        try {
          await route.fulfill({ response });
          delivered = true;
        } catch (cause) {
          // Only this exact original request's observed cancellation is allowed.
          if (!cancelled) throw cause;
        }
      } finally {
        routeSettled = true;
      }
    });
    try {
      await page.goto(fixture.url);
      await expect.poll(() => originalWasReady).toBe(true);
      const confirm = confirmButton(page);
      await expect(confirm).toBeDisabled();
      await order(page).locator("summary").filter({ hasText: /^高级修改与原始字段/ }).click();
      const cropSources = fixture.initial.draft.fields.filter(field =>
        field.key === "crop_scope" || field.label === "Pillow Shape");
      expect(cropSources).toHaveLength(1);
      const cropSource = cropSources[0]!;
      const crop = order(page).locator(`.oc-custom-field[data-review-field=${JSON.stringify(cropSource.key)}]`)
        .getByRole("textbox", { name: "定制内容", exact: true });
      await expect(crop).toHaveValue(cropSource.value);
      const blocked = nextCheck(page, fixture, check => !check.ready &&
        check.fields.some(field => field.key === "crop_scope" && field.status === "missing"));
      await crop.fill("");
      await blocked;
      await expect(confirm).toBeDisabled();
      await expect(intake(page)).toContainText("裁切范围");
      release.resolve();
      await expect.poll(() => routeSettled).toBe(true);
      await expect(crop).toHaveValue("");
      await expect(confirm).toBeDisabled();
      await expect(intake(page)).not.toContainText("可以确认审单");
      expect(audit.saves).toEqual([]);
      const corrected = nextCheck(page, fixture, check => check.ready &&
        check.normalizedDraft.fields.some(field => field.key === "crop_scope" && field.value === "head"));
      const supplement = order(page).getByRole("textbox", { name: "补充裁切范围", exact: true });
      await expect(supplement).toBeVisible();
      await supplement.pressSequentially("Only Face", { delay: 30 });
      await expect(supplement).toBeVisible();
      await expect(supplement).toHaveValue("Only Face");
      await expect(supplement).toBeFocused();
      const correctedCheck = await corrected;
      expect(correctedCheck.requirements).toBeDefined();
      expect(correctedCheck.requirements!.sources.find(source => source.sourceFieldKey === "crop_scope"))
        .toMatchObject({ role: "crop", origin: "operator", value: "head" });
      expect(correctedCheck.requirements!.texts.some(text => text.sourceFieldKey === "crop_scope" ||
        ["Only Face", "head"].includes(text.originalText))).toBe(false);
      await expect(supplement).toBeVisible();
      await expect(supplement).toHaveValue("Only Face");
      await expect(supplement).toBeFocused();
      await expect(confirm).toBeEnabled();
      expect((await fixture.readDetail()).draft).toEqual(fixture.initial.draft);
      await fixture.assertOriginalPreserved();
      expect(audit.saves).toEqual([]);
      expect(audit.forbidden).toEqual([]);
      expect(audit.errors).toEqual([]);
      await intake(page).scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath("edited-input-current-check-desktop.png") });
      completed = true;
    } finally {
      release.resolve();
      if (heldRequest) await expect.poll(() => routeSettled).toBe(true);
      await page.unroute(routePath);
      page.off("requestfailed", cancelledRequest);
      audit.stop();
      await proof(testInfo, fixture, audit, "native_delayed_original_result_not_current", completed,
        { originalWasReady, cancelled, delivered });
    }
  });

  test("order review guidance retries one failed check and keeps a successful saved review confirmed without another check", async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    const fixture = await orderIntakePillowFixture(false), audit = watch(page, fixture.lineId);
    const routePath = `**${intakePath(fixture)}`;
    let failedFirst = false, completed = false;
    await page.route(routePath, async route => {
      const request = route.request();
      if (request.method() !== "POST" || failedFirst) return route.fallback();
      const input = CheckOrderIntakeInputSchema.parse(request.postDataJSON());
      expect(input.expectedRevision).toBe(fixture.initial.line.revision);
      expect(input.expectedSourceVersionId).toBe(fixture.sourceVersionId);
      failedFirst = true;
      return route.fulfill({ status: 503, json: { message: "Synthetic initial read-only intake outage" } });
    });
    try {
      await page.goto(fixture.url);
      const panel = intake(page), confirm = confirmButton(page);
      await expect(panel).toContainText("暂时无法完成审单检查");
      await expect(panel.getByRole("alert")).toHaveText("服务器暂时无法完成操作，请保留填写内容后重试。");
      await expect(confirm).toBeDisabled();
      const retry = panel.getByRole("button", { name: "核对当前需求", exact: true });
      await expect(retry).toBeEnabled();
      expect(audit.saves).toEqual([]);
      const checked = nextCheck(page, fixture, check => check.ready);
      await retry.click();
      await checked;
      await expect(panel).toContainText("可以确认审单");
      await expect(original(page)).toBeChecked();
      await expect(confirm).toBeEnabled();
      expect(audit.checks).toHaveLength(2);
      const checksBeforeSave = audit.checks.length;
      const response = page.waitForResponse(value => new URL(value.url()).pathname === draftPath(fixture)
        && value.request().method() === "POST");
      await confirm.click();
      const savedResponse = await response;
      expect(savedResponse.ok()).toBe(true);
      // Count every request as well, so one emitted before this waiter cannot hide.
      const afterSaveWindow = page.waitForRequest(request => request.method() === "POST" &&
        new URL(request.url()).pathname === intakePath(fixture), { timeout: 1250 }).then(
        () => false,
        cause => {
          if (!(cause instanceof errors.TimeoutError)) throw cause;
          return true;
        },
      );
      const saved = OrderWorkDetailViewSchema.parse(await savedResponse.json());
      expect(saved.line.revision).toBe(fixture.initial.line.revision + 1);
      assertNotDispatched(saved);
      expect(saved.draft.designExecutor).toBe("agent");
      expect(saved.draft.images).toEqual(fixture.initial.draft.images);
      assertSize(saved.draft);
      expect((await fixture.readDetail()).draft).toEqual(saved.draft);
      await expect(panel).toContainText("审单已确认");
      expect(await afterSaveWindow).toBe(true);
      expect(audit.checks).toHaveLength(checksBeforeSave);
      await expect(panel).toContainText("审单已确认");
      await expect(panel).toHaveAttribute("aria-busy", "false");
      await fixture.assertOriginalPreserved();
      expect(audit.saves).toHaveLength(1);
      expect(audit.forbidden).toEqual([]);
      expect(audit.errors).toEqual([]);
      await panel.scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath("retry-then-confirmed-without-extra-check.png") });
      completed = true;
    } finally {
      await page.unroute(routePath);
      audit.stop();
      await proof(testInfo, fixture, audit, "native_retry_then_saved_without_background_recheck", completed);
    }
  });

  test("order review guidance explicitly recovers a committed save after a lost acknowledgment using only its original body and key", async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    const fixture = await orderIntakePillowFixture(false), audit = watch(page, fixture.lineId);
    const routePath = `**${draftPath(fixture)}`;
    const bodies: string[] = [], committedReplies: Array<ReturnType<typeof OrderWorkDetailViewSchema.parse>> = [];
    let dropped = false, completed = false;
    await page.route(routePath, async route => {
      const request = route.request();
      if (request.method() !== "POST") return route.fallback();
      const body = request.postData();
      expect(body).not.toBeNull();
      const command = SaveOrderWorkDraftInputSchema.parse(request.postDataJSON());
      expect(command.status).toBe("ready_to_push");
      expect(command.expectedRevision).toBe(fixture.initial.line.revision);
      expect(command.expectedSourceVersionId).toBe(fixture.sourceVersionId);
      bodies.push(body!);
      expect(bodies.length).toBeLessThanOrEqual(2);
      if (bodies.length === 2) {
        expect(bodies[1]).toBe(bodies[0]);
        expect(JSON.parse(bodies[1]!)).toEqual(JSON.parse(bodies[0]!));
        expect(command.idempotencyKey).toBe(JSON.parse(bodies[0]!).idempotencyKey);
      }
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      committedReplies.push(OrderWorkDetailViewSchema.parse(await response.json()));
      if (!dropped) {
        dropped = true;
        return route.abort("failed");
      }
      return route.fulfill({ response });
    });
    try {
      const ready = nextCheck(page, fixture, check => check.ready);
      await page.goto(fixture.url);
      await ready;
      const panel = intake(page), confirm = confirmButton(page);
      await expect(confirm).toBeEnabled();
      await confirm.click();
      const recovery = order(page).getByRole("button", { name: "核对上次保存结果", exact: true });
      await expect(recovery).toBeEnabled();
      await expect(confirm).toBeDisabled();
      await expect(panel).not.toBeVisible();
      expect(dropped).toBe(true);
      expect(bodies).toHaveLength(1);
      expect(committedReplies).toHaveLength(1);
      const serverAfterDrop = await fixture.readDetail();
      expect(serverAfterDrop.line.revision).toBe(fixture.initial.line.revision + 1);
      assertNotDispatched(serverAfterDrop);
      expect(serverAfterDrop.versions).toHaveLength(fixture.initial.versions.length + 1);
      expect(serverAfterDrop.draft).toEqual(committedReplies[0]!.draft);
      for (const version of fixture.initial.versions)
        expect(serverAfterDrop.versions.find(value => value.id === version.id)).toEqual(version);
      const replay = page.waitForResponse(value => new URL(value.url()).pathname === draftPath(fixture)
        && value.request().method() === "POST");
      await recovery.click();
      const replayResponse = await replay;
      expect(replayResponse.ok()).toBe(true);
      const recovered = OrderWorkDetailViewSchema.parse(await replayResponse.json());
      expect(bodies).toHaveLength(2);
      expect(bodies[1]).toBe(bodies[0]);
      expect(recovered.line.revision).toBe(serverAfterDrop.line.revision);
      expect(recovered.draft).toEqual(serverAfterDrop.draft);
      expect(recovered.draft).toMatchObject({ designExecutor: "agent",
        artworkVersionId: fixture.artworkVersionId, specificationVersionId: fixture.specificationVersionId,
        printProfileVersionId: fixture.profileVersionId, images: fixture.initial.draft.images });
      expect(recovered.draft.fields.find(field => field.key === "crop_scope")?.value).toBe("head");
      expect(recovered.draft.fields.find(field => field.key === "print_sides")?.value).toBe("double_sided");
      expect(recovered.draft.fields).toHaveLength(fixture.initial.draft.fields.length);
      assertSize(recovered.draft);
      assertNotDispatched(recovered);
      const readback = await fixture.readDetail();
      expect(readback.draft).toEqual(recovered.draft);
      expect(readback.line.revision).toBe(serverAfterDrop.line.revision);
      expect(readback.versions.map(version => version.id)).toEqual(serverAfterDrop.versions.map(version => version.id));
      await fixture.assertOriginalPreserved();
      await expect(panel).toContainText("审单已确认");
      await expect(recovery).toHaveCount(0);
      expect(audit.saves).toHaveLength(2);
      expect(audit.forbidden).toEqual([]);
      expect(audit.errors).toEqual([]);
      await panel.scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath("lost-save-ack-explicit-original-replay-confirmed.png") });
      completed = true;
    } finally {
      await page.unroute(routePath);
      audit.stop();
      await proof(testInfo, fixture, audit, "native_committed_save_explicit_identical_replay", completed);
    }
  });
});

const order = (page: Page) => page.getByRole("region", { name: "整单详情", exact: true });
const intake = (page: Page) => page.getByRole("region", { name: "定制订单承接核对", exact: true });
const image = (page: Page) => order(page).locator(".oc-image").filter({ has: page.getByRole("checkbox") });
const original = (page: Page) => image(page).getByRole("checkbox");
const confirmButton = (page: Page): Locator => order(page).getByRole("button", { name: "确认本件审单", exact: true });
const intakePath = (fixture: OrderIntakePillowFixture) => `/api/order-centers/lines/${fixture.lineId}/intake-check`;
const draftPath = (fixture: OrderIntakePillowFixture) => `/api/order-centers/lines/${fixture.lineId}/draft`;

async function nextCheck(page: Page, fixture: OrderIntakePillowFixture, predicate: (check: OrderIntakeCheck) => boolean) {
  const response = await page.waitForResponse(async value => {
    if (new URL(value.url()).pathname !== intakePath(fixture) || value.request().method() !== "POST" || !value.ok()) return false;
    const checked = OrderIntakeCheckViewSchema.parse(await value.json());
    return predicate(checked);
  });
  const check = OrderIntakeCheckViewSchema.parse(await response.json());
  expect(check.orderLineId).toBe(fixture.lineId);
  expect(check.revision).toBe(fixture.initial.line.revision);
  expect(check.sourceVersionId).toBe(fixture.sourceVersionId);
  return check;
}

function watch(page: Page, lineId: string) {
  const checks: Array<ReturnType<typeof CheckOrderIntakeInputSchema.parse>> = [];
  const saves: Array<{ status: string; draft: OrderWorkDraft }> = [], forbidden: string[] = [], errors: string[] = [];
  const onRequest = (request: Request) => {
    const path = new URL(request.url()).pathname;
    if (!["POST", "PUT", "PATCH", "DELETE"].includes(request.method()) || !path.startsWith("/api/")) return;
    if (request.method() === "POST" && path === `/api/order-centers/lines/${lineId}/intake-check`) {
      checks.push(CheckOrderIntakeInputSchema.parse(request.postDataJSON())); return;
    }
    if (request.method() === "POST" && path === `/api/order-centers/lines/${lineId}/draft`) {
      saves.push(request.postDataJSON()); return;
    }
    if (request.method() === "POST" && path === "/api/order-centers/summaries") return;
    forbidden.push(request.method() + " " + path);
  };
  const onError = (error: Error) => errors.push(error.message);
  page.on("request", onRequest); page.on("pageerror", onError);
  return { checks, saves, forbidden, errors,
    stop: () => { page.off("request", onRequest); page.off("pageerror", onError); } };
}

function assertNotDispatched(saved: ReturnType<typeof OrderWorkDetailViewSchema.parse>) {
  expect(saved.line).toMatchObject({ preparation: "ready_to_push", artwork: "not_pushed",
    production: "not_released", editorProjectId: null, shippedQuantity: 0 });
}
function assertSize(draft: OrderWorkDraft) {
  expect(draft.fields.filter(field => field.label === "Size (Most customers choose 12/16/18/24 inch)")
    .map(field => field.value)).toEqual(["10 inch-Mini Keepsake"]);
}
function assertSpecial(draft: OrderWorkDraft) {
  expect(draft.fields.find(field => field.key === "customer_notes")?.value).toBe("Keep the entire synthetic head and ears");
  expect(draft.fields.find(field => field.label === "Font")?.value).toBe("Luckiest Guy");
  expect(draft.fields.find(field => field.label === "Font Color")?.value).toBe("CustomColor");
}
function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { resolve, promise };
}
async function proof(testInfo: TestInfo, fixture: OrderIntakePillowFixture, audit: ReturnType<typeof watch>,
  scenario: string, completed: boolean, delayed?: { originalWasReady: boolean; cancelled: boolean; delivered: boolean }) {
  const file = testInfo.outputPath("order-review-guidance-proof.json");
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ version: 1, scenario, completed, nonce: fixture.nonce,
    lineId: fixture.lineId, sourceVersionId: fixture.sourceVersionId, originalSha256: fixture.buyerSha256,
    nativeIntakeChecks: audit.checks.length, explicitSaves: audit.saves.length,
    forbiddenMutations: audit.forbidden, pageErrors: audit.errors, delayed: delayed ?? null,
    syntheticFixtureOnly: true, basisFixedByFixtureBeforeBrowser: true,
    productionWorkerStarted: false, dispatchRequested: false,
    cleanupOwner: "native disposable runner finally database bucket Redis identity Web sandbox",
  }, null, 2), { flag: "wx" });
}
