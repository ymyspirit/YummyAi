import "reflect-metadata";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { Module, type INestApplication } from "@nestjs/common";
import { NestFactory, Reflector } from "@nestjs/core";
import { generateKeyPair, SignJWT } from "jose";
import { erpPermissionContext, Permission } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { StudioRpcSchema, type StudioRpc } from "@yummyai/contracts/pod/creative-studio";
import { StudioPersonalReplySchema, StudioWorkspaceSchema } from "@yummyai/contracts/pod/studio-personal";
import { connectDatabase, creativeStudioEntries, creativeStudioRevisions, loadCurrentMembershipContext,
  memberships, membershipRoles, roles, withTenant, type DatabaseConnection } from "@yummyai/database";
import { ClamAvScanner, Storage } from "@yummyai/storage";
import type * as S3Sdk from "../../../../packages/storage/node_modules/@aws-sdk/client-s3/dist-types/index.js";
import { and, eq, sql } from "drizzle-orm";
import sharp from "sharp";
import { requireStudioPersonalEnvironment } from "../../../../tools/testing/require-studio-personal-environment.mjs";
import { AuditService } from "../audit/audit.service.js";
import { ApiClientRouteGuard } from "../auth/api-client-route.guard.js";
import { IdentitySessionController } from "../auth/identity-session.controller.js";
import { OidcJwtStrategy } from "../auth/oidc-jwt.strategy.js";
import { PermissionsGuard } from "../auth/permissions.guard.js";
import { DatabaseMembershipContextLoader, TenantContextGuard } from "../auth/tenant-context.guard.js";
import { DATABASE_CONNECTION } from "../platform.tokens.js";
import { CanvasBridgeService } from "./canvas-bridge.service.js";
import { CreativeStudioController } from "./creative-studio.controller.js";
import { CreativeStudioPersonalService } from "./creative-studio-personal.service.js";
import { CreativeStudioService } from "./creative-studio.service.js";
import { DesignService, DrizzleDesignRepository } from "./design.service.js";
import { PodBatchWorkflowService } from "./pod-batch-workflow.service.js";
import { StudioGenerationService } from "./studio-generation.service.js";

const { S3Client } = createRequire(new URL("../../../../packages/storage/package.json", import.meta.url))("@aws-sdk/client-s3") as typeof S3Sdk;
export const studioPersonalSha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
export const studioPersonalAuthority = (context: TenantContext) => erpSessionAuthority(erpPermissionContext(context));
export const studioPersonalDocumentKey = "studio:prompts";
const issuer = "https://synthetic-studio-personal-oidc.invalid", audience = "synthetic-studio-personal-api";
const permissions = [Permission.DesignRead, Permission.DesignWrite, Permission.AssetRead, Permission.AssetWrite, Permission.DesignReview, Permission.ModelConfigure];
export type StudioPersonalActor = { tenantId: string; userId: string; subject: string; membershipId: string; roleId: string; context: TenantContext };
type Scope = "self" | "team" | "tenant";
type HoldStage = "read" | "put" | "scan" | "invoke";
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

/** Actual Studio/Canvas owners, private S3 and ClamAV. No model, processor or Worker
 * is constructed. Identity bootstrap below is explicit synthetic admission only. */
