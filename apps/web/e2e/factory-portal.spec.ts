import { expect, test } from "@playwright/test";
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import type { ChildProcess } from "node:child_process";
import type RedisType from "ioredis";
import type { ProductionDeliveryWorkspace } from "@yummyai/contracts/order/production-delivery";
import { centerApi } from "./order-centers-fixture";
import { startProductionEditorWorker } from "./production-editor-fixture";
import {
  assignFactoryFile,
  createFactoryDelivery,
  factoryControl,
  factoryToken,
  loginFactory,
  personalFactoryTask,
} from "./factory-portal-fixture";
const fixtureRequire = createRequire(new URL("../package.json", import.meta.url));
const Redis = fixtureRequire("ioredis").default as typeof RedisType;
let worker: ChildProcess | undefined;
test.beforeAll(async () => {
  worker = await startProductionEditorWorker();
});
test.afterAll(async () => {
  worker?.kill();
});
const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
async function sessionRecord() {
  const client = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: 1 });
  try {
    const keys = await client.keys("yummyai:factory-auth:v1:*:session:*");
    expect(keys.length).toBeGreaterThan(0);
    const values = await Promise.all(
      keys.map(async (key) => ({ key, value: await client.get(key), ttl: await client.ttl(key) })),
    );
    return values;
  } finally {
    client.disconnect();
  }
}
async function expireAccessCheckpoint(key: string) {
  const database = new URL(process.env.DATABASE_URL!);
  if (
    process.env.E2E_ISOLATED_DAILY !== "1" ||
    !/^\/order_daily_e2e_[a-f0-9]{32}$/.test(database.pathname)
  )
    throw Error("Disposable auth fixture required");
  const client = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: 1 });
  try {
    const encrypted = await client.get(key);
    expect(encrypted).toBeTruthy();
    const [, iv, tag, body] = encrypted!.split("."),
      secret = Buffer.from(process.env.FACTORY_SESSION_ENCRYPTION_KEY!, "base64url"),
      aad = createHash("sha256")
        .update(
          `yummyai:factory-auth:v1:http://localhost:3130:${process.env.OIDC_ISSUER}:yummyai-factory`,
        )
        .digest();
    const decipher = createDecipheriv("aes-256-gcm", secret, Buffer.from(iv!, "base64url"));
    decipher.setAAD(aad);
    decipher.setAuthTag(Buffer.from(tag!, "base64url"));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(body!, "base64url")),
      decipher.final(),
    ]);
    try {
      const record = JSON.parse(plain.toString("utf8"));
      expect(record.kind).toBe("session");
      record.accessExpiresAt = 0;
      const replacement = Buffer.from(JSON.stringify(record));
      try {
        const nonce = randomBytes(12),
          cipher = createCipheriv("aes-256-gcm", secret, nonce);
        cipher.setAAD(aad);
        const output = Buffer.concat([cipher.update(replacement), cipher.final()]);
        await client.set(
          key,
          `v1.${nonce.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${output.toString("base64url")}`,
          "KEEPTTL",
        );
      } finally {
        replacement.fill(0);
      }
    } finally {
      plain.fill(0);
      secret.fill(0);
    }
  } finally {
    client.disconnect();
  }
}

