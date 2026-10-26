import { randomUUID } from "node:crypto";
import { SecretVault } from "@yummyai/ai-core";
import { Permission, summarizeRoleGrants } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import type { KnowledgeFields, KnowledgeSearch } from "@yummyai/contracts/knowledge";
import {
  connectDatabase, knowledgeConflicts, knowledgeSourceChecks, knowledgeSourceReviews, knowledgeSourceSnapshots, knowledgeSources,
  loadCurrentMembershipContext, marketplaceAccounts, memberships, membershipRoles,
  migrateDatabase, productPlans, roles, spus, withTenant, type DatabaseConnection,
} from "@yummyai/database";
import { checkKnowledgeSource } from "@yummyai/knowledge-core";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { requireDisposableIntegrationEnvironment } from "../../../../tools/testing/require-disposable-integration.mjs";
import { AuditService } from "../audit/audit.service.js";
import { KnowledgeGovernanceService } from "./knowledge-governance.service.js";
import { KnowledgeImportService } from "./knowledge-import.service.js";
import { KnowledgeService } from "./knowledge.service.js";
import { currentKnowledgeContext } from "./knowledge-scope.js";

requireDisposableIntegrationEnvironment();

const permissions = [Permission.WorkflowRead, Permission.WorkflowManage, Permission.WorkflowApprove, Permission.ProductRead, Permission.StoreRead, Permission.FinanceRead];
type Actor = { context: TenantContext; roleId: string };
const fields = (spuId: string | null): KnowledgeFields => ({
  title: "Synthetic reference", summary: "Synthetic scope fixture", body: "Synthetic ordinary product facts remain authoritative.",
  topic: "operations", platform: "amazon", market: "US", spuId, sourceType: "team", sourceLabel: "Synthetic source", sourceUrl: "",
  owner: "Synthetic operator", verifiedOn: "2026-01-01", reviewDueOn: "2099-12-31", tags: [],
});
const scope = (spuIds: string[] = []): KnowledgeSearch => ({ query: "Synthetic", topic: "all", platform: "amazon", market: "US", spuIds });
const text = "# Synthetic procedure\n\nConfirm approved ERP product facts before choosing any operational action. This fixture contains no personal data.";
const uploadInput = (spuId: string | null) => ({ requestId: randomUUID(), fileName: "synthetic.md", base64: Buffer.from(text).toString("base64"), fields: fields(spuId), account: null, retentionDays: 7 });
const clean = () => ({ result: "clean" as const, engine: "fixture", signatureVersion: "1", scannedAt: new Date().toISOString() });

