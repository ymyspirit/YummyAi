import { readFileSync } from "node:fs";
import { requireDisposableIntegrationEnvironment } from "./require-disposable-integration.mjs";
import { syntheticNativeProductionOrder } from "../../apps/api/src/orders/native-production.test-fixture.js";
import type { TenantContext } from "@yummyai/contracts";

requireDisposableIntegrationEnvironment();
const text = readFileSync(0, "utf8");
if (text.length > 2 * 1024 * 1024) throw Error("Synthetic native fixture input is too large");
const input = JSON.parse(text) as { context: TenantContext; accountId: string; supplierId: string; externalId: string; sourcePngBase64: string };
const result = await syntheticNativeProductionOrder(input.context, { ...input, sourcePng: Buffer.from(input.sourcePngBase64, "base64") });
process.stdout.write(JSON.stringify({ nativeProductionFixture: result }) + "\n");
