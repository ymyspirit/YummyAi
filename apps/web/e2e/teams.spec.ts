import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { apiFetch } from "../src/server-api";
import { actors, loginErp, productWriterRole } from "./erp-identity-fixture";

async function create(path: string, data: unknown) {
  if (process.env.E2E_ISOLATED_DAILY !== "1") throw Error("Disposable team browser required");
  const response = await apiFetch(`${process.env.API_BASE_URL}/v1/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(data),
  });
  expect(response.status).toBe(201);
  return response.json();
}
const command = (extra: Record<string, unknown>) => ({
  requestId: randomUUID(),
  reason: "Synthetic browser team review",
  ...extra,
});

test("manages real team names and member relationships at desktop and mobile widths", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await loginErp(page, "operator", "/settings/teams");
  await expect(page.getByRole("heading", { name: "团队管理", exact: true })).toBeVisible();
  if (process.env.E2E_COMPILED_WEB === "1")
    await expect(page.locator("nextjs-portal")).toHaveCount(0);
  const name = "Synthetic team " + randomUUID().slice(0, 8),
    createForm = page.getByRole("form", { name: "新增团队", exact: true });
  await createForm.getByLabel("团队名称", { exact: true }).fill(name);
  await createForm.getByLabel("建立原因", { exact: true }).fill("Synthetic team ownership setup");
  await createForm.getByRole("button", { name: "创建团队", exact: true }).click();
  await expect(page.getByRole("button", { name: `编辑 ${name}`, exact: true })).toBeVisible();
  await page.getByRole("button", { name: `编辑 ${name}`, exact: true }).click();
  const edit = page.getByRole("form", { name: "编辑团队", exact: true });
  await edit.getByLabel("团队名称", { exact: true }).fill(name + " renamed");
  await edit.getByLabel("修改原因", { exact: true }).fill("Synthetic rename review");
  await edit.getByRole("button", { name: "保存团队", exact: true }).click();
  await expect(
    page.getByRole("button", { name: `编辑 ${name} renamed`, exact: true }),
  ).toBeVisible();
  const members = page.getByRole("form", { name: "管理成员关联", exact: true });
  await members.getByLabel("团队", { exact: true }).selectOption({ label: name + " renamed" });
  await members.getByLabel("成员", { exact: true }).selectOption(actors().readonly.membershipId);
  await members.getByLabel("关联调整原因", { exact: true }).fill("Synthetic member association");
  await members.getByRole("button", { name: "关联到团队", exact: true }).click();
  const row = page
    .locator(".teams-list>li")
    .filter({ has: page.getByText(name + " renamed", { exact: true }) });
  await expect(row.getByText("Synthetic ERP reader", { exact: true })).toBeVisible();
  await row.getByRole("button", { name: "管理关联", exact: true }).click();
  await members.getByLabel("关联调整原因", { exact: true }).fill("Synthetic member removal");
  await members.getByRole("button", { name: "移除成员关联", exact: true }).click();
  await expect(row.getByText("已移除", { exact: true })).toBeVisible();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
    await expect(page.getByRole("heading", { name: "团队管理", exact: true })).toBeVisible();
    expect(
      await page.getByRole("heading", { name: "团队管理", exact: true }).evaluate((element) => {
        const box = element.getBoundingClientRect(),
          hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        return hit !== null && element.contains(hit);
      }),
    ).toBe(true);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`team-${width}.png`), fullPage: true });
  }
  expect(errors).toEqual([]);
});

test("team membership removal clears a current product draft and prevents stale writes", async ({
  page,
}) => {
  const team = await create(
    "teams",
    command({ name: "Synthetic scoped " + randomUUID().slice(0, 8) }),
  );
  const relation = await create(
    `teams/${team.id}/members`,
    command({ membershipId: actors().readonly.membershipId, active: true, expectedRevision: null }),
  );
  const role = await productWriterRole("team");
  try {
    const plan = await create("products/plans", {
      name: "Synthetic team product " + randomUUID().slice(0, 8),
      teamId: team.id,
      sourceReportIds: [],
      customization: {
        version: 1,
        fields: [{ key: "buyer_name", label: "姓名", type: "short_text", required: true }],
      },
    });
    await loginErp(page, "readonly", `/products?plan=${plan.id}`);
    const input = page.getByLabel("客户标签", { exact: true });
    await expect(input).toBeEditable();
    await input.fill("Synthetic unsaved team draft");
    await create(
      `teams/${team.id}/members`,
      command({
        membershipId: actors().readonly.membershipId,
        active: false,
        expectedRevision: relation.revision,
      }),
    );
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.getByRole("button", { name: "保存产品计划", exact: true })).toHaveCount(0);
    await expect(input).toHaveValue("姓名");
    await expect(input).not.toBeEditable();
  } finally {
    await role.remove();
  }
});

test("creates a product with the selected real team through the original product form", async ({
  page,
}) => {
  const teamName = "Synthetic product team " + randomUUID().slice(0, 8),
    team = await create("teams", command({ name: teamName }));
  await loginErp(page, "operator", "/products");
  await page.locator(".product-create-panel>summary").click();
  await page.getByLabel("所属团队", { exact: true }).selectOption(team.id);
  const name = "Synthetic selected-team product " + randomUUID().slice(0, 8);
  await page.getByLabel("产品名称 *", { exact: true }).fill(name);
  await page.getByRole("button", { name: "创建产品企划", exact: true }).click();
  await expect(page).toHaveURL(/plan=[0-9a-f-]+/);
  const id = new URL(page.url()).searchParams.get("plan");
  const response = await apiFetch(`${process.env.API_BASE_URL}/v1/products/plans`, {
    cache: "no-store",
  });
  expect(response.ok).toBe(true);
  const saved = (
    (await response.json()) as Array<{ id: string; name: string; teamId?: string }>
  ).find((plan) => plan.id === id);
  expect(saved).toMatchObject({ id, name, teamId: team.id });
});

test("a reader cannot open management commands or the team BFF", async ({ page }) => {
  await loginErp(page, "readonly", "/settings/teams");
  await expect(page.getByText("当前账户没有团队管理权限", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "创建团队", exact: true })).toHaveCount(0);
  const response = await page.request.get("/api/teams");
  expect(response.status()).toBe(403);
  const duplicate = await page.request.get("/api/teams?page=1&page=2");
  expect(duplicate.status()).toBe(400);
});
