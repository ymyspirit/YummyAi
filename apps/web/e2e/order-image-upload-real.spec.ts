import { expect, test, type Page, type Request } from "@playwright/test";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { writeFile } from "node:fs/promises";
import { createEntityId, type MarketplaceAccountView, type AmazonReportBatchView, type AmazonReportWorkspaceView } from "@yummyai/contracts";
import { ErpSessionViewSchema } from "@yummyai/contracts/auth/session";
import { OrderWorkDetailViewSchema } from "@yummyai/contracts/order/workspace";
import { Permission } from "@yummyai/authz";
import { decryptProductionBytes } from "@yummyai/production-editor";
import { connectDatabase, orderWorkAssets, orderWorkItems } from "../../../packages/database/src/index.js";
import { currentOrderAuthority, withOrderAuthority } from "../../../packages/order-core/src/index.js";
import { createStorageFromEnvironment } from "../../../packages/storage/src/index.js";
import { createOrderPiiVault } from "../../api/src/orders/order-pii-vault.js";
import type * as Drizzle from "../../../packages/database/node_modules/drizzle-orm/index.js";
import { requireDisposableIntegrationEnvironment } from "../../../tools/testing/require-disposable-integration.mjs";
import { centerApi } from "./order-centers-fixture";
import { apiFetch } from "../src/server-api";
import { actors, loginErp } from "./erp-identity-fixture";
import { syntheticProductionPng } from "./production-editor-fixture";

const requireDatabase = createRequire(new URL("../../../packages/database/package.json", import.meta.url));
const { eq, and, sql } = requireDatabase("drizzle-orm") as typeof Drizzle;
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** The browser's image endpoint returns a preview. Read the exact original
 * independently through the ordinary tenant role, current session ceiling and
 * native private storage; this helper never creates or modifies business rows. */
