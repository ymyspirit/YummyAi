import { syntheticSpecificationFacts } from "../../../tools/testing/specification-fixtures.js";
import { randomUUID } from "node:crypto";
import { expect } from "@playwright/test";
import {
  type ProductionEditorDetailView,
  type ProductionEditorImageView,
} from "@yummyai/contracts";
import type { PrintProfileView } from "@yummyai/contracts/order/workspace";
import { CANVAS_BRIDGE } from "@yummyai/contracts/pod/canvas-bridge";
import type { SalesRecipeView } from "@yummyai/contracts/catalog/development";
import type { DesignAutomationRecipe } from "@yummyai/contracts/pod/design-automation";
import { apiFetch } from "../src/server-api";
import type { ProductionKind } from "../src/features/production-editor/production-editor-model";
import { productionExportDefaults } from "@yummyai/production-editor/products";
import { createSyntheticCenterDocument, placeSyntheticCenterImage, productionEditorFixtureFailureDiagnostic,
  startProductionEditorWorker, stopProductionEditorWorker, syntheticProductionPng, type SyntheticCenterOptions } from "./production-editor-fixture";

export async function centerApi<T>(path: string, input?: unknown): Promise<T> {
  const response = await apiFetch(
    `${process.env.API_BASE_URL}/v1/${path}`,
    input === undefined
      ? {}
      : {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        },
  );
  expect(response.ok, response.ok ? "Fixture API request succeeded" : productionEditorFixtureFailureDiagnostic(path, response.status, await readFixtureFailure(response))).toBe(true);
  return response.json() as Promise<T>;
}

/** Failure evidence is bounded and classified; no upstream body is logged. */
async function readFixtureFailure(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength;
      if (size > 8192) { await reader.cancel(); return null; }
      chunks.push(part.value);
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))) as unknown;
  } catch { return null; }
  finally { reader.releaseLock(); }
}

/** Creates a physical SPU through the authenticated catalog API. */
export async function createCenterSpu(code: string) {
  return (
    await centerApi<{ spu: { id: string } }>("product-development/spus", {
      code,
      name: code,
      idempotencyKey: randomUUID(),
    })
  ).spu;
}

