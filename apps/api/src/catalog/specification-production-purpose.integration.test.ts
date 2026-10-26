import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { Permission } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import {
  specificationFactsReady,
  specificationProductionFactsReady,
  type SpecificationFacts,
} from "@yummyai/contracts/catalog/specification-facts";
import { ManufacturingRecipeContentSchema } from "@yummyai/contracts/catalog/manufacturing";
import { OrderWorkDraftSchema } from "@yummyai/contracts/order/workspace";
import type { RuleFields } from "@yummyai/contracts/rules";
import {
  artworkMasters, artworkMasterVersions, businessRuleVersions,
  connectDatabase, developmentEvents, inventoryStockItems,
  loadCurrentMembershipContext, manufacturingRecipeReviews,
  memberships, membershipRoles, migrateDatabase, printProfiles, printProfileVersions,
  productionEditorProjects, productionEditorVersions, productSpecifications,
  productSpecificationVersions, roles, withTenant,
} from "@yummyai/database";
import type { Storage } from "@yummyai/storage";
import { requireDisposableIntegrationEnvironment } from "../../../../tools/testing/require-disposable-integration.mjs";
import { syntheticSpecificationFacts } from "../../../../tools/testing/specification-fixtures.js";
import { AuditService } from "../audit/audit.service.js";
import { RuleCenterService } from "../rules/rule-center.service.js";
import { approvedManufacturingForProduction, productionFactorySource, productionManufacturingOptions } from "./manufacturing-production.js";
import { ManufacturingService } from "./manufacturing.service.js";
import { orderSalesChoices, validateOrderSalesBasis } from "./order-sales-basis.js";
import { ProductDevelopmentService } from "./product-development.service.js";

// Reject before constructing a database client. The runner owns and drops the
// entire disposable database; these are synthetic metadata, never real artwork.
requireDisposableIntegrationEnvironment();