export async function createCreativeStudioPersonalFixture(options: { database?: DatabaseConnection; context?: TenantContext } = {}) {
  const environment = requireStudioPersonalEnvironment();
  const database = options.database ?? connectDatabase(environment.url), ownsDatabase = !options.database;
  const client = new S3Client({ endpoint: process.env.S3_ENDPOINT, forcePathStyle: true, region: process.env.S3_REGION ?? "us-east-1",
    credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID!, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY! } });
  const hooks: Partial<Record<HoldStage, () => Promise<void>>> = {};
  const releases = new Set<() => void>(), ownedObjects = new Set<string>();
  const counts = { storageReads: 0, storageWrites: 0, scans: 0, originalInvokes: 0, generationCalls: 0, dispatchAttempts: 0 };
  class ObservedStorage extends Storage {
    override async readPrivate(...args: Parameters<Storage["readPrivate"]>) {
      const value = await super.readPrivate(...args); counts.storageReads++; await hooks.read?.(); return value;
    }
    override async putPrivate(...args: Parameters<Storage["putPrivate"]>) {
      const value = await super.putPrivate(...args); counts.storageWrites++; ownedObjects.add(value.objectKey); await hooks.put?.(); return value;
    }
  }
  const storage = new ObservedStorage(client, process.env.S3_PRIVATE_BUCKET!), clam = new ClamAvScanner();
  const scanner = { async scan(body: Uint8Array, fileName: string, mediaType: string) {
    const result = await clam.scan({ body, fileName, mediaType }); counts.scans++; await hooks.scan?.(); return result;
  } };
  const audit = new AuditService(database);
  const forbiddenDispatch = async () => { counts.dispatchAttempts++; throw new Error("studio_personal_fixture_dispatch_forbidden"); };
  const pod = new PodBatchWorkflowService(database, { enqueueCreativeCandidate: forbiddenDispatch, enqueueCreativeAdaptation: forbiddenDispatch,
    enqueueTemplateCompile: forbiddenDispatch, enqueueMockupRender: forbiddenDispatch }, audit, new DesignService(new DrizzleDesignRepository(database, storage)));
  const bridge = new CanvasBridgeService(database, storage, audit, pod, scanner);
  class ObservedGenerations extends StudioGenerationService {
    override async create(...args: Parameters<StudioGenerationService["create"]>) { counts.generationCalls++; return super.create(...args); }
  }
  const generations = new ObservedGenerations(database, storage, { enqueue: forbiddenDispatch }, bridge);
  class ObservedStudio extends CreativeStudioService {
    override async invoke(...args: Parameters<CreativeStudioService["invoke"]>) {
      counts.originalInvokes++; const value = await super.invoke(...args); await hooks.invoke?.(); return value;
    }
  }
  const studio = new ObservedStudio(database, storage, scanner, bridge, audit, generations);
  const personal = new CreativeStudioPersonalService(database, studio);
  const actorRows: StudioPersonalActor[] = [];
  let app: INestApplication | undefined, origin: string | undefined, signing: Awaited<ReturnType<typeof generateKeyPair>> | undefined, closed = false;
  const issued = new Map<string, { value: string; id: string }>();
  const requests: Array<{ method: string; path: string; status: number; credentialId: string }> = [];
  async function current(actor: Pick<StudioPersonalActor, "tenantId" | "userId">) {
    return withTenant(database.db, { ...actor, permissions: [], dataScope: "self" }, tx => loadCurrentMembershipContext(tx, actor));
  }
  async function actor(tenantId = createEntityId(), dataScope: Scope = "self") {
    const existingTenant = actorRows.some(value => value.tenantId === tenantId);
    const userId = createEntityId(), membershipId = createEntityId(), roleId = createEntityId(), subject = randomUUID();
    if (!existingTenant) await database.client.unsafe("insert into organizations(id,name,slug) values($1,'Synthetic personal Studio',$2)", [tenantId, randomUUID()]);
    await database.client.unsafe("insert into app_users(id,oidc_subject,email,display_name) values($1,$2,$3,'Synthetic Studio operator')", [userId, subject, `${userId}@example.invalid`]);
    const admission: TenantContext = { tenantId, userId, permissions, dataScope: "tenant" };
    await withTenant(database.db, admission, async tx => {
      await tx.insert(memberships).values({ id: membershipId, tenantId, userId, status: "active" });
      await tx.insert(roles).values({ id: roleId, tenantId, name: "Synthetic Studio " + roleId, permissions, dataScope });
      await tx.insert(membershipRoles).values({ tenantId, membershipId, roleId });
    });
    const value = { tenantId, userId, subject, membershipId, roleId, context: await current({ tenantId, userId }) };
    actorRows.push(value); return value;
  }
  async function grant(value: StudioPersonalActor, next: readonly string[], dataScope: Scope = "self") {
    const admission: TenantContext = { tenantId: value.tenantId, userId: value.userId, permissions, dataScope: "tenant" };
    await withTenant(database.db, admission, async tx => {
      const rows = await tx.update(roles).set({ permissions: [...next], dataScope }).where(and(eq(roles.id, value.roleId), eq(roles.tenantId, value.tenantId))).returning({ id: roles.id });
      if (rows.length !== 1) throw new Error("studio_personal_fixture_role_missing");
    });
  }
  async function active(value: StudioPersonalActor, enabled: boolean) {
    await withTenant(database.db, value.context, async tx => {
      const rows = await tx.update(memberships).set({ status: enabled ? "active" : "disabled" }).where(eq(memberships.id, value.membershipId)).returning({ id: memberships.id });
      if (rows.length !== 1) throw new Error("studio_personal_fixture_membership_missing");
    });
  }
  async function project(context: TenantContext) {
    return bridge.create(context, { requestId: randomUUID(), name: "Synthetic personal Studio " + createEntityId(),
      prompt: "Synthetic local canvas editing only No model or production release", referenceAssetIds: [] });
  }
  async function image(seed: number = 0) {
    return sharp({ create: { width: 240 + seed, height: 160, channels: 4, background: { r: 30 + seed, g: 90, b: 190, alpha: 1 } } }).png().toBuffer();
  }
  async function invoke(context: TenantContext, raw: StudioRpc) {
    const request = StudioRpcSchema.parse(raw);
    return personal.invoke(context, { version: 1, contextAuthority: studioPersonalAuthority(context), request });
  }
  async function token(value: StudioPersonalActor) {
    const prior = issued.get(value.userId); if (prior) return prior;
    signing ??= await generateKeyPair("RS256");
    const signed = await new SignJWT({ tenant_id: value.tenantId }).setProtectedHeader({ alg: "RS256" }).setSubject(value.subject)
      .setIssuer(issuer).setAudience(audience).setIssuedAt().setExpirationTime("30m").sign(signing.privateKey);
    const result = { value: signed, id: randomUUID() }; issued.set(value.userId, result); return result;
  }
  async function startHttp() {
    if (origin) return origin; signing ??= await generateKeyPair("RS256");
    @Module({ controllers: [IdentitySessionController, CreativeStudioController], providers: [
      { provide: DATABASE_CONNECTION, useValue: database }, { provide: CreativeStudioService, useValue: studio },
      { provide: StudioGenerationService, useValue: generations }, { provide: CreativeStudioPersonalService, useValue: personal },
    ] })
    class PersonalStudioAcceptanceModule {}
    app = await NestFactory.create(PersonalStudioAcceptanceModule, { logger: false, abortOnError: false });
    const reflector = new Reflector();
    app.useGlobalGuards(new TenantContextGuard(new OidcJwtStrategy({ issuer, audience, verificationKey: signing.publicKey }),
      new DatabaseMembershipContextLoader(database), undefined, reflector), new PermissionsGuard(reflector), new ApiClientRouteGuard(reflector));
    await app.listen(0, "127.0.0.1"); origin = await app.getUrl(); return origin;
  }
  async function http(value: StudioPersonalActor, path: string, body?: unknown, context = value.context) {
    if (!/^\/v1\/(?:identity\/session|creative-studio\/(?:workspace|invoke))(?:\?[^#]*)?$/.test(path)) throw new Error("studio_personal_fixture_path_invalid");
    const credential = await token(value), method = body === undefined ? "GET" : "POST";
    const response = await fetch(new URL(path, await startHttp()), { method, redirect: "error", headers: { authorization: "Bearer " + credential.value,
      "x-yummyai-context-authority": studioPersonalAuthority(context), ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    requests.push({ method, path: new URL(path, "http://fixture.invalid").pathname, status: response.status, credentialId: credential.id });
    return response;
  }
  function hold(stage: HoldStage) {
    const entered = deferred(), released = deferred(); let used = false;
    const release = () => { released.resolve(); releases.delete(release); }; releases.add(release);
    hooks[stage] = async () => { if (!used) { used = true; entered.resolve(); await released.promise; } };
    return { entered: entered.promise, release, clear() { release(); delete hooks[stage]; } };
  }
  async function facts(context: TenantContext) {
    return withTenant(database.db, context, async tx => {
      const [role] = await tx.execute<{ role: string }>(sql`select current_user as role`);
      const tables: Record<string, { count: number; hash: string }> = {};
      for (const table of ["creative_studio_entries", "creative_studio_revisions", "asset_files", "creative_studio_generations", "creative_executions", "ai_budget_ledger", "ai_budget_policies", "model_provider_configs", "model_routes"]) {
        const [row] = await tx.execute<{ count: number; value: string }>(sql`select count(*)::int as count,coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text)::text,'[]') as value from ${sql.identifier(table)} t`);
        if (!row) throw new Error("studio_personal_fixture_facts_missing");
        tables[table] = { count: row.count, hash: studioPersonalSha(row.value) };
      }
      return { role: role?.role ?? "", tables, counts: { ...counts }, ownedObjectCount: ownedObjects.size,
        providerCalls: 0 as const, workerProcesses: 0 as const };
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
  }
  async function address(context: TenantContext, scope: string, namespace: string, key: string) {
    return withTenant(database.db, context, async tx => {
      const rows = await tx.select({ id: creativeStudioEntries.id, revision: creativeStudioEntries.revision, assetId: creativeStudioEntries.assetId,
        deleted: creativeStudioEntries.deletedAt }).from(creativeStudioEntries).where(and(eq(creativeStudioEntries.ownerId, context.userId),
        eq(creativeStudioEntries.scope, scope), eq(creativeStudioEntries.namespace, namespace), eq(creativeStudioEntries.key, key)));
      const row = rows[0];
      const versions = row ? await tx.select({ revision: creativeStudioRevisions.revision }).from(creativeStudioRevisions).where(eq(creativeStudioRevisions.entryId, row.id)) : [];
      return { count: rows.length, revision: row?.revision ?? 0, assetId: row?.assetId ?? null, deleted: !!row?.deleted, revisions: versions.map(value => value.revision).sort((a, b) => a - b) };
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
  }
  async function close() {
    if (closed) return; closed = true;
    for (const release of releases) release(); for (const stage of Object.keys(hooks) as HoldStage[]) delete hooks[stage];
    const failures: string[] = [];
    try { await app?.close(); } catch { failures.push("http_close"); }
    try { client.destroy(); } catch { failures.push("storage_close"); }
    if (ownsDatabase) try { await database.client.end(); } catch { failures.push("database_close"); }
    // Original entry/history and every owned object remain confined to the nonce
    // DB/bucket until the outer runner deletes and independently verifies both.
    if (failures.length) throw new Error("studio_personal_fixture_close_failed:" + failures.join(","));
  }
  try {
    await storage.assertBucketReady();
    if (options.context) {
      const fresh = await current(options.context);
      if (studioPersonalAuthority(fresh) !== studioPersonalAuthority(options.context)) throw new Error("studio_personal_fixture_actor_changed");
    }
    return { environment, database, storage, scanner, bridge, studio, personal, generations, pod, actor, current, grant, active, project, image, invoke,
      http, hold, facts, address, requests, counts, permissions, ownsDatabase, close,
      parseWorkspace: StudioWorkspaceSchema.parse, parseReply: StudioPersonalReplySchema.parse };
  } catch (error) { await close(); throw error; }
}