/** Synthetic approved library asset, created through the ordinary authenticated API. */
export async function createCenterProfile(
  kind: ProductionKind,
  suffix: string,
  withSalesRecipe = true,
  automation?: DesignAutomationRecipe,
  options?: SyntheticCenterOptions,
) {
  const document = createSyntheticCenterDocument(kind, options);
  document.name = `E2E Centers template ${suffix}`;
  if (automation) document.automation = automation;
  let template = await centerApi<ProductionEditorDetailView>("production-editor/projects", {
    name: document.name,
    document,
  });
  const asset = await centerApi<ProductionEditorImageView>(
    `production-editor/projects/${template.project.id}/images`,
    {
      name: "synthetic-template.png",
      contentBase64: syntheticProductionPng(kind === "shaped_pillow" ? 2048 : 512).toString(
        "base64",
      ),
    },
  );
  document.layers = [placeSyntheticCenterImage(document, asset)];
  // These confirmations describe only the known synthetic geometry and pixels.
  // The real review owner still checks the exact uploaded file and fixed recipe.
  document.confirmations = { physicalSize: true, whiteBorderRule: true, narrowParts: true, barcodeTab: true, backText: true, visualReview: true };
  template = await centerApi<ProductionEditorDetailView>(
    `production-editor/projects/${template.project.id}/versions`,
    { expectedVersionId: template.version.id, document },
  );
  await centerApi(`production-editor/projects/${template.project.id}/review`, {
    expectedVersionId: template.version.id,
  });
  const profiles = await centerApi<PrintProfileView[]>("order-centers/profiles", {
    code: `E2E-${suffix}`,
    name: document.name,
    projectId: template.project.id,
    versionId: template.version.id,
    instructions: "Synthetic factory specification",
    expectedVersion: 0,
    idempotencyKey: randomUUID(),
  });
  const profile = profiles.find((profile) => profile.code === `E2E-${suffix}`)!;
  if (!withSalesRecipe) return { ...profile, recipeId: "", adaptation: null, manufacturingSource: null };
  const brief = await centerApi<{ id: string }>("canvas-bridge/briefs", {
    requestId: randomUUID(),
    name: `E2E Master ${suffix}`,
    prompt: "Synthetic original artwork",
    referenceAssetIds: [],
  });
  const result = await centerApi<{ versionId: string }>(
    `canvas-bridge/briefs/${brief.id}/results`,
    {
      submissionId: randomUUID(),
      protocolVersion: 1,
      pluginVersion: CANVAS_BRIDGE.pluginVersion,
      upstreamVersion: CANVAS_BRIDGE.upstreamVersion,
      sourceNodeId: randomUUID(),
      title: `E2E Master ${suffix}`,
      contentBase64: syntheticProductionPng(kind === "shaped_pillow" ? 2048 : 512).toString(
        "base64",
      ),
      rightsAttested: true,
      sourceKind: "owned",
      sourceReference: "Synthetic E2E fixture",
    },
  );
  await centerApi(`pod/creative-design-versions/${result.versionId}/review`, {
    decision: "approve",
  });
  const { artwork } = await centerApi<{ artwork: { versionId: string } }>(
    "product-development/artworks",
    {
      code: `ART-${suffix}`,
      name: `E2E Print ${suffix}`,
      mode: "fixed",
      creativeVersionId: result.versionId,
      expectedVersion: 0,
      idempotencyKey: randomUUID(),
    },
  );
  const spu = await createCenterSpu(`SPU-${suffix}`);
  const { specification } = await centerApi<{ specification: { id: string; versionId: string } }>(
    "product-development/specifications",
    {
      spuId: spu.id,
      code: "DEFAULT",
      name: "Synthetic specification",
      attributes: { size: "fixture" },
      facts: syntheticSpecificationFacts({
        material: "Synthetic fabric",
        dimensions: kind === "tire_cover" ? "50 mm" : document.productType === "shaped_pillow" ? `${document.spec.declaredLongestMm} mm synthetic artwork longest side` : "254 mm synthetic test panel",
        ...(document.productType === "shaped_pillow" ? {
          physicalDimensions: { basis: "artwork_longest" as const, unit: "mm" as const, length: document.spec.declaredLongestMm, width: null, height: null },
        } : {}),
        packageContents: "One item",
        packageQuantity: 1,
        factsConfirmed: true,
      }),
      processProfileVersionId: profile.versionId,
      expectedVersion: 0,
      idempotencyKey: randomUUID(),
    },
  );
  const combination = await centerApi<{ recipes: SalesRecipeView[] }>(
    "product-development/combinations",
    {
      artworkVersionId: artwork.versionId,
      items: [{ specificationVersionId: specification.versionId, skuCode: `SALE-${suffix}` }],
      idempotencyKey: randomUUID(),
    },
  );
  const { recipe } = await centerApi<{ recipe: SalesRecipeView }>(
    `product-development/recipes/${combination.recipes[0]!.id}/actions`,
    { action: "start_adaptation", reason: "Synthetic adaptation", idempotencyKey: randomUUID() },
  );
  let project = await centerApi<ProductionEditorDetailView>(
    `production-editor/projects/${recipe.editorProjectId}`,
  );
  if (project.version.document.productType === "shaped_pillow") {
    const layers = project.version.document.layers, originalLayer = layers[0];
    if (layers.length !== 1 || !originalLayer || originalLayer.kind !== "image") throw new Error("Synthetic center adaptation must retain its one known artwork");
    const imported = project.images.find(image => image.id === originalLayer.assetId);
    if (!imported) throw new Error("Synthetic center adaptation source was not returned by the original owner");
    project.version.document.layers = [placeSyntheticCenterImage(project.version.document, imported)];
  }
  project.version.document.confirmations.visualReview = true;
  project = await centerApi<ProductionEditorDetailView>(
    `production-editor/projects/${project.project.id}/versions`,
    { expectedVersionId: project.version.id, document: project.version.document },
  );
  await centerApi(`production-editor/projects/${project.project.id}/review`, {
    expectedVersionId: project.version.id,
  });
  const worker = await startProductionEditorWorker();
  try {
    const render = await centerApi<{ id: string }>(
      `production-editor/projects/${project.project.id}/renders`,
      {
        expectedVersionId: project.version.id,
        purpose: "production",
        ...productionExportDefaults(project.version.document),
      },
    );
    await expect
      .poll(
        async () => {
          const detail = await centerApi<ProductionEditorDetailView>(
            `production-editor/projects/${project.project.id}`,
          );
          return detail.renders.find((r) => r.id === render.id)?.status;
        },
        { timeout: 60000 },
      )
      .toBe("completed");
    await centerApi(`product-development/recipes/${recipe.id}/actions`, {
      action: "approve_adaptation",
      expectedEditorVersionId: project.version.id,
      renderId: render.id,
      reason: "Reviewed synthetic art and process",
      idempotencyKey: randomUUID(),
    });
    return { ...profile, recipeId: recipe.id, adaptation: { projectId: project.project.id, versionId: project.version.id, renderId: render.id },
      manufacturingSource: { spuId: spu.id, specificationId: specification.id, specificationVersionId: specification.versionId } };
  } finally {
    await stopProductionEditorWorker(worker);
  }
}