describe("knowledge import and governance complete current object scope", () => {
  let database: DatabaseConnection, knowledge: KnowledgeService, imports: KnowledgeImportService, governance: KnowledgeGovernanceService;
  const vault = new SecretVault(Buffer.alloc(32, 23)), scanner = { scan: vi.fn(async () => clean()) };
  let a: Actor, b: Actor, foreign: Actor, mixed: TenantContext;
  let ownSpu: string, peerSpu: string, ownStore: string, peerStore: string;
  let ownDocument: string, peerDocument: string, ownPeerDocument: string, generalDocument: string, ownAccount: string, peerAccount: string, crossAccount: string;
  let peerCard: string, ownCard: string, privateNeed: string, privateEvaluation: string, linkedNeed: string, linkedEvaluation: string, sourceId: string, reviewId: string, conflictId: string;

  beforeAll(async () => {
    database = connectDatabase(); await migrateDatabase(database);
    knowledge = new KnowledgeService(database, new AuditService(database));
    imports = new KnowledgeImportService(database, vault, scanner, knowledge);
    governance = new KnowledgeGovernanceService(database, knowledge);
    a = await actor(); b = await actor(a.context.tenantId); foreign = await actor();
    mixed = { ...a.context, ...summarizeRoleGrants([
      { permissions: [Permission.WorkflowRead, Permission.WorkflowManage, Permission.WorkflowApprove], scope: "tenant" },
      { permissions: [Permission.ProductRead, Permission.StoreRead, Permission.FinanceRead], scope: "self" },
    ]) };
    ownSpu = await product(a.context); peerSpu = await product(b.context);
    ownStore = await store(a.context); peerStore = await store(b.context);
    ownDocument = (await imports.upload(a.context, uploadInput(ownSpu))).id;
    peerDocument = (await imports.upload(b.context, uploadInput(peerSpu))).id;
    ownPeerDocument = (await imports.upload(a.context, uploadInput(peerSpu))).id;
    generalDocument = (await imports.upload(a.context, uploadInput(null))).id;
    ownAccount = await account(a.context, ownStore);
    peerAccount = await account(b.context, peerStore);
    crossAccount = await account(a.context, peerStore);
    ownCard = (await knowledge.save(a.context, null, save(ownSpu))).id;
    peerCard = (await knowledge.save(b.context, null, save(peerSpu))).id;
    privateNeed = (await governance.saveNeed(b.context, null, need(scope([peerSpu]), []))).id;
    linkedNeed = (await governance.saveNeed(b.context, null, need(scope(), [peerCard]))).id;
    privateEvaluation = (await governance.saveEvaluation(b.context, null, evaluation(scope([peerSpu]), []))).id;
    linkedEvaluation = (await governance.saveEvaluation(b.context, null, evaluation(scope(), [peerCard]))).id;
    sourceId = (await governance.addSource(a.context, { label: "Synthetic public source", url: "https://example.com/synthetic-p6", owner: "Synthetic operator", checkEveryHours: 24, freshnessDays: 30, monitoring: false, requestId: randomUUID() })).id;
    const beforeId = createEntityId(), afterId = createEntityId(); reviewId = createEntityId(); conflictId = createEntityId();
    const ownVersion = (await knowledge.history(a.context, ownCard)).versions[0]!, peerVersion = (await knowledge.history(b.context, peerCard)).versions[0]!;
    await withTenant(database.db, a.context, async tx => {
      await tx.insert(knowledgeSourceSnapshots).values([beforeId, afterId].map((id, index) => ({ id, tenantId: a.context.tenantId, sourceId, url: "https://example.com/synthetic-p6", body: `Synthetic public source ${index}`, checksum: String(index).repeat(64), validUntil: new Date("2099-12-31") })));
      await tx.insert(knowledgeSourceReviews).values({ id: reviewId, tenantId: a.context.tenantId, sourceId, beforeSnapshotId: beforeId, afterSnapshotId: afterId, entryIds: [peerCard], reason: "Synthetic restricted linked review" });
      await tx.insert(knowledgeConflicts).values({ id: conflictId, tenantId: a.context.tenantId, leftVersionId: ownVersion.id, rightVersionId: peerVersion.id, key: "synthetic", severity: "warning", fingerprint: "e".repeat(64) });
    });
  });
  afterAll(async () => { await database?.client.end(); }); // Runner removes and verifies the full disposable database.

  async function actor(existingTenant?: string): Promise<Actor> {
    const tenantId = existingTenant ?? createEntityId(), userId = createEntityId(), memberId = createEntityId(), roleId = createEntityId();
    if (!existingTenant) await database.client.unsafe("insert into organizations(id,name,slug)values($1,'Synthetic governance scope',$2)", [tenantId, randomUUID()]);
    await database.client.unsafe("insert into app_users(id,oidc_subject,email,display_name)values($1,$2,$3,'Synthetic governance operator')", [userId, randomUUID(), `${userId}@example.invalid`]);
    const base: TenantContext = { tenantId, userId, permissions, dataScope: "tenant" };
    await withTenant(database.db, base, async tx => {
      await tx.insert(memberships).values({ id: memberId, tenantId, userId });
      await tx.insert(roles).values({ id: roleId, tenantId, name: `Synthetic governance ${userId}`, permissions, dataScope: "tenant" });
      await tx.insert(membershipRoles).values({ tenantId, membershipId: memberId, roleId });
    });
    return { context: await withTenant(database.db, base, tx => loadCurrentMembershipContext(tx, base)), roleId };
  }
  async function product(context: TenantContext) {
    const id = createEntityId(), productPlanId = createEntityId(), customization = { version: 1, fields: [] };
    await withTenant(database.db, context, async tx => {
      await tx.insert(productPlans).values({ id: productPlanId, tenantId: context.tenantId, name: "Synthetic scoped plan", createdBy: context.userId, customization });
      await tx.insert(spus).values({ id, tenantId: context.tenantId, productPlanId, code: `GOV-${id}`, name: "Synthetic scoped product", customization });
    }); return id;
  }
  async function store(context: TenantContext) {
    const id = createEntityId(); await withTenant(database.db, context, tx => tx.insert(marketplaceAccounts).values({ id, tenantId: context.tenantId, platform: "amazon", displayName: `Synthetic ${id}`, region: "NA", authorizationMode: "amazon_private", createdBy: context.userId })); return id;
  }
  async function account(context: TenantContext, storeId: string) {
    return (await imports.upload(context, { ...uploadInput(null), account: { storeId, currency: "USD", periodFrom: "2026-01-01", periodUntil: "2026-01-31", attribution: "Synthetic accounting period" } })).id;
  }
  function save(spuId: string | null) { return { fields: fields(spuId), expectedRevision: 0, reason: "Synthetic scope", requestId: randomUUID() }; }
  function need(search: KnowledgeSearch, entryIds: string[]) { return { question: "Synthetic governed question", owner: "Synthetic operator", scope: search, entryIds, confirmed: true, expectedRevision: 0, requestId: randomUUID() }; }
  function evaluation(search: KnowledgeSearch, requiredEntryIds: string[]) { return { fields: { label: "Synthetic fixed question", search, requiredEntryIds, expectedFacts: ["Synthetic approved fact"], forbiddenClaims: [], expectRefusal: false }, expectedRevision: 0, requestId: randomUUID() }; }
  async function snapshot() {
    return withTenant(database.db, a.context, async tx => {
      const result: Record<string, unknown> = {};
      for (const table of ["knowledge_documents", "knowledge_candidates", "knowledge_entries", "knowledge_versions", "knowledge_governance_events", "knowledge_needs", "knowledge_evaluation_cases", "knowledge_conflicts", "knowledge_source_reviews", "audit_events"])
        result[table] = await tx.execute(sql.raw(`select count(*)::int as count, md5(coalesce(string_agg(to_jsonb(t)::text,'|' order by to_jsonb(t)::text),'')) as checksum from ${table} t`));
      return result;
    });
  }

  it("filters documents, explicit scopes and indirect references before exposing workspace metadata", async () => {
    const before = await snapshot(), view = await governance.workspace(mixed);
    expect(new Set(view.documents.map(value => value.id))).toEqual(new Set([ownDocument, generalDocument, ownAccount]));
    expect(view.sources.some(value => value.id === sourceId)).toBe(true);
    expect(view.sourceReviews.some(value => value.id === reviewId)).toBe(false);
    expect(view.coverage.some(value => [privateNeed, linkedNeed].includes(value.id))).toBe(false);
    expect(view.evaluations.some(value => [privateEvaluation, linkedEvaluation].includes(value.id))).toBe(false);
    expect(view.stores.map(value => value.id)).toEqual([ownStore]);
    expect(view.documents.some(value => [peerAccount, crossAccount].includes(value.id))).toBe(false);
    expect(await snapshot()).toEqual(before);
  });

  it("rejects document, original, candidate and disposal ID bypasses before decryption or writes", async () => {
    const peer = await imports.document(b.context, peerDocument), candidate = peer.candidates[0]; expect(candidate).toBeDefined();
    const before = await snapshot(), decrypt = vi.spyOn(vault, "withSecret"), scans = scanner.scan.mock.calls.length;
    try {
      for (const id of [peerDocument, ownPeerDocument]) {
        await expect(imports.document(mixed, id)).rejects.toMatchObject({ status: 404 });
        await expect(imports.original(mixed, id)).rejects.toMatchObject({ status: 404 });
        await expect(imports.dispose(mixed, id, "archive")).rejects.toMatchObject({ status: 404 });
      }
      await expect(imports.upload(mixed, uploadInput(peerSpu))).rejects.toMatchObject({ status: 404 });
      await expect(imports.decideCandidate(mixed, candidate!.id, { expectedRevision: 1, decision: "reject", fields: candidate!.fields, reason: "Synthetic denied candidate", requestId: randomUUID() })).rejects.toMatchObject({ status: 404 });
      await expect(imports.document(foreign.context, ownDocument)).rejects.toMatchObject({ status: 404 });
      expect(decrypt).not.toHaveBeenCalled(); expect(scanner.scan.mock.calls.length).toBe(scans); expect(await snapshot()).toEqual(before);
    } finally { decrypt.mockRestore(); }
  });

  it("uses each Store and Finance scope for document owner and store owner even when Workflow is tenant-wide", async () => {
    const before = await snapshot();
    for (const id of [peerAccount, crossAccount]) {
      await expect(imports.document(mixed, id)).rejects.toThrow();
      await expect(imports.original(mixed, id)).rejects.toThrow();
      await expect(governance.history(mixed, id)).rejects.toThrow();
      await expect(imports.confirmAccount(mixed, id, { expectedRevision: 1, text: "Synthetic sanitized evidence", identitiesRemoved: true, credentialsRemoved: true, minimumNecessary: true, reason: "Synthetic denied account" })).rejects.toThrow();
    }
    await expect(imports.searchAccount(mixed, peerStore, scope())).rejects.toThrow();
    for (const bit of [Permission.StoreRead, Permission.FinanceRead]) {
      const limited = { ...mixed, ...summarizeRoleGrants([{ permissions: permissions.filter(value => value !== bit), scope: "tenant" }]) };
      expect((await governance.workspace(limited)).documents.every(value => value.kind === "reference")).toBe(true);
      await expect(imports.document(limited, ownAccount)).rejects.toThrow();
    }
    expect(await snapshot()).toEqual(before);
  });

  it("checks original and replacement need evaluation review and conflict references on all ID mutation paths", async () => {
    const before = await snapshot();
    for (const id of [reviewId, privateNeed, linkedNeed, privateEvaluation, linkedEvaluation, conflictId])
      await expect(governance.history(mixed, id)).rejects.toMatchObject({ status: 404 });
    await expect(governance.reviewDetail(mixed, reviewId)).rejects.toMatchObject({ status: 404 });
    await expect(governance.reviewSource(mixed, reviewId, { expectedRevision: 1, decision: "no_business_change", entryIds: [], reason: "Synthetic denied replacement" })).rejects.toMatchObject({ status: 404 });
    await expect(governance.resolveConflict(mixed, conflictId, { expectedRevision: 1, decision: "needs_evidence", reason: "Synthetic denied conflict" })).rejects.toMatchObject({ status: 404 });
    for (const input of [need(scope([peerSpu]), []), need(scope(), [peerCard])]) await expect(governance.saveNeed(mixed, null, input)).rejects.toMatchObject({ status: 404 });
    await expect(governance.saveNeed(mixed, privateNeed, { ...need(scope(), []), expectedRevision: 1 })).rejects.toMatchObject({ status: 404 });
    for (const input of [evaluation(scope([peerSpu]), []), evaluation(scope(), [peerCard])]) await expect(governance.saveEvaluation(mixed, null, input)).rejects.toMatchObject({ status: 404 });
    await expect(governance.saveEvaluation(mixed, privateEvaluation, { ...evaluation(scope(), []), expectedRevision: 1 })).rejects.toMatchObject({ status: 404 });
    await expect(governance.archive(mixed, "need", privateNeed, { expectedRevision: 1, reason: "Synthetic denied archive" })).rejects.toMatchObject({ status: 404 });
    await expect(governance.archive(mixed, "evaluation", linkedEvaluation, { expectedRevision: 1, reason: "Synthetic denied archive" })).rejects.toMatchObject({ status: 404 });
    expect(await snapshot()).toEqual(before);
  });

  it("keeps authorized candidate adoption explicit and never publishes it or exposes private duplicate IDs", async () => {
    const general = await imports.document(mixed, generalDocument), candidate = general.candidates[0]; expect(candidate).toBeDefined();
    const privateDuplicate = await knowledge.save(b.context, null, { ...save(peerSpu), fields: { ...candidate!.fields, spuId: peerSpu } });
    expect((await imports.document(mixed, generalDocument)).candidates.flatMap(value => value.duplicateIds)).not.toContain(privateDuplicate.id);
    const own = await imports.document(mixed, ownDocument), selected = own.candidates[0]; expect(selected).toBeDefined();
    const input = { expectedRevision: 1, decision: "accept", fields: selected!.fields, reason: "Synthetic explicit adoption", requestId: randomUUID() };
    const result = await imports.decideCandidate(mixed, selected!.id, input);
    expect(await imports.decideCandidate(mixed, selected!.id, input)).toEqual(result);
    const card = (await knowledge.workspace(mixed)).entries.find(value => value.id === result.id);
    expect(card?.state).toBe("draft"); expect(card?.activeVersion).toBeNull();
    expect((await imports.original(mixed, ownDocument)).base64).toBe(uploadInput(ownSpu).base64);
    await expect(imports.original(b.context, ownDocument)).rejects.toMatchObject({ status: 404 });
    const ownNeed = await governance.saveNeed(mixed, null, need(scope([ownSpu]), [ownCard]));
    const ownEvaluation = await governance.saveEvaluation(mixed, null, evaluation(scope([ownSpu]), [ownCard]));
    const workspace = await governance.workspace(mixed);
    expect(workspace.coverage.some(value => value.id === ownNeed.id)).toBe(true);
    expect(workspace.evaluations.some(value => value.id === ownEvaluation.id)).toBe(true);
  });

  it("rechecks current product authority after parsing and rejects old upload replay after withdrawal", async () => {
    const value = await actor(a.context.tenantId), spuId = await product(value.context), input = uploadInput(spuId);
    const first = await imports.upload(value.context, input);
    expect(await imports.upload(value.context, input)).toEqual(first);
    const before = await snapshot();
    scanner.scan.mockImplementationOnce(async () => {
      await withTenant(database.db, a.context, tx => tx.update(roles).set({ permissions: permissions.filter(bit => bit !== Permission.ProductRead) }).where(eq(roles.id, value.roleId)));
      return clean();
    });
    await expect(imports.upload(value.context, uploadInput(spuId))).rejects.toThrow();
    await expect(imports.upload(value.context, input)).rejects.toThrow();
    await expect(imports.document(value.context, first.id)).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
  });

  it("does not reveal immutable historical entry IDs after a need removes its current product references", async () => {
    const first = await governance.saveNeed(b.context, null, need(scope(), [peerCard]));
    await governance.saveNeed(b.context, first.id, { ...need(scope(), []), expectedRevision: 1 });
    expect((await governance.workspace(mixed)).coverage.some(value => value.id === first.id)).toBe(true);
    const before = await snapshot();
    await expect(governance.history(mixed, first.id)).rejects.toMatchObject({ status: 404 });
    expect((await governance.history(b.context, first.id)).some(event => Array.isArray(event.detail.entryIds) && event.detail.entryIds.includes(peerCard))).toBe(true);
    expect(await snapshot()).toEqual(before);
  });

  it("revalidates a public source check in each original transaction without holding a connection across reader I O", async () => {
    const value = await actor(a.context.tenantId);
    const source = await governance.addSource(value.context, { label: "Synthetic authority source", url: "https://example.com/synthetic-authority", owner: "Synthetic operator", checkEveryHours: 24, freshnessDays: 30, monitoring: false, requestId: randomUUID() });
    let reads = 0;
    const reader = async (url: string) => {
      reads++;
      await withTenant(database.db, a.context, tx => tx.update(roles).set({ permissions: permissions.filter(bit => bit !== Permission.WorkflowManage) }).where(eq(roles.id, value.roleId)));
      return { url, body: "Synthetic public source after current management withdrawal" };
    };
    await expect(checkKnowledgeSource(database, value.context, source.id, reader, tx => currentKnowledgeContext(tx, value.context, Permission.WorkflowManage))).rejects.toThrow();
    expect(reads).toBe(1);
    const recorded = await withTenant(database.db, a.context, async tx => ({
      source: (await tx.select().from(knowledgeSources).where(eq(knowledgeSources.id, source.id)))[0]!,
      snapshots: await tx.select().from(knowledgeSourceSnapshots).where(eq(knowledgeSourceSnapshots.sourceId, source.id)),
      checks: await tx.select().from(knowledgeSourceChecks).where(eq(knowledgeSourceChecks.sourceId, source.id)),
    }));
    expect(recorded.source.lastCheckedAt).not.toBeNull(); // Original admitted attempt metadata remains truthful.
    expect(recorded.source.latestSnapshotId).toBeNull(); expect(recorded.source.lastSuccessAt).toBeNull();
    expect(recorded.snapshots).toEqual([]); expect(recorded.checks).toEqual([]);
    await expect(checkKnowledgeSource(database, value.context, source.id, reader, tx => currentKnowledgeContext(tx, value.context, Permission.WorkflowManage))).rejects.toThrow();
    expect(reads).toBe(1);
  });
});
