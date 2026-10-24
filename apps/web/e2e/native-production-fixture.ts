import { Permission } from "@yummyai/authz";
import { createEntityId, type TenantContext, type MarketplaceAccountView } from "@yummyai/contracts";
import { requireDisposableIntegrationEnvironment } from "../../../tools/testing/require-disposable-integration.mjs";
import { syntheticSupplierProfile } from "../../../tools/testing/factory-fixtures";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { syntheticNativeProductionOrder } from "../../api/src/orders/native-production.test-fixture";
import { actors } from "./erp-identity-fixture";
import { centerApi } from "./order-centers-fixture";
import { createFactoryFixture } from "./factory-directory-fixture";
import { syntheticProductionPng } from "./production-editor-fixture";
import { createCapacityFixture } from "./factory-capacity-fixture";

/** Disposable source/approval fixtures. The browser performs the real personal production command; no factory is contacted. */
export async function prepareNativeProduction() {
  requireDisposableIntegrationEnvironment(); const actor = actors().operator;
  const context: TenantContext = { tenantId: actor.tenantId, userId: actor.userId, permissions: Object.values(Permission), dataScope: "tenant" };
  const suffix = createEntityId().slice(-8), externalId = `E2E-NATIVE-${suffix}`;
  const account = await centerApi<MarketplaceAccountView>("marketplace-accounts", { platform: "etsy", displayName: externalId, region: "GLOBAL", marketplaceIds: ["etsy"], authorizationMode: "etsy_oauth", requestedScopes: [] });
  const supplier = await centerApi<{ id: string }>("sourcing/suppliers", { name: `Synthetic native supplier ${suffix}`, kind: "manual", regionCode: "US", settlementCurrency: "USD", profile: syntheticSupplierProfile });
  const factory = await createFactoryFixture(supplier.id, "rectangular_print", `Synthetic native factory ${suffix}`);
  const capacity = await createCapacityFixture(factory.factory, [factory.capability], 30);
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const output = execFileSync(process.execPath, ["--import", "./apps/api/node_modules/tsx/dist/loader.mjs", "tools/testing/native-production-source.mts"], {
    cwd: root, env: { ...process.env, TSX_TSCONFIG_PATH: fileURLToPath(new URL("../../api/tsconfig.json", import.meta.url)) },
    input: JSON.stringify({ context, accountId: account.id, supplierId: supplier.id, externalId, sourcePngBase64: syntheticProductionPng().toString("base64") }),
    encoding: "utf8", timeout: 45000, maxBuffer: 1024 * 1024, windowsHide: true,
  });
  const record = output.split(/\r?\n/).filter(line => line.startsWith('{"nativeProductionFixture":')).at(-1);
  if (!record) throw Error("Synthetic native fixture did not produce a source receipt");
  const product = (JSON.parse(record) as { nativeProductionFixture: Awaited<ReturnType<typeof syntheticNativeProductionOrder>> }).nativeProductionFixture;
  return { ...product, ...factory.pins, capacity, capacityPlan: capacity.capacityPlan };
}
