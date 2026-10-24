import { expect, test } from "@playwright/test";
import type { ChildProcess } from "node:child_process";
import { centerApi } from "./order-centers-fixture";
import { startProductionEditorWorker } from "./production-editor-fixture";
import { createFactoryDelivery, factoryMembers } from "./factory-portal-fixture";
let worker: ChildProcess | undefined;
test.beforeAll(async () => {
  worker = await startProductionEditorWorker();
});
test.afterAll(async () => {
  worker?.kill();
});
const localFuture = (ms: number) => {
  const d = new Date(Date.now() + ms);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};
test("factory collaboration operator creates a grant, assigns the exact original file and revokes task and grant", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const delivery = await createFactoryDelivery();
  await page.goto(`/suppliers/${delivery.order.supplierId}/factories/${delivery.order.factoryId}`);
  await page.getByRole("link",{name:"管理本工厂的协作授权"}).click();
  await expect(page.getByRole("heading", { name: "工厂协作授权", exact: true })).toBeVisible();
  const create = page.getByRole("form", { name: "建立工厂授权" });
  await create.getByLabel("工厂", { exact: true }).selectOption(delivery.order.factoryId);
  await create.getByLabel("已开通成员").selectOption(factoryMembers().main.membershipId);
  await create.getByLabel("授权有效至").fill(localFuture(86400000));
  await create.getByRole("checkbox").check();
  await create.getByRole("button", { name: "建立授权", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("已保存");
  const row = page
    .getByRole("region", { name: "工厂授权列表" })
    .getByRole("button")
    .filter({ hasText: delivery.order.factoryName });
  await row.click();
  const panel = page.getByRole("region", { name: "授权与文件分配" }),
    assign = panel.getByRole("form", { name: "分配原制作文件" });
  await assign.getByLabel("已生成的原交付文件").selectOption(delivery.item.id);
  await assign.getByLabel("任务有效至").fill(localFuture(3600000));
  await assign.getByRole("button", { name: "分配该文件", exact: true }).click();
  await expect(panel.getByRole("region", { name: "已分配文件" })).toContainText(
    delivery.item.snapshot!.file.checksum,
  );
  const workspace = await centerApi<{
      grants: { id: string; membershipId: string; factoryId: string }[];
    }>("factory-collaboration/workspace"),
    grant = workspace.grants.find(
      (g) =>
        g.membershipId === factoryMembers().main.membershipId &&
        g.factoryId === delivery.order.factoryId,
    )!;
  const tasks = await centerApi<{ items: { id: string; fileChecksum: string }[] }>(
    `factory-collaboration/grants/${grant.id}/work-items`,
  );
  expect(tasks.items).toHaveLength(1);
  expect(tasks.items[0]!.fileChecksum).toBe(delivery.item.snapshot!.file.checksum);
  const revokeTask = panel.getByRole("form", { name: "撤销本文件分配" });
  await revokeTask.getByLabel("撤销原因").fill("Synthetic task handed back to operator");
  await revokeTask.getByRole("button").click();
  await expect(panel.getByRole("region", { name: "已分配文件" })).toContainText("已撤销");
  const revoke = panel.getByRole("form", { name: "撤销整个工厂授权" });
  await revoke.getByLabel("撤销原因").fill("Synthetic factory cooperation ended");
  await revoke.getByRole("button").click();
  await expect(panel.getByRole("form", { name: "撤销整个工厂授权" })).toHaveCount(0);
  await expect(panel.getByRole("form", { name: "分配原制作文件" })).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(()=>{window.scrollTo(0,0);(document.activeElement as HTMLElement|null)?.blur();});
  const heading=await page.getByRole("heading",{name:"工厂协作授权",exact:true}).boundingBox(),mobile=await page.locator(".erp-mobile-bar").boundingBox();expect(heading!.y).toBeGreaterThanOrEqual(mobile!.y+mobile!.height);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("factory-collaboration-mobile.png"),
    fullPage: true,
  });
  expect(errors).toEqual([]);
  expect(
    (await page.request.get("/api/factory-collaboration/workspace?tenantId=ignored")).status(),
  ).toBe(400);
  expect(
    (
      await page.request.post("/api/factory-collaboration/grants", {
        headers: { origin: "https://invalid.example" },
        data: {},
      })
    ).status(),
  ).toBe(403);
  expect((await page.request.get("/api/factory-portal/session")).status()).toBe(404);
});
