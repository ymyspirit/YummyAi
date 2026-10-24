import { syntheticSpecificationFacts } from "../../../tools/testing/specification-fixtures.js";
import { createHash, randomUUID } from "node:crypto";
import { Permission } from "../../../packages/authz/src/index";
import {
  CaptureDraftSchema,
  createEntityId,
  type TenantContext,
  type ProductionEditorDetailView,
  type ProductionEditorImageView,
} from "@yummyai/contracts";
import { SalesPlanFieldsSchema, type SalesPlanDetail } from "@yummyai/contracts/catalog/sales-plan";
import type {
  ArtworkView,
  ProductSpuView,
  SpecificationView,
  SalesRecipeView,
} from "@yummyai/contracts/catalog/development";
import type { PrintProfileView } from "@yummyai/contracts/order/workspace";
import {
  connectDatabase,
  withTenant,
  assetFiles,
  designTasks,
  designVersions,
  designVersionFiles,
  salesRecipeVersions,
  mockupTemplateSourceInspections,
  mockupTemplatePackVersions,
  mockupTemplateSlots,
  mockupBatches,
  mockupBatchItems,
  mockupBatchOutputs,
} from "@yummyai/database";
import { createStorageFromEnvironment } from "@yummyai/storage";
import { eq } from "drizzle-orm";
import JSZip from "jszip";
import { centerApi, createCenterProfile } from "./order-centers-fixture";
import { apiFetch, getApiHeaders } from "../src/server-api";
import { syntheticProductionPng } from "./production-editor-fixture";
import {
  createProductionDocument,
  newProductionImage,
} from "../src/features/production-editor/production-editor-model";
import type { ListingService } from "../../api/src/listings/listing.service";
type ListingState = Awaited<ReturnType<ListingService["getWorkspace"]>>;

/** Disposable upstream assets represent already-reviewed design/mockup outputs.
 * Analysis, adoption, listing versioning, approval, sealing and ZIP reads below
 * use real services. This is neither seller publication nor a factory release. */
