import { randomUUID } from "node:crypto";
import { expect, type Page } from "@playwright/test";
import type { ProductionDeliveryWorkspace } from "@yummyai/contracts/order/production-delivery";
import type { FactoryWorkItemView } from "@yummyai/contracts/suppliers/factory-portal";
import { centerApi } from "./order-centers-fixture";
import { prepareDeliveryOrder } from "./production-delivery-fixture";

export function factoryMembers() {
  return JSON.parse(process.env.FACTORY_FIXTURE_MEMBERS!) as Record<
    "main" | "reader" | "other",
    { membershipId: string; userId: string; name: string }
  >;
}
export async function factoryControl(path: string, input?: Record<string, string>) {
  const response = await fetch(`${process.env.FACTORY_IDENTITY_FIXTURE_URL}/_fixture/${path}`, {
    method: input ? "POST" : "GET",
    headers: { "x-fixture-control": process.env.FACTORY_FIXTURE_CONTROL_TOKEN! },
    body: input ? new URLSearchParams(input) : undefined,
  });
  expect(response.ok).toBe(true);
  return response.json();
}
export async function factoryToken(account: "main" | "reader" | "other") {
  return (await factoryControl("token", { account })).access_token as string;
}
export async function loginFactory(page: Page, account: "main" | "reader" | "other" = "main") {
  await page.goto("/factory-work-items");
  await page.getByRole("link", { name: "登录协作", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Synthetic identity fixture" })).toBeVisible();
  await page.getByLabel("Test account").selectOption(account);
  await page.getByRole("button", { name: "Continue synthetic login" }).click();
  await expect(page).toHaveURL(/\/factory-work-items$/);
  await expect(page.getByRole("button", { name: "退出协作" })).toBeVisible();
}
export async function createFactoryDelivery() {
  const order = await prepareDeliveryOrder(),
    workspace = await centerApi<ProductionDeliveryWorkspace>(
      `order-centers/deliveries?factory=${order.factoryId}`,
    ),
    candidate = workspace.candidates.find((row) => row.orderLineId === order.lines[0])!;
  expect(candidate.blockers).toEqual([]);
  const packet = await centerApi<ProductionDeliveryWorkspace["packages"][number]>(
    "order-centers/deliveries",
    {
      factoryId: order.factoryId,
      supplierId: order.supplierId,
      items: [
        {
          productionOrderId: candidate.productionOrderId,
          expectedProjectionVersion: candidate.projectionVersion,
          productionVersionId: candidate.productionVersionId,
        },
      ],
      idempotencyKey: randomUUID(),
    },
  );
  return { order, packet, item: packet.items[0]! };
}
export async function assignFactoryFile(
  delivery: Awaited<ReturnType<typeof createFactoryDelivery>>,
  account: "main" | "reader" = "main",
  canRespond = true,
) {
  const grant = await centerApi<{ id: string }>("factory-collaboration/grants", {
    factoryId: delivery.order.factoryId,
    membershipId: factoryMembers()[account].membershipId,
    canRespond,
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    idempotencyKey: randomUUID(),
  });
  const assignment = await centerApi<{ id: string }>(
    `factory-collaboration/grants/${grant.id}/work-items`,
    {
      deliveryItemId: delivery.item.id,
      fileChecksum: delivery.item.snapshot!.file.checksum,
      packageChecksum: delivery.packet.checksum,
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      idempotencyKey: randomUUID(),
    },
  );
  return { grant, assignment };
}
export async function personalFactoryTask(assignmentId: string, token: string) {
  const response = await fetch(
    `${process.env.API_BASE_URL}/v1/factory-portal/work-items/${assignmentId}`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  expect(response.status).toBe(200);
  return response.json() as Promise<FactoryWorkItemView>;
}
