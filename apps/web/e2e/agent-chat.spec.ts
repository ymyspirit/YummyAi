import { writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { AssistViewSchema, type AssistView } from "@yummyai/contracts/ai/assist";
import { agentChatBrowserFixture } from "./agent-chat-browser-fixture";
import { requireAgentReadBrowser } from "./agent-read-fixture";
import { actors, loginErp } from "./erp-identity-fixture";

requireAgentReadBrowser();
test.setTimeout(240_000);
const sha = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
const chat = (page: Page) => page.getByRole("region", { name: "AI Agent 对话工作台", exact: true });
const answer = (page: Page) => chat(page).getByRole("article", { name: "Agent 回复", exact: true });
async function screenshot(page: Page, info: TestInfo, leaf: string) {
  const path = info.outputPath(leaf + ".png");
  const bytes = await page.screenshot({ path, fullPage: false });
  return { path, sha256: sha(bytes), bytes: bytes.byteLength, viewport: page.viewportSize() };
}
async function noRootOverflow(page: Page) {
  const box = await page.evaluate(() => ({
    width: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(box.scroll).toBeLessThanOrEqual(box.width + 1);
  return box;
}
async function browserTurn(
  page: Page,
  fixture: Awaited<ReturnType<typeof agentChatBrowserFixture>>,
  question: string,
) {
  const pending = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/agent-chat/turns",
  );
  await chat(page).getByRole("textbox", { name: "给 Agent 的要求", exact: true }).fill(question);
  await chat(page).getByRole("button", { name: "发送", exact: true }).click();
  const response = await pending;
  expect(response.status()).toBe(201);
  const run = AssistViewSchema.parse(await response.json());
  fixture.trackRun(run.id);
  expect(run.request?.kind).toBe("knowledge_answer");
  expect(run.request?.taskGoal).toBe(question);
  return run;
}

test("agent chat streams actual output before completion and restores native multi-turn history", async ({
  page,
}, info) => {
  const fixture = await agentChatBrowserFixture();
  const screenshots: Awaited<ReturnType<typeof screenshot>>[] = [];
  const writes: Array<{ method: string; path: string }> = [],
    pageErrors: string[] = [],
    consoleErrors: string[] = [];
  const report: Record<string, unknown> = {
    nonce: fixture.nonce,
    actor: actors().operator,
    admission:
      "Compiled personal 3130/8130 with original current-nonce RLS, real loopback Responses HTTP/SSE, native Assist/Durable receipts; no mocked business or browser responses",
    browserAssertionsPassed: false,
    screenshots,
  };
  let failure: unknown;
  try {
    await page.setViewportSize({ width: 1440, height: 960 });
    await loginErp(page, "operator", "/ai-tasks");
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (request.method() === "POST" && path.startsWith("/api/agent-chat/"))
        writes.push({ method: request.method(), path });
    });
    page.on("pageerror", () => pageErrors.push("unexpected_page_error"));
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push("unexpected_browser_console_error");
    });
    await expect(chat(page)).toBeVisible();
    await expect(page.getByRole("region", { name: "原生模型任务版本", exact: true })).toHaveCount(
      0,
    );
    await expect(page.getByRole("region", { name: "Agent 只读工具", exact: true })).toHaveCount(0);
    const model = chat(page).getByRole("combobox", { name: "对话模型", exact: true });
    await expect(model.locator(`option[value="${fixture.modelId}"]`)).toHaveCount(1);
    await model.selectOption(fixture.modelId);
    const composer = chat(page).getByRole("textbox", { name: "给 Agent 的要求", exact: true });
    await composer.fill(fixture.question);
    await composer.dispatchEvent("compositionstart");
    await composer.dispatchEvent("keydown", {
      key: "Enter",
      code: "Enter",
      isComposing: true,
      keyCode: 229,
    });
    await composer.dispatchEvent("compositionend");
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await expect(composer).toHaveValue(fixture.question);
    expect(writes).toEqual([]);
    await composer.press("Shift+Enter");
    await expect(composer).toHaveValue(fixture.question + "\n");
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    expect(writes).toEqual([]);

    const first = await browserTurn(page, fixture, fixture.question);
    await expect(answer(page).first().getByText(fixture.partial, { exact: true })).toBeVisible();
    expect(fixture.calls()).toHaveLength(1);
    expect(fixture.calls()[0]).toMatchObject({ stream: true, finalSent: false, released: false });
    expect(await fixture.nativeRuns()).toEqual([
      expect.objectContaining({
        id: first.id,
        status: "running",
        inputTokens: null,
        outputTokens: null,
        tokenUsage: null,
        attemptCount: 1,
        submissionState: "submitted",
      }),
    ]);
    screenshots.push(await screenshot(page, info, "agent-chat-01-real-stream-before-final"));
    fixture.release(0);
    await expect(
      answer(page).first().getByText(fixture.firstSummary, { exact: true }),
    ).toBeVisible();
    await expect(answer(page).first().getByText("用量 18 tokens", { exact: true })).toBeVisible();
    const firstFinal = await fixture.waitTerminal(first.id);
    expect(firstFinal).toMatchObject({
      status: "completed",
      inputTokens: 11,
      outputTokens: 7,
      tokenUsage: { totalTokens: 18 },
    });
    expect(firstFinal.knowledge.some((source) => source.title === fixture.title)).toBe(true);
    await answer(page).first().getByText("用量 18 tokens", { exact: true }).click();
    await expect(answer(page).first().getByText("输入 tokens", { exact: true })).toBeVisible();
    await expect(answer(page).first().getByText("输出 tokens", { exact: true })).toBeVisible();
    const sourceSummary = answer(page).first().locator(".agent-chat-sources summary");
    await sourceSummary.click();
    await expect(
      answer(page)
        .first()
        .getByRole("link", { name: fixture.title + " · V1", exact: true }),
    ).toBeVisible();

    const scope = new URL(page.url()).searchParams.get("chat");
    expect(scope).toBeTruthy();
    const second = await browserTurn(page, fixture, fixture.secondQuestion);
    expect(second.scope).toBe(first.scope);
    expect(second.request?.kind === "knowledge_answer" ? second.request.previousRunId : null).toBe(
      first.id,
    );
    await expect.poll(() => fixture.calls().length).toBe(2);
    expect(fixture.calls()[1]!.context.conversation).toEqual([
      { question: fixture.question, answer: fixture.firstSummary },
    ]);
    fixture.release(1);
    await expect(
      answer(page).nth(1).getByText(fixture.secondSummary, { exact: true }),
    ).toBeVisible();
    await expect(answer(page).nth(1).getByText("用量 18 tokens", { exact: true })).toBeVisible();
    const secondFinal = await fixture.waitTerminal(second.id);
    expect(secondFinal).toMatchObject({
      status: "completed",
      inputTokens: 11,
      outputTokens: 7,
      tokenUsage: { totalTokens: 18 },
    });
    expect(
      secondFinal.request?.kind === "knowledge_answer" ? secondFinal.request.scopeId : null,
    ).toBe(scope);
    expect(fixture.providerFailures()).toEqual([]);
    report.desktop = await noRootOverflow(page);
    screenshots.push(await screenshot(page, info, "agent-chat-02-native-two-turn-desktop"));

    const writesBeforeReopen = [...writes];
    expect(writes.filter((item) => item.path === "/api/agent-chat/turns")).toHaveLength(2);
    expect(writes.filter((item) => /\/runs\/[^/]+\/stream$/.test(item.path))).toHaveLength(2);
    await page.reload();
    await expect(answer(page)).toHaveCount(2);
    await expect(
      answer(page).first().getByText(fixture.firstSummary, { exact: true }),
    ).toBeVisible();
    await expect(
      answer(page).nth(1).getByText(fixture.secondSummary, { exact: true }),
    ).toBeVisible();
    expect(writes).toEqual(writesBeforeReopen);
    expect(fixture.calls()).toHaveLength(2);
    await page.goto("/");
    await page.goto("/ai-tasks?chat=" + scope);
    await expect(answer(page)).toHaveCount(2);
    await expect(
      answer(page).nth(1).getByText(fixture.secondSummary, { exact: true }),
    ).toBeVisible();
    expect(writes).toEqual(writesBeforeReopen);
    expect(fixture.calls()).toHaveLength(2);

    await page.setViewportSize({ width: 390, height: 844 });
    report.mobile = await noRootOverflow(page);
    screenshots.push(await screenshot(page, info, "agent-chat-03-mobile-history-restored"));
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.goto("/ai-tasks?tools=1");
    await expect(page.getByRole("region", { name: "原生模型任务版本", exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "Agent 只读工具", exact: true })).toBeVisible();
    await expect(chat(page)).toHaveCount(0);
    screenshots.push(await screenshot(page, info, "agent-chat-04-original-advanced-workbench"));
    expect(writes).toEqual(writesBeforeReopen);
    expect(fixture.calls()).toHaveLength(2);
    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
    const nativeRuns = await fixture.nativeRuns();
    expect(nativeRuns).toEqual(
      [firstFinal, secondFinal].map((run: AssistView) =>
        expect.objectContaining({
          id: run.id,
          status: "completed",
          phase: "completed",
          attemptCount: 1,
          submissionState: "received",
          inputTokens: 11,
          outputTokens: 7,
          tokenUsage: expect.objectContaining({ totalTokens: 18 }),
        }),
      ),
    );
    Object.assign(report, {
      browserAssertionsPassed: true,
      knownTotalTokens: 36,
      actualModelCalls: fixture.calls().length,
      currentRunIds: nativeRuns.map((run) => run.id),
      requestWrites: writes,
      pageErrors,
      consoleErrors,
      guardsUnchanged: true,
      preservedOriginalAdvancedEntry: true,
      compositionEnterProtected: true,
      shiftEnterNewline: true,
      partialVisibleBeforeFinal: true,
      nativeContextContinued: true,
      refreshAndReopenCreatedNoNewPaidRequest: true,
    });
  } catch (error) {
    failure = error;
    report.failure = "agent_chat_browser_assertion_failed";
  } finally {
    try {
      report.fixtureCleanup = await fixture.close();
    } catch (error) {
      report.fixtureCleanup = { complete: false, code: "agent_chat_fixture_cleanup_failed" };
      if (!failure) failure = error;
    }
    report.providerFailures = fixture.providerFailures();
    await writeFile(
      info.outputPath("agent-chat-validation.json"),
      JSON.stringify(report, null, 2) + "\n",
    );
  }
  if (failure) throw failure;
});