describe.sequential("production-purpose specification facts and original rule evidence", () => {
  const database = connectDatabase();
  const catalog = new ProductDevelopmentService(database, {} as Storage);
  const ruleCenter = new RuleCenterService(database, new AuditService(database));
  const manufacturing = new ManufacturingService(database, new AuditService(database));
  let a: Awaited<ReturnType<typeof actor>>, b: Awaited<ReturnType<typeof actor>>;

  beforeAll(async () => {
    await migrateDatabase(database);
    a = await actor();
    b = await actor();
  });
  afterAll(() => database.client.end());

  async function actor() {
    const seed: TenantContext = {
      tenantId: createEntityId(), userId: createEntityId(),
      dataScope: "tenant", permissions: Object.values(Permission),
    };
    const roleId = createEntityId(), memberId = createEntityId();
    await database.client.unsafe(
      "insert into organizations(id,name,slug) values($1,'Synthetic production facts',$2)",
      [seed.tenantId, randomUUID()],
    );
    await database.client.unsafe(
      "insert into app_users(id,oidc_subject,email,display_name) values($1,$2,$3,'Synthetic production facts operator')",
      [seed.userId, randomUUID(), `${seed.userId}@example.invalid`],
    );
    await withTenant(database.db, seed, async tx => {
      await tx.insert(memberships).values({ id: memberId, tenantId: seed.tenantId, userId: seed.userId, status: "active" });
      await tx.insert(roles).values({ id: roleId, tenantId: seed.tenantId, name: randomUUID(), permissions: seed.permissions, dataScope: "tenant" });
      await tx.insert(membershipRoles).values({ tenantId: seed.tenantId, membershipId: memberId, roleId });
    });
    const current = () => withTenant(database.db, seed, tx => loadCurrentMembershipContext(tx, seed));
    return { seed, roleId, current };
  }

  async function basis(owner = a, reviewed = true) {
    const context = await owner.current();
    const { spu } = await catalog.createSpu(context, {
      code: `PRODUCTION-${randomUUID()}`, name: "Synthetic production-only product", idempotencyKey: randomUUID(),
    });
    const projectId = createEntityId(), editorVersionId = createEntityId();
    const profileId = createEntityId(), profileVersionId = createEntityId();
    const artworkId = createEntityId(), artworkVersionId = createEntityId(), stockId = createEntityId();
    await withTenant(database.db, context, async tx => {
      await tx.insert(productionEditorProjects).values({
        id: projectId, tenantId: context.tenantId, name: "Synthetic common process metadata", createdBy: context.userId,
        encryptedDataKey: "synthetic-unused-key-no-customer-content",
      });
      await tx.insert(productionEditorVersions).values({
        id: editorVersionId, tenantId: context.tenantId, projectId, versionNumber: 1,
        encryptedDocument: "synthetic-unused-document-no-artwork", checksum: "a".repeat(64), createdBy: context.userId,
      });
      await tx.update(productionEditorProjects).set({
        currentVersionId: editorVersionId, versionNumber: 1,
        reviewedVersionId: reviewed ? editorVersionId : null,
        reviewedBy: reviewed ? context.userId : null, reviewedAt: reviewed ? new Date() : null,
      }).where(eq(productionEditorProjects.id, projectId));
      await tx.insert(printProfiles).values({ id: profileId, tenantId: context.tenantId, code: randomUUID() });
      await tx.insert(printProfileVersions).values({
        id: profileVersionId, tenantId: context.tenantId, profileId, versionNumber: 1,
        name: "Synthetic reviewed common process", productType: "shaped_pillow", projectId,
        sourceVersionId: editorVersionId, instructions: "Synthetic process reference, no production release",
        idempotencyKey: randomUUID(), requestHash: "b".repeat(64), createdBy: context.userId,
      });
      await tx.insert(artworkMasters).values({ id: artworkId, tenantId: context.tenantId, createdBy: context.userId, code: randomUUID() });
      await tx.insert(artworkMasterVersions).values({
        id: artworkVersionId, tenantId: context.tenantId, createdBy: context.userId, artworkId, versionNumber: 1,
        name: "Synthetic customer image scheme", mode: "customer_image", tags: [], researchItemIds: [],
        customization: { version: 1, fields: [] }, materials: [], layout: [], instructions: "Synthetic scheme only",
      });
      await tx.insert(inventoryStockItems).values({
        id: stockId, tenantId: context.tenantId, code: randomUUID(), name: "Synthetic fabric", baseUnit: "meter", createdBy: context.userId,
      });
    });
    return { owner, context, spuId: spu.id, profileVersionId, projectId, artworkVersionId, stockId };
  }

  function facts(overrides: Partial<SpecificationFacts> = {}): SpecificationFacts {
    return syntheticSpecificationFacts({
      factsConfirmed: false, productionConfirmed: true, productionRuleReferences: [],
      weightGrams: null, packagedWeightGrams: 117.9340162,
      ...overrides,
    });
  }

  function saveInput(source: Awaited<ReturnType<typeof basis>>, value = facts()) {
    return {
      spuId: source.spuId, code: `SIZE-${randomUUID()}`, name: "Synthetic 10 inch production purpose",
      attributes: {}, facts: value, processProfileVersionId: source.profileVersionId,
      canvasPrintSpecVersionId: null, stockItemId: null, expectedVersion: 0, idempotencyKey: randomUUID(),
    };
  }

  async function rule(source: Awaited<ReturnType<typeof basis>>, fields: Partial<RuleFields> = {}, publish = true) {
    const created = await ruleCenter.save(source.context, null, {
      fields: {
        name: "Synthetic production evidence", category: "production", instructions: "Synthetic common rule evidence only",
        source: "Synthetic disposable fixture", appliesTo: "order_design", scopeKind: "all", productType: null, spuId: null,
        ...fields,
      }, expectedRevision: 0, changeReason: "Synthetic rule fixture", idempotencyKey: randomUUID(),
    });
    if (publish) await ruleCenter.changeState(source.context, created.id, "publish", {
      expectedRevision: 1, version: 1, changeReason: "Synthetic explicit activation",
    });
    const [version] = await withTenant(database.db, source.context, tx => tx.select().from(businessRuleVersions)
      .where(and(eq(businessRuleVersions.ruleId, created.id), eq(businessRuleVersions.version, 1))));
    if (!version) throw new Error("Synthetic rule version missing");
    return { ruleId: created.id, versionId: version.id, version: 1 };
  }

  const versions = (source: Awaited<ReturnType<typeof basis>>) => withTenant(database.db, source.context, tx =>
    tx.select().from(productSpecificationVersions).innerJoin(productSpecifications,
      eq(productSpecifications.id, productSpecificationVersions.specificationId))
      .where(eq(productSpecifications.spuId, source.spuId)));

  it("persists net weight as unknown and exposes production choices without upgrading full facts", async () => {
    const source = await basis(), input = saveInput(source);
    const result = await catalog.saveSpecification(source.context, input), spec = result.specification;
    expect(spec.facts).toMatchObject({ factsConfirmed: false, productionConfirmed: true, weightGrams: null, packagedWeightGrams: 117.9340162 });
    expect(specificationProductionFactsReady(spec.facts)).toBe(true);
    expect(specificationFactsReady(spec.facts)).toBe(false);
    const choices = await withTenant(database.db, source.context, tx => orderSalesChoices(tx, source.context));
    expect(choices.specifications.some(row => row.id === spec.versionId)).toBe(true);
    const draft = OrderWorkDraftSchema.parse({
      artworkVersionId: source.artworkVersionId, specificationVersionId: spec.versionId,
      printProfileVersionId: source.profileVersionId, fields: [], images: [], instructions: "Synthetic review basis",
      designExecutor: "human", customerApprovalRequired: false, dueAt: null,
    });
    const selected = await withTenant(database.db, source.context, tx =>
      validateOrderSalesBasis(tx, draft, false, undefined, null, true));
    expect(selected?.specification.versionId).toBe(spec.versionId);
    expect(selected?.deliveryIssues).toEqual([]);
    await expect(catalog.combine(source.context, {
      artworkVersionId: source.artworkVersionId,
      items: [{ specificationVersionId: spec.versionId, skuCode: `SALE-${randomUUID()}` }], idempotencyKey: randomUUID(),
    })).rejects.toThrow("产品事实未完成确认");
  });

  it("keeps missing logistics measurements separate from a complete production-purpose check", async () => {
    const source = await basis();
    const saved = await catalog.saveSpecification(source.context, saveInput(source, facts({
      packagedWeightGrams: null, packageMeasurements: null,
    })));
    expect(saved.specification.facts).toMatchObject({ weightGrams: null, packagedWeightGrams: null, packageMeasurements: null });
    expect(specificationProductionFactsReady(saved.specification.facts)).toBe(true);
    expect(specificationFactsReady(saved.specification.facts)).toBe(false);
  });

  it("creates one immutable next version and retains the exact idempotent result", async () => {
    const source = await basis(), input = saveInput(source);
    const first = await catalog.saveSpecification(source.context, input);
    expect(await catalog.saveSpecification(source.context, input)).toEqual(first);
    const revised = await catalog.saveSpecification(source.context, {
      ...input, facts: facts({ packagedWeightGrams: 120 }), expectedVersion: 1, idempotencyKey: randomUUID(),
    });
    expect(revised.specification.version).toBe(2);
    const stored = await versions(source);
    expect(stored).toHaveLength(2);
    expect(stored.find(row => row.product_specification_versions.versionNumber === 1)?.product_specification_versions.facts)
      .toEqual(first.specification.facts);
    await expect(catalog.saveSpecification(source.context, { ...input, name: "Changed original key" })).rejects.toThrow();
    await expect(catalog.saveSpecification(source.context, { ...input, idempotencyKey: randomUUID() })).rejects.toThrow();
    expect(await versions(source)).toHaveLength(2);
    const events = await withTenant(database.db, source.context, tx => tx.select().from(developmentEvents).where(eq(developmentEvents.idempotencyKey, input.idempotencyKey)));
    expect(events).toHaveLength(1);
  });

  it("keeps an explicit incomplete draft visible while unavailable for new order production", async () => {
    const source = await basis();
    const saved = await catalog.saveSpecification(source.context, saveInput(source, facts({ productionConfirmed: false })));
    const storedBefore = await versions(source);
    const choices = await withTenant(database.db, source.context, tx => orderSalesChoices(tx, source.context));
    const visible = choices.specifications.find(row => row.id === saved.specification.versionId);
    expect(visible).toMatchObject({ id: saved.specification.versionId, processProfileVersionId: source.profileVersionId, productionReady: false });
    expect(visible!.issues).toEqual(["规格生产事实尚未完成核对"]);
    expect(specificationProductionFactsReady(saved.specification.facts)).toBe(false);
    const draft = OrderWorkDraftSchema.parse({ artworkVersionId: source.artworkVersionId,
      specificationVersionId: saved.specification.versionId, printProfileVersionId: source.profileVersionId,
      fields: [], images: [], instructions: "", customerApprovalRequired: false, dueAt: null });
    await expect(withTenant(database.db, source.context, tx => validateOrderSalesBasis(tx, draft, false, undefined, null, true)))
      .rejects.toThrow("产品规格生产资料尚未确认");
    const original = { kind: "order_work_revision" as const, specificationVersionId: saved.specification.versionId, processProfileVersionId: source.profileVersionId };
    await expect(withTenant(database.db, source.context, tx => productionFactorySource(tx, source.context, original, null)))
      .rejects.toThrow("原产品规格的制造事实尚未完整核实");
    expect(await versions(source)).toEqual(storedBefore);
  });

  it.each([
    { name: "missing material", change: { material: "" } },
    { name: "missing construction", change: { structure: "" } },
    { name: "missing measured size", change: { physicalDimensions: null } },
    { name: "contradictory size basis", change: { physicalDimensions: { basis: "artwork_longest" as const, unit: "mm" as const, length: 254, width: 50, height: null } } },
    { name: "missing package count", change: { packageQuantity: null } },
    { name: "missing reference", change: { verificationReference: "" } },
    { name: "net larger than gross", change: { weightGrams: 300, packagedWeightGrams: 200 } },
  ])("rejects a new production confirmation with $name without inserting a version", async ({ change }) => {
    const source = await basis();
    await expect(catalog.saveSpecification(source.context, saveInput(source, facts(change)))).rejects.toThrow();
    expect(await versions(source)).toHaveLength(0);
  });

  it("requires the exact reviewed general process for a production-only confirmation", async () => {
    const unreviewed = await basis(a, false);
    await expect(catalog.saveSpecification(unreviewed.context, saveInput(unreviewed))).rejects.toThrow();
    const valid = await basis();
    await expect(catalog.saveSpecification(valid.context, { ...saveInput(valid), processProfileVersionId: null })).rejects.toThrow();
    const foreign = await basis(b);
    await expect(catalog.saveSpecification(valid.context, { ...saveInput(valid), processProfileVersionId: foreign.profileVersionId })).rejects.toThrow();
    expect(await versions(valid)).toHaveLength(0);
  });

  it("pins an actual applicable active rule version and rejects forged or foreign references", async () => {
    const source = await basis(), own = await rule(source);
    const saved = await catalog.saveSpecification(source.context, saveInput(source, facts({ productionRuleReferences: [own] })));
    expect(saved.specification.facts.productionRuleReferences).toEqual([own]);
    const foreign = await rule(await basis(b));
    for (const ref of [foreign, { ...own, versionId: createEntityId() }, { ...own, version: 2 }, { ...own, ruleId: createEntityId() }]) {
      await expect(catalog.saveSpecification(source.context, saveInput(source, facts({ productionRuleReferences: [ref] })))).rejects.toThrow();
    }
    expect(await versions(source)).toHaveLength(1);
  });

  it("rejects unrelated SPU, product-type and inactive rules for a new production confirmation", async () => {
    const source = await basis(), other = await basis();
    const wrongSpu = await rule(source, { scopeKind: "spu", spuId: other.spuId });
    const wrongType = await rule(source, { scopeKind: "product_type", productType: "rectangular_print" });
    const inactive = await rule(source, {}, false);
    for (const ref of [wrongSpu, wrongType, inactive]) {
      await expect(catalog.saveSpecification(source.context, saveInput(source, facts({ productionRuleReferences: [ref] })))).rejects.toThrow();
    }
    expect(await versions(source)).toHaveLength(0);
  });

  it("retains real old rule evidence in an unconfirmed revision while refusing a new inactive confirmation", async () => {
    const source = await basis(), reference = await rule(source), input = saveInput(source, facts({ productionRuleReferences: [reference] }));
    await catalog.saveSpecification(source.context, input);
    await ruleCenter.changeState(source.context, reference.ruleId, "disable", {
      expectedRevision: 2, version: 1, changeReason: "Synthetic disabled after original confirmation",
    });
    const draft = await catalog.saveSpecification(source.context, { ...input,
      facts: facts({ productionConfirmed: false, productionRuleReferences: [reference] }), expectedVersion: 1, idempotencyKey: randomUUID() });
    expect(draft.specification.facts.productionRuleReferences).toEqual([reference]);
    expect(draft.specification.facts.productionConfirmed).toBe(false);
    await expect(catalog.saveSpecification(source.context, { ...input, expectedVersion: 2, idempotencyKey: randomUUID() })).rejects.toThrow();
    expect(await versions(source)).toHaveLength(2);
  });

  it("rechecks WorkflowRead for a stale membership context instead of trusting its old permissions", async () => {
    const source = await basis(), reference = await rule(source), original = await a.current();
    await withTenant(database.db, original, tx => tx.update(roles).set({
      permissions: original.permissions.filter(value => value !== Permission.WorkflowRead),
    }).where(eq(roles.id, a.roleId)));
    try {
      await expect(catalog.saveSpecification(original, saveInput(source, facts({ productionRuleReferences: [reference] })))).rejects.toThrow();
      expect(await versions(source)).toHaveLength(0);
    } finally {
      await withTenant(database.db, a.seed, tx => tx.update(roles).set({ permissions: Object.values(Permission) }).where(eq(roles.id, a.roleId)));
    }
  });

  function manufacturingContent(source: Awaited<ReturnType<typeof basis>>, specificationVersionId: string) {
    return ManufacturingRecipeContentSchema.parse({
      specificationVersionId, name: "Synthetic production-only manufacturing", outputQuantity: 1, outputUnit: "each",
      materials: [{ code: "FABRIC", name: "Synthetic fabric", stockItemId: source.stockId, quantityNumerator: 1, quantityDenominator: 1,
        unit: "meter", lossBps: 0, lossBasis: "add_to_net", responsibility: "factory", operationCode: "CUT" }],
      operations: [{ code: "CUT", name: "Synthetic cut", processCode: "cut", responsibility: "factory", expectedSecondsPerOutput: null }],
    });
  }

  it("uses production-only facts through the real manufacturing review and original production source", async () => {
    const source = await basis(), saved = await catalog.saveSpecification(source.context, saveInput(source));
    const spec = saved.specification;
    const made = await manufacturing.create(source.context, { spuId: source.spuId, specificationId: spec.id,
      code: `BOM-${randomUUID()}`, content: manufacturingContent(source, spec.versionId), idempotencyKey: randomUUID() });
    await manufacturing.review(source.context, made.recipeId, { expectedVersion: 1, versionId: made.versionId,
      decision: "approved", note: "Synthetic disposable technical acceptance only", idempotencyKey: randomUUID() });
    const original = { kind: "order_work_revision" as const, specificationVersionId: spec.versionId, processProfileVersionId: source.profileVersionId };
    const result = await withTenant(database.db, source.context, tx => approvedManufacturingForProduction(tx, source.context, made.versionId, original));
    expect(result.source).toEqual(original);
    expect(result.factoryBasis).toMatchObject({ longestMm: 254, productType: "shaped_pillow", templateVersionId: source.profileVersionId });
    expect((await withTenant(database.db, source.context, tx => productionManufacturingOptions(tx, source.context, spec.versionId))).items)
      .toEqual([expect.objectContaining({ versionId: made.versionId })]);
    const factory = await withTenant(database.db, source.context, tx => productionFactorySource(tx, source.context, original, null));
    expect(factory.processProfileVersionId).toBe(source.profileVersionId);
    expect(specificationFactsReady(spec.facts)).toBe(false);
  });

  it.each([
    { name: "ECMAScript whitespace-only material", change: { material: "\t\n\u00a0" } },
    { name: "missing structure", change: { structure: "" } },
    { name: "missing actual size", change: { physicalDimensions: null } },
    { name: "illegal longest-edge width", change: { physicalDimensions: { basis: "artwork_longest" as const, unit: "mm" as const, length: 254, width: 10, height: null } } },
    { name: "missing package quantity", change: { packageQuantity: null } },
    { name: "missing evidence", change: { verificationReference: "" } },
    { name: "contradictory weights", change: { weightGrams: 300, packagedWeightGrams: 200 } },
    { name: "no explicit production confirmation", change: { productionConfirmed: false } },
    // Deliberately malformed JSON is confined to the disposable SQL guard fixture.
    { name: "numeric package display", change: { packageDimensions: 42 } as unknown as Partial<SpecificationFacts> },
    { name: "object instead of rule-reference array", change: { productionRuleReferences: {} } as unknown as Partial<SpecificationFacts> },
    { name: "string instead of numeric rule version", change: { productionRuleReferences: [
      { ruleId: createEntityId(), versionId: createEntityId(), version: "1" },
    ] } as unknown as Partial<SpecificationFacts> },
    { name: "unrecognized top-level confirmation field", change: { productionApprovedBy: createEntityId() } as unknown as Partial<SpecificationFacts> },
  ])("does not accept a forged production flag with $name through the SQL review guard", async ({ change }) => {
    const source = await basis(), specificationId = createEntityId(), specificationVersionId = createEntityId();
    // Apply after normalization, so an invalid packageDimensions value is not
    // replaced with the valid display text derived from packageMeasurements.
    const invalidFacts = { ...facts(), ...change } as SpecificationFacts;
    await withTenant(database.db, source.context, async tx => {
      await tx.insert(productSpecifications).values({ id: specificationId, tenantId: source.context.tenantId,
        spuId: source.spuId, code: randomUUID(), createdBy: source.context.userId });
      await tx.insert(productSpecificationVersions).values({ id: specificationVersionId, tenantId: source.context.tenantId,
        specificationId, versionNumber: 1, name: "Synthetic invalid purpose fixture", attributes: {}, facts: invalidFacts,
        processProfileVersionId: source.profileVersionId, createdBy: source.context.userId });
      const [identity] = await tx.execute<{ role: string }>(sql`select current_user::text as role`);
      expect(identity?.role).toBe("yummyai_app");
    });
    const made = await manufacturing.create(source.context, { spuId: source.spuId, specificationId,
      code: `SQL-${randomUUID()}`, content: manufacturingContent(source, specificationVersionId), idempotencyKey: randomUUID() });
    await expect(withTenant(database.db, source.context, tx => tx.insert(manufacturingRecipeReviews).values({
      id: createEntityId(), tenantId: source.context.tenantId, createdBy: source.context.userId,
      recipeId: made.recipeId, versionId: made.versionId, decision: "approved", note: "Synthetic direct guard rejection",
    }))).rejects.toMatchObject({ cause: { code: "23514" } });
    expect(await withTenant(database.db, source.context, tx => tx.select().from(manufacturingRecipeReviews)
      .where(eq(manufacturingRecipeReviews.versionId, made.versionId)))).toEqual([]);
  });
});