export async function salesLaunchFixture(options: { pillow?: boolean; orderIntake?: boolean } = {}) {
  const url = new URL(process.env.DATABASE_URL ?? "postgres://invalid/invalid");
  if (
    process.env.E2E_ISOLATED_DAILY !== "1" ||
    !/^\/order_daily_e2e_[a-f0-9]{32}$/.test(url.pathname)
  )
    throw new Error("Sales launch requires disposable acceptance resources");
  const database = connectDatabase(url.href),
    storage = createStorageFromEnvironment();
  const headers = await getApiHeaders();
  const claims = JSON.parse(
    Buffer.from(headers.authorization!.split(".")[1]!, "base64url").toString(),
  ) as { sub: string };
  const [identity] = await database.client.unsafe<{ tenant_id: string; user_id: string }[]>(
    "select m.tenant_id,m.user_id from memberships m join app_users u on u.id=m.user_id where u.oidc_subject=$1 and m.status='active'",
    [claims.sub],
  );
  if (!identity) {
    await database.client.end();
    throw new Error("Fixture identity missing");
  }
  const context: TenantContext = {
    tenantId: identity.tenant_id,
    userId: identity.user_id,
    permissions: Object.values(Permission),
    dataScope: "tenant",
  };
  const suffix = randomUUID().slice(0, 8),
    code = `QA-LAUNCH-${suffix}`;
  const ids: Record<string, string[]> = {
    plans: [],
    listings: [],
    research: [],
    products: [],
    profiles: [],
    templates: [],
    artworks: [],
    assets: [],
    packages: [],
  };
  async function owned(name: string) {
    name = `${suffix}-${name}`;
    const bytes = syntheticProductionPng();
    const stored = await storage.putPrivate(context, {
      domain: "authorized",
      fileName: name,
      mediaType: "image/png",
      body: bytes,
    });
    const id = createEntityId();
    ids.assets.push(id);
    await withTenant(database.db, context, (tx) =>
      tx.insert(assetFiles).values({
        id,
        tenantId: context.tenantId,
        ...stored,
        assetDomain: "authorized",
        fileName: name,
        mediaType: "image/png",
        byteSize: bytes.length,
        rightsStatus: "approved",
        rightsMetadata: { source: { kind: "self_created" }, fixture: "sales-launch-disposable" },
      }),
    );
    return { id, bytes, checksum: stored.checksumSha256 };
  }
  try {
    const capturedAt = new Date().toISOString(),
      externalId = String(Date.now());
    const source = await centerApi<{ researchItemId: string; snapshotId: string }>(
      "captures",
      CaptureDraftSchema.parse({
        platform: "etsy",
        parserVersion: "etsy@1.0.0",
        extensionVersion: "0.0.0",
        marketplace: "www.etsy.com",
        sourceUrl: `https://www.etsy.com/listing/${externalId}/synthetic-launch-fixture`,
        externalId,
        title: `Synthetic launch research ${suffix}`,
        domain: "research",
        capturedAt,
        price: null,
        rating: null,
        reviewCount: null,
        taxonomy: [],
        listingPublishedAt: null,
        favoriteCount: null,
        shipping: null,
        shop: null,
        reviewSummary: null,
        reviews: [],
        reviewCollection: {
          collectedCount: 0,
          reportedTotal: null,
          pageCount: 0,
          status: "visible",
          updatedAt: capturedAt,
        },
        bullets: ["Synthetic personalization reference"],
        variants: [],
        productInformation: [],
        contentBlocks: [],
        missingFields: [],
        diagnostics: [],
        captureStatus: "partial",
        media: [],
      }),
    );
    ids.research.push(source.researchItemId);
    let profile: PrintProfileView;
    if (options.pillow) {
      profile = await createCenterProfile("shaped_pillow", code, false);
      ids.profiles.push(profile.id);
    } else {
      const document = createProductionDocument("rectangular_print");
      document.name = `${code} synthetic process`;
      document.spec = { ...document.spec, widthMm: 60, heightMm: 40, dpi: 150, safeInsetMm: 2 };
      for (const key of Object.keys(document.confirmations) as Array<
        keyof typeof document.confirmations
      >)
        document.confirmations[key] = true;
      let template = await centerApi<ProductionEditorDetailView>("production-editor/projects", {
        name: document.name,
        document,
      });
      ids.templates.push(template.project.id);
      const image = await centerApi<ProductionEditorImageView>(
        `production-editor/projects/${template.project.id}/images`,
        { name: "synthetic-panel.png", contentBase64: syntheticProductionPng().toString("base64") },
      );
      document.layers = [newProductionImage(document, image)];
      template = await centerApi<ProductionEditorDetailView>(
        `production-editor/projects/${template.project.id}/versions`,
        { expectedVersionId: template.version.id, document },
      );
      await centerApi(`production-editor/projects/${template.project.id}/review`, {
        expectedVersionId: template.version.id,
      });
      const profiles = await centerApi<PrintProfileView[]>("order-centers/profiles", {
        code,
        name: document.name,
        projectId: template.project.id,
        versionId: template.version.id,
        instructions: "Synthetic 60 × 40 mm QA panel; never production",
        expectedVersion: 0,
        idempotencyKey: randomUUID(),
      });
      profile = profiles.find((p) => p.code === code)!;
      ids.profiles.push(profile.id);
    }
    const spu = (
      await centerApi<{ spu: ProductSpuView }>("product-development/spus", {
        code,
        name: `${code} Custom test product`,
        idempotencyKey: randomUUID(),
      })
    ).spu;
    ids.products.push(spu.productPlanId);
    const spec = (
      await centerApi<{ specification: SpecificationView }>("product-development/specifications", {
        spuId: spu.id,
        code: "ONE",
        name: options.pillow ? "Synthetic 10 inch pillow" : "60 × 40 mm",
        attributes: { size: options.pillow ? "10 inch" : "60x40mm" },
        facts: syntheticSpecificationFacts({
          material: "Synthetic fabric",
          dimensions: options.pillow ? "10 inch synthetic pillow" : "60 × 40 mm",
          packageContents: options.pillow
            ? "One synthetic pillow, single front and white back"
            : "One synthetic panel",
          packageQuantity: 1,
          factsConfirmed: true,
        }),
        processProfileVersionId: profile.versionId,
        expectedVersion: 0,
        idempotencyKey: randomUUID(),
      })
    ).specification;
    const master = await owned("synthetic-original-master.png"),
      photo = await owned("synthetic-finished-photo.png"),
      mockup = await owned("synthetic-reviewed-mockup.png");
    const configurationSample = options.pillow
      ? await owned("synthetic-customization-reference.png")
      : null;
    const customization = {
      version: 1 as const,
      fields: [
        {
          key: "name",
          label: "Name",
          type: "short_text" as const,
          required: true,
          validation: { maxLength: 20 },
          helpText: "Synthetic name field",
        },
        ...(options.orderIntake ? [{
          key: "portrait", label: "Portrait", type: "image" as const, required: true,
          validation: { allowedMediaTypes: ["image/png", "image/jpeg"], maxFiles: 1, maxBytes: 5_000_000 },
        }] : []),
      ],
    };
    const artwork = (
      await centerApi<{ artwork: ArtworkView }>("product-development/artworks", {
        code: `${code}-ART`,
        name: "Synthetic original name design",
        mode: "personalized_text",
        instructions: "Synthetic editable name template, reviewed by the upstream fixture only",
        customization,
        expectedVersion: 0,
        idempotencyKey: randomUUID(),
      })
    ).artwork;
    ids.artworks.push(artwork.id);
    const recipe = (
      await centerApi<{ recipes: SalesRecipeView[] }>("product-development/combinations", {
        artworkVersionId: artwork.versionId,
        items: [{ specificationVersionId: spec.versionId, skuCode: `${code}-SKU` }],
        idempotencyKey: randomUUID(),
      })
    ).recipes[0]!;
    // The existing renderer/review suites own upstream acceptance. Supply their
    // pinned approved outputs here without invoking any paid generation.
    const designTask = createEntityId(),
      design = createEntityId(),
      inspection = createEntityId(),
      pack = createEntityId(),
      slot = createEntityId(),
      batch = createEntityId(),
      item = createEntityId(),
      now = new Date();
    await withTenant(database.db, context, async (tx) => {
      await tx.insert(designTasks).values({
        id: designTask,
        tenantId: context.tenantId,
        skuId: recipe.skuId,
        title: "Synthetic approved QA artwork",
        brief: "Disposable upstream fixture",
        status: "approved",
      });
      await tx.insert(designVersions).values({
        id: design,
        tenantId: context.tenantId,
        taskId: designTask,
        versionNumber: 1,
        status: "approved",
        createdBy: context.userId,
        reviewedBy: context.userId,
        reviewedAt: now,
      });
      await tx.insert(designVersionFiles).values({
        id: createEntityId(),
        tenantId: context.tenantId,
        versionId: design,
        assetFileId: master.id,
        role: "production",
      });
      await tx
        .update(salesRecipeVersions)
        .set({ status: "approved", designVersionId: design })
        .where(eq(salesRecipeVersions.id, recipe.id));
      await tx.insert(mockupTemplateSourceInspections).values({
        id: inspection,
        tenantId: context.tenantId,
        sourceAssetId: mockup.id,
        sourceAssetVersion: 1,
        checksumSha256: mockup.checksum,
        slotKey: "hero",
        status: "completed",
        compilerVersion: "synthetic",
        compilation: {
          canvasWidth: 512,
          canvasHeight: 512,
          slotKey: "hero",
          transform: [0, 0, 512, 0, 512, 512, 0, 512],
          backgroundAssetId: mockup.id,
          foregroundAssetId: mockup.id,
          previewAssetId: mockup.id,
          manifestAssetId: mockup.id,
          checksumSha256: mockup.checksum,
          ssimPermille: 1000,
          compilerVersion: "synthetic",
        },
        requestedBy: context.userId,
        confirmedBy: context.userId,
        completedAt: now,
        confirmedAt: now,
      });
      await tx.insert(mockupTemplatePackVersions).values({
        id: pack,
        tenantId: context.tenantId,
        packId: createEntityId(),
        versionNumber: 1,
        name: "Synthetic approved mockup pack",
        platform: "amazon",
        locale: "en-US",
        status: "approved",
        createdBy: context.userId,
        reviewedBy: context.userId,
        reviewedAt: now,
      });
      await tx.insert(mockupTemplateSlots).values({
        id: slot,
        tenantId: context.tenantId,
        templatePackVersionId: pack,
        inspectionId: inspection,
        slotKey: "hero",
        label: "Hero",
        ordinal: 0,
        required: true,
        acceptedPrintSpecVersionIds: [],
      });
      await tx.insert(mockupBatches).values({
        id: batch,
        tenantId: context.tenantId,
        name: "Synthetic reviewed scene",
        templatePackVersionId: pack,
        platform: "amazon",
        locale: "en-US",
        status: "completed",
        itemCount: 1,
        completedCount: 1,
        requestChecksum: createHash("sha256").update(`synthetic-launch:${code}`).digest("hex"),
        createdBy: context.userId,
        completedAt: now,
      });
      await tx.insert(mockupBatchItems).values({
        id: item,
        tenantId: context.tenantId,
        batchId: batch,
        ordinal: 0,
        designVersionId: design,
        skuId: recipe.skuId,
        status: "completed",
        reviewedBy: context.userId,
        reviewedAt: now,
        completedAt: now,
      });
      await tx.insert(mockupBatchOutputs).values({
        id: createEntityId(),
        tenantId: context.tenantId,
        itemId: item,
        templateSlotId: slot,
        slotKey: "hero",
        status: "approved",
        assetId: mockup.id,
        assetVersion: 1,
        checksumSha256: mockup.checksum,
        width: 512,
        height: 512,
        completedAt: now,
      });
    });
    const plan = (
      await centerApi<{ plan: SalesPlanDetail["plan"] }>("sales-plans", {
        spuId: spu.id,
        fields: SalesPlanFieldsSchema.parse({
          name: `${code} sales plan`,
          mode: "custom",
          fulfillment: "fbm",
          audience: "Synthetic original buyers",
          scenario: "Synthetic gift scenario",
          researchConclusion: "Synthetic research verified for QA",
          researchItemIds: [source.researchItemId],
          specificationIds: [spec.id],
          skuIds: [recipe.skuId],
          artworkVersionIds: [artwork.versionId],
          title: options.pillow
            ? "Synthetic Custom Name Shaped Pillow"
            : "Synthetic Custom Name Fabric Panel",
          bullets: [
            "Synthetic original name print",
            options.pillow ? "Synthetic 10 inch shaped pillow" : "Synthetic 60 by 40 mm panel",
            options.pillow
              ? "Synthetic single front and white back, one pillow"
              : "Synthetic single panel",
            "Synthetic gift scene",
            "Synthetic customer name instructions",
          ],
          description: options.pillow
            ? "Synthetic QA custom name shaped pillow. One pillow, single front and white back. Choose the size and enter the name in the configured field. This fixture validates data flow only."
            : "Synthetic QA custom name fabric panel. A single 60 by 40 millimeter panel. Enter the name in the configured customization field. This fixture validates data flow only.",
          mainImageId: photo.id,
          mediaAssetIds: [photo.id, mockup.id],
          customization,
          customInstructions: "Enter a name up to 20 characters.",
          ...(configurationSample
            ? {
                customMaterials: [
                  {
                    fieldKey: "name",
                    label: "Synthetic field reference",
                    assetId: configurationSample.id,
                    optionValue: "",
                  },
                ],
              }
            : {}),
          ...(options.pillow
            ? {
                customPage: {
                  status: "verified",
                  evidence:
                    "Synthetic isolated configuration evidence; no actual seller page was configured",
                },
              }
            : {}),
        }),
        idempotencyKey: randomUUID(),
      })
    ).plan;
    ids.plans.push(plan.id);
    const draft = await centerApi<{ listingId: string; listingVersionId: string }>(
      `sales-plans/${plan.id}/draft`,
      {
        expectedRevision: plan.revision,
        expectedListingVersionId: null,
        idempotencyKey: randomUUID(),
      },
    );
    ids.listings.push(draft.listingId);
    const draftState = await centerApi<ListingState>(`listings/${draft.listingId}`);
    const saved = await apiFetch(
      `${process.env.API_BASE_URL}/v1/listings/${draft.listingId}/versions`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "if-match": draftState.version.id },
        body: JSON.stringify({
          ...draftState.version.content,
          attributes: { ...draftState.version.content.attributes, brand: "Synthetic QA Brand" },
          compliance: { ...draftState.version.content.compliance, countryOfOrigin: "CN" },
          personalization: {
            enabled: true,
            instructions: "Enter a name up to 20 characters.",
            required: true,
            maxAllowedCharacters: 20,
          },
        }),
      },
    );
    if (!saved.ok) throw new Error(`Fixture listing setup failed: ${saved.status}`);
    return {
      planId: plan.id,
      database,
      context,
      storage,
      photo,
      mockup,
      artwork,
      configurationSample,
      source,
      recipe,
      spec,
      spu,
      ids,
      async addSibling() {
        if (!options.pillow)
          throw new Error("Sibling delivery fixture requires the pillow boundary");
        const siblingProfile=await createCenterProfile("shaped_pillow",`${code}-12`,false,undefined,{longestSideInches:12});
        ids.profiles.push(siblingProfile.id);
        const { specification } = await centerApi<{ specification: SpecificationView }>(
          "product-development/specifications",
          {
            spuId: spu.id,
            code: "TWO",
            name: "Synthetic 12 inch pillow",
            attributes: { size: "12 inch" },
            facts: syntheticSpecificationFacts({
              material: "Synthetic fabric",
              dimensions: "12 inch synthetic pillow",
              physicalDimensions: { basis: "artwork_longest", unit: "mm", length: 304.8, width: null, height: null },
              packageContents: "One synthetic pillow, single front and white back",
              packageQuantity: 1,
              factsConfirmed: true,
            }),
            processProfileVersionId: siblingProfile.versionId,
            expectedVersion: 0,
            idempotencyKey: randomUUID(),
          },
        );
        const { recipes } = await centerApi<{ recipes: SalesRecipeView[] }>(
          "product-development/combinations",
          {
            artworkVersionId: artwork.versionId,
            items: [
              { specificationVersionId: specification.versionId, skuCode: `${code}-SKU-TWO` },
            ],
            idempotencyKey: randomUUID(),
          },
        );
        const sibling = recipes[0]!,
          image = await owned("synthetic-reviewed-second-size.png"),
          siblingTask = createEntityId(),
          siblingDesign = createEntityId(),
          siblingItem = createEntityId();
        await withTenant(database.db, context, async (tx) => {
          await tx.insert(designTasks).values({
            id: siblingTask,
            tenantId: context.tenantId,
            skuId: sibling.skuId,
            title: "Synthetic second approved SKU",
            brief: "Disposable upstream only",
            status: "approved",
          });
          await tx.insert(designVersions).values({
            id: siblingDesign,
            tenantId: context.tenantId,
            taskId: siblingTask,
            versionNumber: 1,
            status: "approved",
            createdBy: context.userId,
            reviewedBy: context.userId,
            reviewedAt: now,
          });
          await tx.insert(designVersionFiles).values({
            id: createEntityId(),
            tenantId: context.tenantId,
            versionId: siblingDesign,
            assetFileId: master.id,
            role: "production",
          });
          await tx
            .update(salesRecipeVersions)
            .set({ status: "approved", designVersionId: siblingDesign })
            .where(eq(salesRecipeVersions.id, sibling.id));
          await tx.insert(mockupBatchItems).values({
            id: siblingItem,
            tenantId: context.tenantId,
            batchId: batch,
            ordinal: 1,
            designVersionId: siblingDesign,
            skuId: sibling.skuId,
            status: "completed",
            reviewedBy: context.userId,
            reviewedAt: now,
            completedAt: now,
          });
          await tx.insert(mockupBatchOutputs).values({
            id: createEntityId(),
            tenantId: context.tenantId,
            itemId: siblingItem,
            templateSlotId: slot,
            slotKey: "hero",
            status: "approved",
            assetId: image.id,
            assetVersion: 1,
            checksumSha256: image.checksum,
            width: 512,
            height: 512,
            completedAt: now,
          });
        });
        const current = await centerApi<SalesPlanDetail>(`sales-plans/${plan.id}`);
        await centerApi(`sales-plans/${plan.id}`, {
          fields: {
            ...current.plan.fields,
            specificationIds: [...current.plan.fields.specificationIds, specification.id],
            skuIds: [...current.plan.fields.skuIds, sibling.skuId],
            mediaAssetIds: [...current.plan.fields.mediaAssetIds, image.id],
            bullets: current.plan.fields.bullets.map((value) =>
              value.replace("10 inch shaped pillow", "10 or 12 inch shaped pillow"),
            ),
          },
          expectedRevision: current.plan.revision,
          idempotencyKey: randomUUID(),
        });
        return { recipe: sibling, specification, image };
      },
      async finish() {
        const detail = await centerApi<SalesPlanDetail>(`sales-plans/${plan.id}`),
          latest = detail.listings[0]!;
        await centerApi(`sales-plans/${plan.id}/draft`, {
          expectedRevision: detail.plan.revision,
          expectedListingVersionId: latest.versionId,
          idempotencyKey: randomUUID(),
        });
        const state = await centerApi<ListingState>(`listings/${draft.listingId}`);
        if (state.version.validation.blockers.length)
          throw new Error(
            `Synthetic listing blockers: ${JSON.stringify(state.version.validation.blockers)}`,
          );
        await centerApi(`listings/${draft.listingId}/versions/${state.version.id}/approve`, {});
        const sealed = await centerApi<{ packageId: string; checksum: string }>(
          "product-development/packages",
          {
            recipeId: recipe.id,
            listingId: draft.listingId,
            listingVersionId: state.version.id,
            imageEvidence: detail.plan.fields.mediaAssetIds.map((assetId) => ({
              assetId,
              kind: assetId === photo.id ? "finished_photo" : "mockup",
            })),
            reason: "Synthetic reviewed upstream artwork and listing; test only",
            idempotencyKey: randomUUID(),
          },
        );
        ids.packages.push(sealed.packageId);
        const exported = await apiFetch(
          `${process.env.API_BASE_URL}/v1/product-development/packages/${sealed.packageId}/export`,
        );
        if (!exported.ok) throw new Error(`Fixture export failed: ${exported.status}`);
        const bytes = await exported.arrayBuffer(),
          zip = await JSZip.loadAsync(bytes);
        const manifest = JSON.parse(await zip.file("manifest.json")!.async("string"));
        if (
          manifest.listing.versionId !== state.version.id ||
          manifest.checksum !== sealed.checksum
        )
          throw new Error("Sealed source pins did not match export");
        return { ...sealed, manifest, byteSize: bytes.byteLength };
      },
      async mutateAsset() {
        await withTenant(database.db, context, (tx) =>
          tx.update(assetFiles).set({ deletedAt: new Date() }).where(eq(assetFiles.id, mockup.id)),
        );
      },
      close: () => database.client.end(),
    };
  } catch (error) {
    await database.client.end();
    throw error;
  }
}