test("factory portal personal login downloads only pinned JPG and records original received/accepted replies", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const delivery = await createFactoryDelivery(),
    { assignment } = await assignFactoryFile(delivery),
    token = await factoryToken("main"),
    task = await personalFactoryTask(assignment.id, token);
  await loginFactory(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button").filter({ hasText: task.reference }).click();
  const detail = page.getByRole("region", { name: "工厂任务详情" });
  await expect(detail).toContainText(task.file!.checksum);
  expect(task.manufacturing!.recipe).toMatchObject({ quantity: 2, unit: "each", proposalOnly: true });
  const manufacturing = detail.getByRole("region", { name: "本次制造清单" });
  await expect(manufacturing).toContainText(task.manufacturing!.recipe!.checksum);
  await expect(manufacturing).toContainText("商家供料");
  await expect(manufacturing).toContainText("工厂执行");
  expect(JSON.stringify(task)).not.toMatch(/stockItemId|expectedSecondsPerOutput|Synthetic private BOM note/);
  await page.screenshot({ path: testInfo.outputPath("factory-manufacturing-desktop.png"), fullPage: true, animations: "disabled" });
  const cookie = (await page.context().cookies()).find(
    (cookie) => cookie.name === "yummyai_factory_session",
  )!;
  expect(cookie.httpOnly).toBe(true);
  expect(cookie.sameSite).toBe("Lax");
  expect(cookie.value).toMatch(/^[\w-]{43}$/);
  const encrypted = await sessionRecord();
  for (const row of encrypted) {
    const value = row.value ?? "";
    expect(/^v1\.[\w-]{16}\.[\w-]{22}\.[\w-]+$/.test(value)).toBe(true);
    expect(/eyJ[\w-]{20,}\.eyJ[\w-]{20,}\.[\w-]+/.test(value)).toBe(false);
    expect(value.includes(token) || value.includes(process.env.API_ACCESS_TOKEN!)).toBe(false);
  }
  const forbidden = [
    "/orders",
    "/settings/ai",
    "/api/order-centers/workspace",
    "/api/factory-collaboration/workspace",
    "/_next/image?url=%2Fapi%2Forder-centers%2Fworkspace&w=640&q=75",
    "/api/order-centers/workspace?_rsc=probe",
  ];
  for (const path of forbidden) {
    const denied = await page.request.get(path, {
      headers: { authorization: `Bearer ${process.env.API_ACCESS_TOKEN}` },
    });
    expect(denied.status(), path).toBe(404);
  }
  for (const path of [
    "order-centers/workspace",
    `production-editor/projects/${delivery.item.snapshot!.editorProjectId}`,
    `order-centers/deliveries/${delivery.packet.id}/file`,
  ]) {
    const denied = await fetch(`${process.env.API_BASE_URL}/v1/${path}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(denied.status, path).toBe(403);
  }
  const minimal = JSON.stringify(task);
  for (const value of [
    "Synthetic recipient",
    "1 Test Street",
    delivery.order.externalId,
    "encryptedPayload",
    "buyerPhone",
    "amountMinor",
  ])
    expect(minimal).not.toContain(value);
  const awaiting = page.waitForEvent("download");
  await detail.getByRole("link", { name: "下载原制作文件" }).click();
  const download = await awaiting;
  expect(hash(await readFile((await download.path())!))).toBe(
    delivery.item.snapshot!.file.checksum,
  );
  for (const [kind, note] of [
    ["received", "Synthetic factory received exact assigned file"],
    ["accepted", "Synthetic factory accepted exact assigned file"],
  ]) {
    const form = detail.getByRole("form", { name: "提交工厂回执" });
    const acknowledge = form.getByRole("button", { name: "重新核对", exact: true });
    if (await acknowledge.isVisible()) await acknowledge.click();
    await form.getByLabel("本次回复").selectOption(kind!);
    await form.getByLabel("回执依据", { exact: true }).fill(`SYNTHETIC-${kind}`);
    await form.getByLabel("回复说明").fill(note!);
    await form.getByRole("checkbox").check();
    await form.getByRole("button", { name: "提交回执", exact: true }).click();
    await expect(detail.getByRole("region", { name: "本任务回执" })).toContainText(note!);
  }
  const saved = await centerApi<ProductionDeliveryWorkspace>(
      `order-centers/deliveries?factory=${delivery.order.factoryId}`,
    ),
    item = saved.packages.find((row) => row.id === delivery.packet.id)!.items[0]!;
  expect(item.status).toBe("accepted");
  expect(item.feedback.map((row) => row.origin)).toEqual(["factory", "factory"]);
  expect(item.feedback.map((row) => row.kind)).toEqual(["received", "accepted"]);
  const order = await centerApi<{ line: { orderStatus: string; readyQuantity: number } }>(
    `order-centers/lines/${delivery.order.lines[0]}`,
  );
  expect(typeof order.line.orderStatus).toBe("string");
  expect(["produced", "shipped"]).not.toContain(order.line.orderStatus);
  expect(order.line.readyQuantity).toBe(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(detail).toBeVisible();
  await expect(manufacturing).toContainText(task.manufacturing!.recipe!.checksum);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("factory-task-mobile.png"), fullPage: true, animations: "disabled" });
  expect(errors).toEqual([]);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await detail.getByRole("button", { name: "关闭", exact: true }).focus();
  await page.keyboard.press("Escape");
  await expect(detail).toHaveCount(0);
  const selectedTask = page.getByRole("button").filter({ hasText: task.reference });
  await expect(selectedTask).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(detail).toBeVisible();
  let failLogout = true;
  await page.route("**/api/factory-auth/logout", async (route) => {
    if (failLogout) {
      failLogout = false;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ message: "Synthetic logout response unavailable" }),
      });
    } else await route.continue();
  });
  await page.getByRole("button", { name: "退出协作" }).click();
  await expect(page.getByRole("heading", { name: "退出状态尚未确认", exact: true })).toBeVisible();
  await expect(detail).toHaveCount(0);
  await expect(page.getByRole("link", { name: "登录协作", exact: true })).toHaveCount(0);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByRole("region", { name: "工厂任务详情" })).toHaveCount(0);
  await page.getByRole("button", { name: "重试退出", exact: true }).click();
  await expect(page.getByRole("link", { name: "登录协作", exact: true })).toBeVisible();
  expect(
    (await page.request.get(`/api/factory-portal/work-items/${assignment.id}/file`)).status(),
  ).toBe(401);
});

test("factory portal enforces read-only grants and keeps unrelated members outside assigned tasks", async ({
  page,
}) => {
  const delivery = await createFactoryDelivery(),
    { assignment } = await assignFactoryFile(delivery, "reader", false);
  await loginFactory(page, "reader");
  const token = await factoryToken("reader"),
    task = await personalFactoryTask(assignment.id, token);
  await page.getByRole("button").filter({ hasText: task.reference }).click();
  const detail = page.getByRole("region", { name: "工厂任务详情" });
  await expect(detail.getByRole("link", { name: "下载原制作文件" })).toBeVisible();
  await expect(detail.getByRole("form", { name: "提交工厂回执" })).toHaveCount(0);
  expect(
    (
      await page.request.post(`/api/factory-portal/work-items/${assignment.id}/feedback`, {
        headers: { origin: "http://localhost:3130" },
        data: {},
      })
    ).status(),
  ).toBe(403);
  await page.getByRole("button", { name: "退出协作" }).click();
  await loginFactory(page, "other");
  await expect(page.locator(".fp-alert")).toContainText("尚无有效工厂任务授权");
  expect((await page.request.get(`/api/factory-portal/work-items/${assignment.id}`)).status()).toBe(
    403,
  );
});

test("factory portal revocation clears drafts and discards an older successful private response", async ({
  page,
}) => {
  const delivery = await createFactoryDelivery(),
    { grant, assignment } = await assignFactoryFile(delivery);
  await loginFactory(page);
  const task = await personalFactoryTask(assignment.id, await factoryToken("main"));
  await page.getByRole("button").filter({ hasText: task.reference }).click();
  const detail = page.getByRole("region", { name: "工厂任务详情" });
  await detail.getByLabel("回复说明").fill("Synthetic unsent private factory note");
  let release!: () => void, received!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve)),
    ready = new Promise<void>((resolve) => (received = resolve));
  let once = true;
  await page.route(`**/api/factory-portal/work-items/${assignment.id}`, async (route) => {
    if (!once) {
      await route.continue();
      return;
    }
    once = false;
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    received();
    await held;
    await route.fulfill({ response });
  });
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await ready;
  await centerApi(`factory-collaboration/grants/${grant.id}/revoke`, {
    reason: "Synthetic collaboration ended",
    idempotencyKey: randomUUID(),
  });
  try {
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.locator(".fp-alert")).toContainText("授权已失效");
  } finally {
    release();
  }
  await expect(detail).toHaveCount(0);
  await expect(page.getByText("Synthetic unsent private factory note")).toHaveCount(0);
  await page.waitForTimeout(300);
  await expect(detail).toHaveCount(0);
  expect(
    (await page.request.get(`/api/factory-portal/work-items/${assignment.id}/file`)).status(),
  ).toBe(404);
});

test("factory portal rejects callback/CSRF attacks and cannot recreate a logged-out Redis session during refresh", async ({
  page,
}) => {
  expect((await page.request.get("/api/factory-auth/callback?code=x&state=x")).status()).toBe(400);
  expect(
    (await page.request.get("/api/factory-auth/login?redirect=https://invalid.example")).status(),
  ).toBe(400);
  const delivery = await createFactoryDelivery();
  await assignFactoryFile(delivery);
  await factoryControl("configure", { accessSeconds: "300", refreshDelay: "1200" });
  try {
    await loginFactory(page);
    expect(
      (
        await page.request.post("/api/factory-auth/logout", {
          headers: { origin: "https://invalid.example" },
        })
      ).status(),
    ).toBe(400);
    await expect(page.getByText("正在核对当前授权")).toHaveCount(0);
    const cookie = (await page.context().cookies()).find(
      (row) => row.name === "yummyai_factory_session",
    )!;
    const before = (await sessionRecord()).filter((row) => row.key.endsWith(hash(cookie.value))),
      snapshot = await factoryControl("proof");
    expect(before).toHaveLength(1);
    await expireAccessCheckpoint(before[0]!.key);
    const pending = page.request.get("/api/factory-portal/work-items");
    await expect
      .poll(async () => (await factoryControl("proof")).refreshExchanges, { timeout: 10000 })
      .toBeGreaterThan(snapshot.refreshExchanges);
    const logout = await page.request.post("/api/factory-auth/logout", {
      headers: { origin: "http://localhost:3130" },
    });
    expect(logout.ok()).toBe(true);
    expect((await pending).status()).toBe(401);
    const client = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: 1 });
    try {
      for (const row of before) expect(await client.exists(row.key)).toBe(0);
    } finally {
      client.disconnect();
    }
    expect((await factoryControl("proof")).replayedRefreshes).toBe(0);
    expect((await page.request.get("/api/factory-portal/session")).status()).toBe(401);
  } finally {
    await factoryControl("configure", { accessSeconds: "300", refreshDelay: "0" });
  }
});