async function storedOriginal(page: Page, lineId: string, imageId: string) {
  const url = requireDisposableIntegrationEnvironment();
  const sessionResponse = await page.request.get("/api/erp-auth/session");
  expect(sessionResponse.status()).toBe(200);
  const context = ErpSessionViewSchema.parse(await sessionResponse.json());
  expect(context.userId).toBe(actors().operator.userId);
  expect(context.tenantId).toBe(actors().operator.tenantId);
  const database = connectDatabase(url), storage = createStorageFromEnvironment(), vault = createOrderPiiVault();
  try {
    return await withOrderAuthority(database.db, context, [Permission.OrderRead, Permission.OrderPiiRead], async (tx) => {
      const current = await currentOrderAuthority(tx, context, [Permission.OrderRead, Permission.OrderPiiRead], { lock: false, requireMembership: true });
      const [role] = await tx.execute<{ role: string }>(sql`select current_user as role`);
      expect(role?.role).toBe("yummyai_app");
      const [row] = await tx.select({ asset: orderWorkAssets, work: orderWorkItems }).from(orderWorkAssets)
        .innerJoin(orderWorkItems, eq(orderWorkItems.id, orderWorkAssets.workItemId))
        .where(and(eq(orderWorkAssets.id, imageId), eq(orderWorkAssets.workItemId, lineId)));
      if (!row?.work.encryptedDataKey) throw new Error("Owned synthetic upload original is missing");
      expect(row.asset.tenantId).toBe(context.tenantId);
      expect(row.work.tenantId).toBe(context.tenantId);
      const key = vault.withSecret(row.work.encryptedDataKey, (value) => Buffer.from(value, "base64"));
      try {
        const encrypted = await storage.readPrivate(current, {
          id: row.asset.id, tenantId: context.tenantId, assetDomain: "order", objectKey: row.asset.objectKey,
        }, { requiredDomain: "order", maxBytes: 1024 * 1024 });
        const original = decryptProductionBytes(key, encrypted);
        await currentOrderAuthority(tx, context, [Permission.OrderRead, Permission.OrderPiiRead], { lock: false, requireMembership: true });
        expect(sha(original)).toBe(row.asset.checksum);
        return original;
      } finally { key.fill(0); }
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
  } finally { await database.client.end(); }
}

test("whole order image upload uses the real personal API scanner and private storage before saving a draft", async ({ page }, testInfo) => {
  requireDisposableIntegrationEnvironment();
  expect(process.env.E2E_ORDER_IMAGE_UPLOAD_ISOLATED).toBe("1");
  expect(process.env.WEB_AUTH_MODE).toBe("personal");
  const prefix = "SYNTHETIC-UPLOAD-" + createEntityId();
  const account = await centerApi<MarketplaceAccountView>("marketplace-accounts", {
    platform: "amazon", displayName: prefix, region: "NA", marketplaceIds: ["ATVPDKIKX0DER"],
    authorizationMode: "amazon_private", requestedScopes: [],
  });
  let batchId: string | null = null, lineId: string | null = null;
  const browserWrites: string[] = [], forbiddenWrites: string[] = [], pageErrors: string[] = [];
  const observe = (request: Request) => {
    const path = new URL(request.url()).pathname;
    if (!["POST", "PUT", "PATCH", "DELETE"].includes(request.method()) || !path.startsWith("/api/")) return;
    browserWrites.push(`${request.method()} ${path}`);
    const exact = path === `/api/order-centers/lines/${lineId}/images` || path === `/api/order-centers/lines/${lineId}/draft`;
    const readOnly = ["/api/order-centers/summaries", "/api/agent-resources/definition", "/api/agent-tools/definition", "/api/agent-resources/candidates"].includes(path);
    if (request.method() !== "POST" || !exact && !readOnly) forbiddenWrites.push(`${request.method()} ${path}`);
  };
  try {
    const batch = await centerApi<AmazonReportBatchView>("orders/reports/import", {
      accountId: account.id, marketplaceId: "ATVPDKIKX0DER", fileName: "synthetic-order-image-upload.txt",
      content: ["order-id\torder-item-id\tpurchase-date\tsku\tproduct-name\tquantity-purchased\tcurrency\titem-price",
        `${prefix}\tITEM-ONE\t${new Date().toISOString()}\t${prefix}\tSynthetic image upload product\t1\tUSD\t20.00`].join("\n"),
    });
    batchId = batch.id;
    const workspace = await centerApi<AmazonReportWorkspaceView>(`orders/reports/workspace?batchId=${batchId}`);
    expect(workspace.lines).toHaveLength(1);
    lineId = workspace.lines[0]!.orderLineId;
    const initial = OrderWorkDetailViewSchema.parse(await centerApi(`order-centers/lines/${lineId}`));
    expect(initial.line.revision).toBe(0);
    expect(initial.assets).toEqual([]);
    expect(initial.versions).toEqual([]);
    const immutableFields = structuredClone(initial.draft.fields), original = syntheticProductionPng(64);
    await loginErp(page, "operator", `/orders?line=${lineId}`);
    page.on("request", observe);
    page.on("pageerror", (error) => pageErrors.push(error.message));
    const drawer = page.getByRole("dialog", { name: "整单详情", exact: true });
    await expect(drawer.getByRole("heading", { name: prefix, exact: true })).toBeVisible();
    await drawer.getByRole("textbox", { name: "制作说明", exact: true }).fill("Unsaved synthetic instructions before first upload");
    const upload = drawer.getByRole("button", { name: "上传定制图片", exact: true });
    const firstName = "synthetic-native-first.png", secondName = "synthetic-native-second.png";
    async function chooseFile(name: string) {
      await expect(upload).toBeEnabled();
      const chooser = page.waitForEvent("filechooser");
      await upload.click();
      await (await chooser).setFiles({ name, mimeType: "image/png", buffer: original });
    }
    await chooseFile(firstName);
    const first = drawer.getByRole("checkbox", { name: firstName, exact: true });
    await expect(first).toBeChecked();
    await expect(drawer.getByRole("textbox", { name: "制作说明", exact: true })).toHaveValue("Unsaved synthetic instructions before first upload");
    const afterFirst = OrderWorkDetailViewSchema.parse(await centerApi(`order-centers/lines/${lineId}`));
    expect(afterFirst.line.revision).toBe(0);
    expect(afterFirst.versions).toEqual([]);
    expect(afterFirst.assets).toHaveLength(1);
    expect(afterFirst.draft.images).toEqual([]); // Upload alone has not saved the UI selection.
    expect(await storedOriginal(page, lineId, afterFirst.assets[0]!.id)).toEqual(original);
    const preview = await page.request.get(afterFirst.assets[0]!.path);
    expect(preview.status()).toBe(200);
    expect(preview.headers()["cache-control"]).toContain("no-store");
    expect(preview.headers()["content-type"]).toContain("image/png");
    expect((await preview.body()).subarray(0, 8)).toEqual(original.subarray(0, 8));
    await expect(drawer.getByRole("img", { name: firstName, exact: true })).toHaveJSProperty("naturalWidth", 64);
    await first.uncheck();
    const note = "Explicit first-image cancellation and unsaved note must survive the next upload";
    await drawer.getByRole("textbox", { name: "制作说明", exact: true }).fill(note);
    await chooseFile(secondName);
    const second = drawer.getByRole("checkbox", { name: secondName, exact: true });
    await expect(second).toBeChecked();
    await expect(first).not.toBeChecked();
    await expect(drawer.getByRole("textbox", { name: "制作说明", exact: true })).toHaveValue(note);
    const afterSecond = OrderWorkDetailViewSchema.parse(await centerApi(`order-centers/lines/${lineId}`));
    expect(afterSecond.assets).toHaveLength(2);
    const secondAsset = afterSecond.assets.find((asset) => asset.name === secondName)!;
    expect(await storedOriginal(page, lineId, secondAsset.id)).toEqual(original);
    expect(afterSecond.line).toMatchObject({ revision: 0, artwork: "not_pushed", production: "not_released" });
    expect(afterSecond.draft.fields).toEqual(immutableFields);
    await drawer.getByRole("button", { name: "记录待补资料", exact: true }).click();
    await expect(drawer.getByRole("status").filter({ hasText: "草稿已保存" })).toBeVisible();
    const saved = OrderWorkDetailViewSchema.parse(await centerApi(`order-centers/lines/${lineId}`));
    expect(saved.line).toMatchObject({ revision: 1, preparation: "needs_information", artwork: "not_pushed", production: "not_released" });
    expect(saved.versions).toHaveLength(1);
    expect(saved.draft.fields).toEqual(immutableFields);
    expect(saved.draft.instructions).toBe(note);
    expect(saved.draft.images).toEqual([{ origin: "upload", key: secondAsset.id, usage: "正面" }]);
    await page.reload();
    await expect(first).not.toBeChecked();
    await expect(second).toBeChecked();
    await expect(drawer.getByRole("textbox", { name: "制作说明", exact: true })).toHaveValue(note);
    expect(forbiddenWrites).toEqual([]);
    expect(browserWrites.filter((path) => path.endsWith("/images"))).toHaveLength(2);
    expect(browserWrites.filter((path) => path.endsWith("/draft"))).toHaveLength(1);
    expect(pageErrors).toEqual([]);
    await second.scrollIntoViewIfNeeded();
    await expect(second).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath("order-image-upload-real-native.png") });
    await writeFile(testInfo.outputPath("order-image-upload-real-proof.json"), JSON.stringify({
      syntheticOnly: true, accountId: account.id, batchId, lineId, uploadedAssets: saved.assets.map((asset) => ({ id: asset.id, checksum: asset.checksum })),
      originalByteSha256: sha(original), originalByteReads: 2, originalReadRole: "yummyai_app", originalReadCurrentMembership: true,
      browserTransportMocked: false, revision: saved.line.revision, preparation: saved.line.preparation,
      dispatchOrModelOrProductionWrites: forbiddenWrites, browserWrites,
      cleanupOwner: "native disposable acceptance runner database/private bucket/Redis/identity finally",
    }, null, 2) + "\n", { flag: "wx" });
  } finally {
    page.off("request", observe);
    const disabled = await apiFetch(`${process.env.API_BASE_URL}/v1/marketplace-accounts/${account.id}`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: false }),
    });
    expect(disabled.ok, "Synthetic account disabled; batch and all private objects remain owned by runner teardown").toBe(true);
  }
});
