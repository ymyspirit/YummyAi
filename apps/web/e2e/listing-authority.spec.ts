import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import {
  actors,
  changeErpRights,
  identityControl,
  loginErp,
  scopedErpRole,
} from "./erp-identity-fixture";

const read = ["product:read", "listing:read"];
async function api(path: string, method = "GET", body?: unknown, account = "operator") {
  if (process.env.E2E_ISOLATED_DAILY !== "1") throw Error("Disposable Listing fixture required");
  const { access_token: token } = await identityControl("token", { account });
  return fetch(`${process.env.API_BASE_URL}/v1/${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}
async function seed(account = "operator") {
  const response = await api("product-development/spus", "POST", {
    code: `LIST-${randomUUID().slice(0, 8)}`,
    name: `Synthetic Listing product ${randomUUID()}`,
    idempotencyKey: randomUUID(),
  });
  expect(response.status).toBe(201);
  const { spu } = await response.json();
  const created = await api(
    "listings",
    "POST",
    {
      spuId: spu.id,
      platform: "amazon",
      locale: "en-US",
      marketplaceId: `SYNTHETIC-${randomUUID()}`,
      content: {
        platform: "amazon",
        locale: "en-US",
        title: `Synthetic Listing ${randomUUID()}`,
        description: "Synthetic local authority fixture",
        bullets: ["Synthetic editable content"],
        tags: [],
        mainImageId: "synthetic-main",
        mediaAssetIds: ["synthetic-main"],
        variants: [],
        attributes: { brand: "Synthetic" },
        compliance: { countryOfOrigin: "CN" },
      },
    },
    account,
  );
  expect(created.status).toBe(201);
  return created.json();
}
const title = (page: Page) => page.locator(".listing-content textarea").first();

test("a company reader cannot edit another owner's Listing with a self write grant", async ({
  page,
}, info) => {
  const record = await seed();
  await changeErpRights("readonly", read);
  const role = await scopedErpRole(["listing:write"], "self");
  try {
    await loginErp(page, "readonly", `/listings/${record.listing.id}`);
    await expect(title(page)).toHaveValue(record.version.content.title);
    await expect(title(page)).not.toBeEditable();
    await expect(page.getByText("当前刊登内容仅可查看", { exact: false })).toBeVisible();
    const denied = await api(
      `listings/${record.listing.id}/versions`,
      "POST",
      { ...record.version.content, title: "Forbidden synthetic edit" },
      "readonly",
    );
    expect(denied.status).toBe(404);
    const own = await seed("readonly");
    await page.goto(`/listings/${own.listing.id}`);
    await expect(title(page)).toBeEditable();
    const ownTitle = "Synthetic own saved title";
    await title(page).fill(ownTitle);
    await page.getByRole("button", { name: "保存为新版本", exact: true }).click();
    await expect(page.getByText("已保存为不可变版本 V02。", { exact: true })).toBeVisible();
    await expect(
      page.locator(".listing-activity-rail").getByText("V02 · 人工编辑", { exact: true }),
    ).toBeVisible();
    expect((await (await api(`listings/${own.listing.id}`)).json()).version.content.title).toBe(
      ownTitle,
    );
    await page.screenshot({ path: info.outputPath("listing-desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2),
    ).toBe(true);
    await page.screenshot({ path: info.outputPath("listing-mobile.png"), fullPage: true });
  } finally {
    await role.remove();
  }
});

test("refresh detects a new version without rebasing the unsaved draft and a conflict preserves it", async ({
  page,
}) => {
  const record = await seed();
  await changeErpRights("readonly", read);
  const role = await scopedErpRole(["listing:write"], "tenant");
  try {
    await loginErp(page, "readonly", `/listings/${record.listing.id}`);
    const draft = "Synthetic unsaved original version draft";
    await title(page).fill(draft);
    const newer = await api(`listings/${record.listing.id}/versions`, "POST", {
      ...record.version.content,
      title: "Synthetic concurrent saved version",
    });
    expect(newer.status).toBe(201);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.getByText("当前已有其他版本", { exact: false })).toBeVisible();
    await expect(title(page)).toHaveValue(draft);
    await page.getByRole("button", { name: "保存为新版本", exact: true }).click();
    await expect(page.locator(".listing-save-notice.error")).toBeVisible();
    await expect(title(page)).toHaveValue(draft);
    const current = await (await api(`listings/${record.listing.id}`)).json();
    expect(current.history).toHaveLength(2);
    expect(current.version.content.title).toBe("Synthetic concurrent saved version");
  } finally {
    await role.remove();
  }
});

test("a transient object check hides private content and restores the same draft after retry", async ({
  page,
}) => {
  const record = await seed();
  await changeErpRights("readonly", read);
  const role = await scopedErpRole(["listing:write"], "tenant");
  try {
    await loginErp(page, "readonly", `/listings/${record.listing.id}`);
    await expect(title(page)).toBeEditable();
    const draft = "Synthetic draft survives temporary object failure";
    await title(page).fill(draft);
    await page.route(`**/api/listings/${record.listing.id}`, (route) =>
      route.fulfill({ status: 503, contentType: "application/json", body: "{}" }),
    );
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.getByText("当前刊登暂时无法核对", { exact: false })).toBeVisible();
    await expect(title(page)).not.toBeVisible();
    await page.unroute(`**/api/listings/${record.listing.id}`);
    await page.getByRole("button", { name: "重新核对刊登", exact: true }).click();
    await expect(title(page)).toBeVisible();
    await expect(title(page)).toHaveValue(draft);
  } finally {
    await role.remove();
  }
});

test("a revoked object read clears the draft and an earlier successful response cannot restore it", async ({
  page,
}) => {
  await changeErpRights("readonly", ["product:read"]);
  const role = await scopedErpRole(["listing:read", "listing:write"], "self");
  const record = await seed("readonly");
  let release = () => {},
    started = () => {},
    first = true;
  const captured = new Promise<void>((resolve) => {
    started = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await loginErp(page, "readonly", `/listings/${record.listing.id}`);
    await expect(title(page)).toBeEditable();
    await title(page).fill("Synthetic private unsaved draft");
    await page.route(`**/api/listings/${record.listing.id}`, async (route) => {
      if (!first) {
        await route.continue();
        return;
      }
      first = false;
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      started();
      await held;
      await route.fulfill({ response }).catch(() => {});
    });
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await captured;
    await transferSyntheticOwner(record.listing.id);
    expect((await page.request.get(`/api/listings/${record.listing.id}`)).status()).toBe(404);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(
      page.getByRole("heading", { name: "刊登当前不可读取", exact: true }),
    ).toBeVisible();
    await expect(title(page)).toHaveCount(0);
    release();
    await expect(
      page.getByRole("heading", { name: "刊登当前不可读取", exact: true }),
    ).toBeVisible();
    await expect(page.getByText("Synthetic private unsaved draft", { exact: true })).toHaveCount(0);
  } finally {
    release();
    await role.remove();
  }
});

async function transferSyntheticOwner(id: string) {
  return mutateSyntheticOwner(id, "readonly", actors().operator.userId);
}

test("a historical ownerless Listing remains readable to a company reader without acquiring self write authority", async ({
  page,
}) => {
  const record = await seed();
  await changeErpRights("readonly", read);
  const role = await scopedErpRole(["listing:write"], "self");
  try {
    await mutateSyntheticOwner(record.listing.id, "operator", null);
    await loginErp(page, "readonly", `/listings/${record.listing.id}`);
    const check = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/listings/${record.listing.id}`) && response.status() === 200,
    );
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    expect((await (await check).json()).listing).not.toHaveProperty("ownerUserId");
    await expect(title(page)).toBeVisible();
    await expect(title(page)).not.toBeEditable();
    await expect(page.getByRole("button", { name: "重新核对刊登", exact: true })).toHaveCount(0);
    expect(
      (
        await api(
          `listings/${record.listing.id}/versions`,
          "POST",
          record.version.content,
          "readonly",
        )
      ).status,
    ).toBe(404);
  } finally {
    await role.remove();
  }
});

async function mutateSyntheticOwner(
  id: string,
  from: "readonly" | "operator",
  target: string | null,
) {
  const url = new URL(process.env.DATABASE_URL!);
  if (
    process.env.E2E_ISOLATED_DAILY !== "1" ||
    !/^\/order_daily_e2e_[a-f0-9]{32}$/.test(url.pathname)
  )
    throw Error("Disposable Listing ownership fixture required");
  const require = createRequire(
    new URL("../../../packages/database/package.json", import.meta.url),
  );
  const sql = require("postgres")(url.toString(), { max: 1 });
  try {
    const records =
      await sql`update listings set created_by=${target} where tenant_id=${actors()[from].tenantId} and id=${id} and created_by=${actors()[from].userId} returning id`;
    expect(records).toHaveLength(1);
  } finally {
    await sql.end();
  }
}
