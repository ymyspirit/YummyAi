/** Personal-browser synthetic admission only. No model, queue consumer or
 * marketplace/factory interaction; every subsequent tested operation is UI. */
import "../../apps/api/node_modules/reflect-metadata/Reflect.js";
import { randomUUID } from "node:crypto";
import { createOrderPiiVault } from "../../apps/api/src/orders/order-pii-vault.js";
import { createIntegrationSecretVault } from "../../apps/api/src/integrations/integration-secret-vault.js";
import { fulfillmentOwnerPorts } from "../../apps/api/src/ai/agent-fulfillment.test-fixture.js";
import { connectDatabase, type DatabaseConnection } from "../../packages/database/src/index.js";
import { TenantContextSchema } from "../../packages/contracts/src/index.js";
import { CreateShipmentInputSchema } from "../../packages/contracts/src/order/shipment.js";
import { requireFulfillmentCommandEnvironment } from "./require-fulfillment-command-environment.mjs";

const send = (message: object) => new Promise<void>((done, reject) => {
  if (!process.connected || !process.send) { reject(new Error("fulfillment_browser_ipc_required")); return; }
  process.send(message, error => error ? reject(error) : done());
});
let database: DatabaseConnection | undefined, phase = "environment";
try {
  const isolated = requireFulfillmentCommandEnvironment(process.env, "current", true), mode = process.argv[2];
  if (!process.connected || !["shipment", "delivery"].includes(mode ?? "")) throw new Error("fulfillment_browser_mode_invalid");
  phase = "identity";
  const response = await fetch(new URL("/v1/identity/session", process.env.API_BASE_URL), {
    headers: { authorization: "Bearer " + process.env.API_ACCESS_TOKEN }, redirect: "error", signal: AbortSignal.timeout(15_000),
  });
  if (response.status !== 200) throw new Error("fulfillment_browser_identity_unavailable");
  const context = TenantContextSchema.parse(await response.json());
  const actor = JSON.parse(process.env.ERP_FIXTURE_ACTORS!).operator;
  if (context.userId !== actor.userId || context.tenantId !== actor.tenantId) throw new Error("fulfillment_browser_original_actor_mismatch");
  database = connectDatabase(isolated.url);
  const owners = fulfillmentOwnerPorts(database, createOrderPiiVault(), createIntegrationSecretVault());
  phase = "seed"; const scene = await owners.seed(context, [3]); let shipmentId: string | null = null;
  if (mode === "shipment") {
    phase = "quality"; await owners.quality(context, scene, 3);
    const sources = await owners.shipping.productionSources(context, scene.order.id), source = sources.find(row => row.availableQuantity >= 3 && !row.blockers.length);
    if (!source?.qualityInspectionId) throw new Error("fulfillment_browser_original_quality_source_missing");
    phase = "shipment";
    const input = CreateShipmentInputSchema.parse({ shipDate: await owners.clock(context), shipFromCountryCode: "US", idempotencyKey: randomUUID(),
      packages: [{ packageReferenceId: "SYNTHETIC-BROWSER-" + randomUUID(), trackingNumber: "SYNTHETIC-BROWSER-TRACK-" + randomUUID(), carrierCode: "SYNTHETIC",
        carrierName: "Synthetic original browser carrier", carrierService: "Synthetic fixture service", lines: [{ orderLineId: source.orderLineId, quantity: 3,
          productionAllocations: [{ productionOrderId: source.productionOrderId, productionVersionId: source.productionVersionId, qualityInspectionId: source.qualityInspectionId,
            qualityGroupId: source.qualityGroupId, expectedProductionProjectionVersion: source.projectionVersion, quantity: 3 }] }] }] });
    shipmentId = (await owners.shipping.create(context, scene.order.id, input)).shipment.id;
  }
  const result = { type: "fulfillment.browser.seeded", mode, orderId: scene.order.id, lineId: scene.productions[0]!.lineId,
    productionId: scene.productions[0]!.order.id, packageId: scene.packet.id, shipmentId, orderNumber: scene.order.externalOrderId,
    resourcesClosed: true, modelCalls: 0, workerProcesses: 0 };
  phase = "cleanup"; await database.client.end(); database = undefined; await send(result);
} catch (error) {
  const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" && /^[A-Z0-9_]{1,64}$/.test(error.code) ? error.code : null;
  await send({ type: "fulfillment.browser.failed", phase, errorName: error instanceof Error ? error.name : "Error", code }).catch(() => {});
  process.exitCode = 1;
} finally { await database?.client.end(); if (process.connected) process.disconnect(); }
