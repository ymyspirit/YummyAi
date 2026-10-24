// Owned upstream intake fixture. Browser acceptance still uses real ERP APIs.
// The authenticated local membership supplies identity; callers cannot select a tenant.
import { readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { apiFetch } from "../src/server-api.ts";
import { connectDatabase } from "../../../packages/database/src/index.ts";
import { AuditService } from "../../api/src/audit/audit.service.ts";
import { OrderService } from "../../api/src/orders/order.service.ts";
import { createOrderPiiVault } from "../../api/src/orders/order-pii-vault.ts";
import type { TenantContext } from "@yummyai/contracts";

const path = process.argv[2]!;
const manifest = JSON.parse(readFileSync(path, "utf8"));
const response = await apiFetch(`${process.env.API_BASE_URL}/v1/order-centers/options`, {
  cache: "no-store",
});
if (!response.ok) throw new Error("Fixture membership could not be verified");
const { preferenceScope } = (await response.json()) as { preferenceScope: string };
const [tenantId, userId] = preferenceScope.split(":");
const context: TenantContext = {
  tenantId: tenantId!,
  userId: userId!,
  permissions: ["order:read", "order:write"],
  dataScope: "tenant",
};
const database = connectDatabase(),
  vault = createOrderPiiVault();
try {
  const order = await new OrderService(
    database,
    vault,
    new AuditService(database),
  ).ingestNormalized(context, {
    accountId: manifest.fixtures.accountId,
    platform: "amazon",
    externalEventId: randomUUID(),
    externalOrderId: manifest.externalId,
    providerStatus: "Unshipped",
    placedAt: new Date().toISOString(),
    orderTotal: null,
    protectedDetails: null,
    redactedSource: { fixture: true },
    lines: ["pillow", "tire", "unknown"].map((kind) => ({
      externalLineId: `${kind}-${manifest.suffix}`,
      externalListingId: null,
      skuCode: null,
      title: `QA ${kind} synthetic order`,
      quantity: 1,
      unitPrice: null,
      customizationCount: 0,
    })),
  });
  manifest.fixtures.orderId = order.id;
  manifest.fixtures.lines = order.lines.map((line) => ({
    id: line.id,
    externalLineId: line.externalLineId,
  }));
  writeFileSync(path, JSON.stringify(manifest, null, 2));
  process.stdout.write(JSON.stringify({ orderId: order.id, lines: manifest.fixtures.lines }));
} finally {
  await database.client.end();
}
