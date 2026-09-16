import { randomUUID } from "node:crypto";
import { expect } from "@playwright/test";
import {
  type ProductionEditorDetailView,
  type ProductionEditorImageView,
} from "@yummyai/contracts";
import type { PrintProfileView } from "@yummyai/contracts/order/workspace";
import { CANVAS_BRIDGE } from "@yummyai/contracts/pod/canvas-bridge";
import type { SalesRecipeView } from "@yummyai/contracts/catalog/development";
import { apiFetch } from "../src/server-api";
import {
  createProductionDocument,
  newProductionImage,
  type ProductionKind,
} from "../src/features/production-editor/production-editor-model";
import { startProductionEditorWorker, syntheticProductionPng } from "./production-editor-fixture";

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
  expect(response.ok, `${path}: HTTP ${response.status}`).toBe(true);
  return response.json() as Promise<T>;
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
) {
  const document = createProductionDocument(kind);
  document.name = `E2E Centers template ${suffix}`;
  if (document.productType === "tire_cover")
    document.spec = { ...document.spec, diameterMm: 50, dpi: 150, safeInsetMm: 2 };
  else {
    document.spec = {
      ...document.spec,
      widthMm: 254,
      heightMm: 254,
      declaredLongestMm: 254,
      sizeBasis: "cut_contour",
      minimumNeckBasis: "cut_contour",
      whiteBorderMm: 5,
      barcodeTab: { widthMm: 40, heightMm: 20, centerXMm: 127 },
      sideMode: "single",
    };
    document.contour = [
      { xMm: 0, yMm: 0, smooth: false },
      { xMm: 254, yMm: 0, smooth: false },
      { xMm: 254, yMm: 254, smooth: false },
      { xMm: 0, yMm: 254, smooth: false },
    ];
  }
  for (const key of Object.keys(document.confirmations) as Array<
    keyof typeof document.confirmations
  >)
    document.confirmations[key] = true;
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
  document.layers = [newProductionImage(document, asset)];
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
  if (!withSalesRecipe) return { ...profile, recipeId: "" };
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
  const { specification } = await centerApi<{ specification: { versionId: string } }>(
    "product-development/specifications",
    {
      spuId: spu.id,
      code: "DEFAULT",
      name: "Synthetic specification",
      attributes: { size: "fixture" },
      facts: {
        material: "Synthetic fabric",
        dimensions: kind === "tire_cover" ? "50 mm" : "254 mm synthetic test panel",
        packageContents: "One item",
        packageQuantity: 1,
        factsConfirmed: true,
      },
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
        format: "png",
        background: "transparent",
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
  } finally {
    worker.kill();
  }
  return { ...profile, recipeId: recipe.id };
}
