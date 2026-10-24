import { syntheticSpecificationFacts } from "../../../tools/testing/specification-fixtures.js";
import { randomUUID } from "node:crypto";
import { Permission } from "../../../packages/authz/src/index";
import { createEnvironmentSecretVault } from "../../../packages/ai-core/src/environment-vault";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import type { ProductSpuView, SpecificationView } from "@yummyai/contracts/catalog/development";
import {
  SalesPlanFieldsSchema,
  type SalesPlanView,
  type SalesPlanDetail,
} from "@yummyai/contracts/catalog/sales-plan";
import type { ProductVisualWorkspace } from "@yummyai/contracts/catalog/product-visuals";
import { assetFiles, connectDatabase, withTenant } from "@yummyai/database";
import { createStorageFromEnvironment } from "@yummyai/storage";
import type { JobEnvelope } from "../../../packages/jobs/src/contracts";
import { StudioGenerationProcessor } from "../../worker/src/processors/studio-generation.processor";
import { centerApi, createCenterProfile } from "./order-centers-fixture";
import { syntheticProductionPng } from "./production-editor-fixture";
import { getApiHeaders } from "../src/server-api";

/** Only usable with the disposable runner. Real HTTP services, private storage,
 * tenant transactions and production template review; model transport is injected. */
export async function productVisualsFixture() {
  const url = new URL(process.env.DATABASE_URL ?? "postgres://invalid/invalid");
  if (
    process.env.E2E_ISOLATED_DAILY !== "1" ||
    !/^\/order_daily_e2e_[a-f0-9]{32}$/.test(url.pathname)
  )
    throw new Error("Visual fixture requires disposable resources");
  const database = connectDatabase(url.href),
    storage = createStorageFromEnvironment(),
    headers = await getApiHeaders();
  const claims = JSON.parse(
    Buffer.from(headers.authorization!.split(".")[1]!, "base64url").toString(),
  ) as { sub: string };
  const [identity] = await database.client.unsafe<{ tenant_id: string; user_id: string }[]>(
    "select m.tenant_id,m.user_id from memberships m join app_users u on u.id=m.user_id where u.oidc_subject=$1 and m.status='active'",
    [claims.sub],
  );
  if (!identity) {
    await database.client.end();
    throw new Error("Visual fixture identity missing");
  }
  const context: TenantContext = {
    tenantId: identity.tenant_id,
    userId: identity.user_id,
    permissions: Object.values(Permission),
    dataScope: "tenant",
  };
  const ids: Record<string, string[]> = {
    plans: [],
    products: [],
    assets: [],
    generations: [],
    groups: [],
    listings: [],
  };
  let calls = 0;
  try {
    const suffix = `VIS-${randomUUID().slice(0, 8)}`,
      profile = await createCenterProfile("shaped_pillow", suffix, false);
    const { spu } = await centerApi<{ spu: ProductSpuView }>("product-development/spus", {
      code: suffix,
      name: "Synthetic controlled custom pillow",
      idempotencyKey: randomUUID(),
    });
    ids.products.push(spu.productPlanId);
    const { specification: spec } = await centerApi<{ specification: SpecificationView }>(
      "product-development/specifications",
      {
        spuId: spu.id,
        code: "ONE",
        name: "Synthetic 10 inch pillow",
        attributes: { size: "10 inch" },
        facts: syntheticSpecificationFacts({
          material: "Synthetic fabric",
          dimensions: "10 inch synthetic pillow",
          packageContents: "One synthetic pillow, single printed front and white back",
          packageQuantity: 1,
          factsConfirmed: true,
        }),
        processProfileVersionId: profile.versionId,
        expectedVersion: 0,
        idempotencyKey: randomUUID(),
      },
    );
    const sku = await centerApi<{ id: string }>("products/skus", {
      spuId: spu.id,
      code: `${suffix}-SKU`,
      attributes: { size: "10 inch" },
    });
    const sample = createEntityId(),
      bytes = syntheticProductionPng(1024);
    const stored = await storage.putPrivate(context, {
      domain: "authorized",
      fileName: `${suffix}-synthetic-owned-photo.png`,
      mediaType: "image/png",
      body: bytes,
    });
    ids.assets.push(sample);
    await withTenant(database.db, context, (tx) =>
      tx
        .insert(assetFiles)
        .values({
          id: sample,
          tenantId: context.tenantId,
          ...stored,
          assetDomain: "authorized",
          fileName: `${suffix}-synthetic-owned-photo.png`,
          mediaType: "image/png",
          byteSize: bytes.length,
          rightsStatus: "approved",
          rightsMetadata: {
            source: { kind: "owned" },
            fixture: "synthetic-visual-only-not-a-real-pillow",
          },
        }),
    );
    const { plan } = await centerApi<{ plan: SalesPlanView }>("sales-plans", {
      spuId: spu.id,
      fields: SalesPlanFieldsSchema.parse({
        name: `${suffix} synthetic pillow`,
        mode: "custom",
        fulfillment: "fbm",
        specificationIds: [spec.id],
        skuIds: [sku.id],
        positioning: "Synthetic original geometric pillow; retain the sample silhouette and print",
        title: "Synthetic Custom Pillow",
        bullets: [
          "Synthetic personalized print",
          "One synthetic pillow",
          "Synthetic fabric",
          "Single printed front",
          "Synthetic name field",
        ],
        description:
          "Synthetic disposable custom pillow fixture for application acceptance. It validates catalog delivery and version control only.",
        mainImageId: sample,
        mediaAssetIds: [sample],
        customization: {
          version: 1,
          fields: [
            {
              key: "name",
              label: "Name",
              type: "short_text",
              required: true,
              validation: { maxLength: 20 },
              helpText: "Synthetic field",
            },
          ],
        },
        customInstructions: "Enter a name up to 20 characters.",
      }),
      idempotencyKey: randomUUID(),
    });
    ids.plans.push(plan.id);
    const models = (
      await centerApi<ProductVisualWorkspace>(`sales-plans/${plan.id}/launch/visuals`)
    ).models;
    const model = models[0];
    if (!model) throw new Error("Synthetic model missing");
    const vault = createEnvironmentSecretVault(
      "MODEL_CREDENTIAL_ENCRYPTION_KEY",
      "yummyai:model-config",
    );
    return {
      planId: plan.id,
      plan,
      sample,
      modelId: model.id,
      ids,
      get calls() {
        return calls;
      },
      async workspace() {
        return centerApi<ProductVisualWorkspace>(`sales-plans/${plan.id}/launch/visuals`);
      },
      async detail() {
        return centerApi<SalesPlanDetail>(`sales-plans/${plan.id}`);
      },
      async process(id: string, fault?: "provider" | "opaque" | "small") {
        ids.generations.push(id);
        const processor = new StudioGenerationProcessor(
          database,
          storage,
          vault,
          {
            generate: async (request) => {
              calls++;
              if (fault === "provider") throw new Error("synthetic-private-provider-message");
              return {
                bytes: syntheticProductionPng(
                  fault === "small" ? 256 : 1024,
                  request.input.background === "transparent" && fault !== "opaque",
                ),
                mediaType: "image/png",
              };
            },
          },
          {
            scan: async () => ({
              result: "clean",
              engine: "synthetic",
              signatureVersion: "fixture",
              scannedAt: new Date().toISOString(),
            }),
          },
        );
        const envelope: JobEnvelope = {
          jobId: id,
          correlationId: id,
          idempotencyKey: id,
          traceId: "synthetic-visual-browser",
          tenantId: context.tenantId,
          requestedBy: context.userId,
          requestedAt: new Date().toISOString(),
          attempt: 0,
          maxAttempts: 1,
          payload: { generationId: id },
        };
        await processor.process(envelope);
      },
      async close() {
        await database.client.end();
      },
    };
  } catch (error) {
    await database.client.end();
    throw error;
  }
}
