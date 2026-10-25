import { createHash, randomUUID } from "node:crypto";
import process from "node:process";
import { isDeepStrictEqual } from "node:util";
import { createEnvironmentSecretVault, SecretVault } from "@yummyai/ai-core";
import { createEntityId, TenantContextSchema, type TenantContext } from "@yummyai/contracts";
import { ConfigurationSnapshotSchema, type ConfigurationSnapshot } from "@yummyai/contracts/ai/model-configuration";
import { StudioPaidImageAbandonSchema, StudioPaidImageInputSchema, StudioPaidImageLookupSchema, StudioPaidImagePageSchema,
  StudioPaidImageRequestSchema, type StudioImagePricing, type StudioPaidImageInput,
  type StudioPaidImageRequest } from "@yummyai/contracts/pod/studio-paid-image";
import { StudioModelSchema } from "@yummyai/contracts/pod/studio-personal";
import { StudioImageBudgetWorkspaceSchema, type StudioImageBudgetSettings } from "@yummyai/contracts/pod/studio-image-budget";
import { StudioGenerateSchema, StudioNamespaceSchema, type StudioRpc } from "@yummyai/contracts/pod/creative-studio";
import { aiBudgetLedger, aiBudgetPolicies, assetFiles, creativeDesignBatches, creativeExecutions,
  creativeStudioEntries, creativeStudioGenerations, creativeStudioImageRequests,
  memberships, membershipRoles, modelProviderConfigs, modelRoutes, roles, withTenant,
  type DatabaseConnection, type TenantTransaction } from "@yummyai/database";
import type { JobEnvelope } from "@yummyai/jobs";
import { stageCreativeExecution, studioImageHash } from "@yummyai/pod-core";
import { ClamAvScanner, type Storage } from "@yummyai/storage";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import sharp from "sharp";
import { requireStudioPaidImageEnvironment } from "../../../../tools/testing/studio-paid-image-environment.mjs";
import { CreativeExecutionRecovery } from "../../../worker/src/processors/creative-execution-recovery.js";
import { creativeOwnerStopped } from "../../../worker/src/processors/creative-execution-owner-state.js";
import { HttpStudioGateway } from "../../../worker/src/processors/studio-generation.gateway.js";
import { StudioGenerationProcessor } from "../../../worker/src/processors/studio-generation.processor.js";
import { ModelConfigurationService } from "../ai/model-configuration.service.js";
import { AuditService } from "../audit/audit.service.js";
import { createCreativeStudioPersonalFixture, studioPersonalAuthority } from "./creative-studio-personal.test-fixture.js";
import { CreativeStudioPersonalService } from "./creative-studio-personal.service.js";
import { CreativeStudioService } from "./creative-studio.service.js";
import { StudioGenerationService } from "./studio-generation.service.js";
import { StudioPaidImageService } from "./studio-paid-image.service.js";
import { StudioImageBudgetService } from "./studio-image-budget.service.js";

export const paidImageFixtureSha = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export const paidImageFixturePricing: StudioImagePricing = {
  estimatedUsd: "0.02000000", reservationUsd: "0.050000",
  reference: "Synthetic isolated operator estimate Not a provider invoice",
};
type Identity = Pick<TenantContext, "tenantId" | "userId">;
type TransportMode = "known" | "unknown_cost" | "unknown_submission" | "overrun" | "invalid_image";
type PrivateMode = "read" | "put" | "scan";
type ObservedCall = { method: string; path: string; model: string; n: number; size: string;
  quality: string; background: string | null; referenceChecksums: string[] };
export type StudioPaidImageCleanup = {
  role: "yummyai_app"; cancelledPreparations: number; stoppedUnsubmittedExecutions: number;
  removedDocuments: number; projectStates: Array<{ id: string; status: "cancelled"; archived: true }>;
  remainingActiveChannels: 0; remainingPreparedRequests: 0; remainingLiveDocuments: 0;
  remainingQueuedOrRunning: 0; retainedHistory: true; retainedAssetIds: string[];
  budgetPolicies: Array<{ tenantId: string; disposition: "restored_original" | "retained_fixture_until_disposable_removal"; sha256: string }>;
  retainedUntilDisposableRemoval: "immutable requests executions budgets revisions private originals and fixture-created budget policies";
};
function strictContext(value: TenantContext): TenantContext {
  return TenantContextSchema.strict().parse({ tenantId: value.tenantId, userId: value.userId,
    permissions: value.permissions, dataScope: value.dataScope,
    ...(value.permissionScopes === undefined ? {} : { permissionScopes: value.permissionScopes }),
    ...(value.teamId === undefined ? {} : { teamId: value.teamId }),
    ...(value.teamIds === undefined ? {} : { teamIds: value.teamIds }),
    ...(value.teamAuthority === undefined ? {} : { teamAuthority: value.teamAuthority }) });
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function cleanupDatabaseCodes(error: unknown) {
  const found = new Set<string>(), visited = new Set<object>();
  const inspect = (value: unknown, depth: number) => {
    if (!value || typeof value !== "object" || visited.has(value) || depth > 8 || visited.size >= 48) return;
    visited.add(value);
    if ("cause" in value) inspect(value.cause, depth + 1);
    if (value instanceof AggregateError) for (const nested of value.errors) inspect(nested, depth + 1);
    if ("code" in value && typeof value.code === "string" && /^[0-9A-Z]{5}$/.test(value.code)) found.add(value.code);
  };
  inspect(error, 0); return [...found];
}

/** Actual membership, configuration, image owner, Processor, S3 and ClamAV.
 * Only the queue delivery and external HTTP transport are synthetic. */
export async function createStudioPaidImageFixture(options: { database?: DatabaseConnection; context?: TenantContext } = {}) {
  const environment = requireStudioPaidImageEnvironment();
  const base = await createCreativeStudioPersonalFixture(options);
  const previousAdmission = { enabled: process.env.STUDIO_PAID_IMAGE_ENABLED, tenants: process.env.STUDIO_PAID_IMAGE_TENANT_IDS };
  let closing: Promise<StudioPaidImageCleanup> | undefined;
  const restoreAdmission = () => {
    if (previousAdmission.enabled === undefined) delete process.env.STUDIO_PAID_IMAGE_ENABLED;
    else process.env.STUDIO_PAID_IMAGE_ENABLED = previousAdmission.enabled;
    if (previousAdmission.tenants === undefined) delete process.env.STUDIO_PAID_IMAGE_TENANT_IDS;
    else process.env.STUDIO_PAID_IMAGE_TENANT_IDS = previousAdmission.tenants;
  };
  try {
    const [metadata] = await base.database.client.unsafe("select current_database() as name,(select count(*)::int from drizzle.__drizzle_migrations) as migrations");
    if (metadata?.name !== environment.name || metadata.migrations !== environment.schema)
      throw new Error("studio_paid_image_fixture_schema_or_nonce_changed");
    let modelSecretReads = 0, lostArchiveAck = false;
    const modelVault = createEnvironmentSecretVault("MODEL_CREDENTIAL_ENCRYPTION_KEY", "yummyai:model-config");
    const revealModelSecret: SecretVault["withSecret"] = modelVault.withSecret.bind(modelVault);
    modelVault.withSecret = <T>(encrypted: string, callback: (secret: string) => T): T => {
      modelSecretReads++; return revealModelSecret(encrypted, callback);
    };
    const putOriginal = base.storage.putPrivate.bind(base.storage);
    base.storage.putPrivate = async (...args: Parameters<Storage["putPrivate"]>) => {
      const stored = await putOriginal(...args);
      if (lostArchiveAck && args[1].domain === "quarantine") {
        lostArchiveAck = false;
        throw new Error("STUDIO_PAID_IMAGE_SYNTHETIC_ARCHIVE_ACK_LOST");
      }
      return stored;
    };
    const vault = new SecretVault(Buffer.alloc(32, 73)), configuration = new ModelConfigurationService(base.database, modelVault);
    const identities = new Map<string, { initial: TenantContext; snapshots: Array<{ id: string; permissions: string[]; dataScope: "self" | "team" | "tenant" }> }>();
    const channels = new Map<string, { context: TenantContext; routeIds: string[] }>(), scopes = new Map<string, TenantContext>();
    const policies = new Map<string, { context: TenantContext; original: typeof aiBudgetPolicies.$inferSelect | null; originalTimestamp: string | null; originalCapsSql: string | null; originalHash: string }>();
    const queueCalls: Array<{ id: string; tenantId: string; userId: string }> = [], calls: ObservedCall[] = [];
    const running = new Set<Promise<unknown>>(), releases = new Set<() => void>();
    let lostQueueAck = false, transportMode: TransportMode = "known", transportHold: (() => Promise<void>) | undefined, scans = 0;
    const queue = { async enqueue(value: { id: string; tenantId: string; userId: string }) {
      queueCalls.push({ ...value });
      if (lostQueueAck) { lostQueueAck = false; throw new Error("STUDIO_PAID_IMAGE_SYNTHETIC_QUEUE_ACK_LOST"); }
    } };
    const paid = new StudioPaidImageService(base.database, queue, base.bridge);
    const budgets = new StudioImageBudgetService(base.database);
    const generations = new StudioGenerationService(base.database, base.storage, queue, base.bridge);
    const studio = new CreativeStudioService(base.database, base.storage, base.scanner, base.bridge,
      new AuditService(base.database), generations, undefined, undefined, paid, budgets);
    const personal = new CreativeStudioPersonalService(base.database, studio);
    const clam = new ClamAvScanner(), scanner = { async scan(...args: Parameters<ClamAvScanner["scan"]>) {
      scans++; return clam.scan(...args);
    } };
    const recovery = new CreativeExecutionRecovery(base.database, base.storage, vault, creativeOwnerStopped, scanner);
    const image = await sharp({ create: { width: 1024, height: 1024, channels: 4, background: "#245eae" } }).png().toBuffer();
    const transport: typeof fetch = async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (url.origin !== "http://127.0.0.1:9" || !["/v1/images/generations", "/v1/images/edits"].includes(url.pathname)
          || init?.method !== "POST") throw new Error("studio_paid_image_fixture_external_transport_forbidden");
      const body = init.body;
      let model: unknown, count: unknown, size: unknown, quality: unknown, background: unknown;
      const referenceChecksums: string[] = [];
      if (body instanceof FormData) {
        model = body.get("model"); count = body.get("n"); size = body.get("size"); quality = body.get("quality"); background = body.get("background");
        for (const key of ["image", "image[]"]) for (const reference of body.getAll(key)) {
          if (!(reference instanceof Blob)) throw new Error("studio_paid_image_fixture_reference_not_bytes");
          referenceChecksums.push(paidImageFixtureSha(new Uint8Array(await reference.arrayBuffer())));
        }
      } else {
        const parsed = JSON.parse(String(body)) as Record<string, unknown>;
        ({ model, n: count, size, quality, background } = parsed);
      }
      if (typeof model !== "string" || typeof size !== "string" || typeof quality !== "string" || Number(count) !== 1)
        throw new Error("studio_paid_image_fixture_request_not_single_image");
      calls.push({ method: init.method, path: url.pathname, model, n: Number(count), size, quality,
        background: typeof background === "string" ? background : null, referenceChecksums });
      await transportHold?.();
      if (transportMode === "unknown_submission") throw new Error("Synthetic provider accepted original POST then connection ended");
      const output = transportMode === "invalid_image" ? image.subarray(0, 24) : image;
      return Response.json({ model: "synthetic-image-v1", data: [{ b64_json: output.toString("base64") }],
        ...(transportMode === "unknown_cost" ? {} : { costUsd: transportMode === "overrun" ? 0.12345678 : 0.01234567 }) },
      { headers: { "x-request-id": "synthetic-paid-image-" + calls.length } });
    };
    const processor = new StudioGenerationProcessor(base.database, base.storage, modelVault, new HttpStudioGateway(transport), scanner, vault);
    async function current(actor: Identity) { return strictContext(await base.current({ tenantId: actor.tenantId, userId: actor.userId })); }
    async function remember(actor: Identity) {
      const context = await current(actor);
      if (!identities.has(context.userId)) {
        const snapshots = await withTenant(base.database.db, context, tx => tx.select({ id: roles.id, permissions: roles.permissions, dataScope: roles.dataScope })
          .from(roles).innerJoin(membershipRoles, eq(membershipRoles.roleId, roles.id)).innerJoin(memberships, eq(memberships.id, membershipRoles.membershipId))
          .where(and(eq(memberships.userId, context.userId), eq(memberships.tenantId, context.tenantId))));
        if (!snapshots.length) throw new Error("studio_paid_image_fixture_roles_missing");
        identities.set(context.userId, { initial: context, snapshots: snapshots.map(row => ({
          ...row, permissions: [...row.permissions], dataScope: TenantContextSchema.shape.dataScope.parse(row.dataScope),
        })) });
      }
      return context;
    }
    async function actor(tenantId?: string, dataScope: "self" | "team" | "tenant" = "self") {
      const created = await base.actor(tenantId, dataScope);
      return { ...created, context: await remember(created) };
    }
    async function grant(context: TenantContext, permissions: readonly string[], dataScope: "self" | "team" | "tenant" = "self") {
      const known = identities.get(context.userId); if (!known) throw new Error("studio_paid_image_fixture_unknown_actor");
      await withTenant(base.database.db, known.initial, async tx => {
        for (const row of known.snapshots) await tx.update(roles).set({ permissions: [...permissions], dataScope })
          .where(and(eq(roles.id, row.id), eq(roles.tenantId, context.tenantId)));
      });
      return current(context);
    }
    const configure = async (context: TenantContext, input: unknown): Promise<ConfigurationSnapshot> =>
      ConfigurationSnapshotSchema.parse(JSON.parse(JSON.stringify(await configuration.invoke(context, input))));
    async function channel(context: TenantContext, priced = true) {
      await remember(context);
      const name = "Synthetic paid image " + createEntityId();
      const snapshot = await configure(context, { operation: "channel.save", name, baseUrl: "http://127.0.0.1:9/v1",
        apiKey: "SYNTHETIC_PAID_IMAGE_73e2c9b1_NO_EXTERNAL_CALL", models: [{
          name: "synthetic-gpt-image", capability: "image", label: "Synthetic image route " + createEntityId() }] });
      const created = snapshot.channels.find(row => row.name === name);
      if (!created || created.models.length !== 1) throw new Error("studio_paid_image_fixture_channel_missing");
      channels.set(created.id, { context, routeIds: created.models.map(row => row.id) });
      if (priced) await price(context, created.id, created.models[0]!.id);
      return { id: created.id, modelId: created.models[0]!.id };
    }
    async function readChannel(context: TenantContext, id: string) {
      const selected = (await configure(context, { operation: "configuration.get" })).channels.find(row => row.id === id);
      if (!selected) throw new Error("studio_paid_image_fixture_channel_missing");
      return selected;
    }
    async function price(context: TenantContext, channelId: string, modelId: string, pricing: StudioImagePricing = paidImageFixturePricing) {
      const selected = await readChannel(context, channelId);
      return configure(context, { operation: "studio.image-pricing.save", channelId, modelId, revision: selected.revision, pricing });
    }
    async function readBudgetPolicy(tx: TenantTransaction, context: TenantContext) {
      const [role] = await tx.execute<{ role: string }>(sql`select current_user as role`);
      if (role?.role !== "yummyai_app") throw new Error("studio_paid_image_fixture_non_owner_required");
      const [row] = await tx.select().from(aiBudgetPolicies).where(eq(aiBudgetPolicies.tenantId, context.tenantId)).for("share");
      const [raw] = await tx.execute<{ timestamp: string; caps: string; value: string }>(sql`select p.updated_at::text as timestamp,p.task_caps_usd::text as caps,to_jsonb(p)::text as value
        from ai_budget_policies p where p.tenant_id=${context.tenantId}`);
      if (Boolean(row) !== Boolean(raw)) throw new Error("studio_paid_image_fixture_budget_snapshot_inconsistent");
      return { role: "yummyai_app" as const, policy: row ?? null, timestamp: raw?.timestamp ?? null, taskCapsSql: raw?.caps ?? null, sha256: paidImageFixtureSha(raw?.value ?? "null") };
    }
    const budgetPolicy = (context: TenantContext) => withTenant(base.database.db, context, tx => readBudgetPolicy(tx, context));
    async function rememberPolicy(context: TenantContext) {
      if (!policies.has(context.tenantId)) {
        const snapshot = await budgetPolicy(context);
        policies.set(context.tenantId, { context, original: snapshot.policy, originalTimestamp: snapshot.timestamp, originalCapsSql: snapshot.taskCapsSql, originalHash: snapshot.sha256 });
      }
    }
    async function policy(context: TenantContext, cap = "1.000000", monthly = "10.000000") {
      await rememberPolicy(context);
      await withTenant(base.database.db, context, tx => tx.insert(aiBudgetPolicies).values({ tenantId: context.tenantId,
        defaultTaskCapUsd: cap, monthlyCapUsd: monthly, taskCapsUsd: {} }).onConflictDoUpdate({ target: aiBudgetPolicies.tenantId,
        set: { defaultTaskCapUsd: cap, monthlyCapUsd: monthly, taskCapsUsd: {} } }));
    }
    const budgetWorkspace = async (context: TenantContext) => StudioImageBudgetWorkspaceSchema.parse(await budgets.workspace(context));
    async function saveBudget(context: TenantContext, settings: StudioImageBudgetSettings) {
      await rememberPolicy(context);
      return StudioImageBudgetWorkspaceSchema.parse(await budgets.save(context, settings));
    }
    async function request(context: TenantContext, modelId: string, patch: Partial<StudioPaidImageInput> = {}) {
      const selected = StudioModelSchema.array().parse(await generations.models(context)).find(row => row.id === modelId);
      if (!selected) throw new Error("studio_paid_image_fixture_model_missing");
      return StudioPaidImageInputSchema.parse({ requestId: randomUUID(), modelId, capability: "image", selectionRevision: selected.selectionRevision,
        prompt: "Synthetic paid-image acceptance No external model is contacted", size: "1024x1024", quality: "high", background: "opaque", ...patch });
    }
    async function project(context: TenantContext) {
      await remember(context); const created = await base.project(context); scopes.set(created.id, context); return created;
    }
    async function reference(context: TenantContext, scope: string) {
      const key = "image:paid-reference-" + createEntityId(), body = await base.image(1);
      await base.invoke(context, { scope, operation: "state.set", namespace: "image_files", key, revision: 0,
        media: { contentBase64: body.toString("base64"), mediaType: "image/png" } });
      await base.invoke(context, { scope, operation: "asset.review", key, decision: "approve", sourceReference: "Synthetic isolated owned reference" });
      const address = await base.address(context, scope, "image_files", key);
      if (!address.assetId) throw new Error("studio_paid_image_fixture_reference_missing");
      return { key, assetId: address.assetId, bytes: body, checksum: paidImageFixtureSha(body) };
    }
    const prepare = async (context: TenantContext, scope: string, input: StudioPaidImageInput) =>
      StudioPaidImageRequestSchema.parse(await paid.prepare(context, { scope, input }));
    const commit = async (context: TenantContext, value: StudioPaidImageRequest) => StudioPaidImageRequestSchema.parse(await paid.commit(context,
      { scope: value.scope, requestId: value.requestId, quoteHash: value.quote.quoteHash, confirmed: true }));
    const lookup = async (context: TenantContext, scope: string, requestId: string) =>
      StudioPaidImageLookupSchema.parse(await paid.lookup(context, { scope, requestId }));
    const page = async (context: TenantContext, scope: string, limit = 20, cursor?: string) =>
      StudioPaidImagePageSchema.parse(await paid.requests(context, { scope, limit, ...(cursor ? { cursor } : {}) }));
    const cancel = async (context: TenantContext, value: StudioPaidImageRequest) => StudioPaidImageRequestSchema.parse(await paid.cancel(context,
      { scope: value.scope, requestId: value.requestId, quoteHash: value.quote.quoteHash }));
    const invoke = (context: TenantContext, request: StudioRpc) =>
      personal.invoke(context, { version: 1, contextAuthority: studioPersonalAuthority(context), request });
    function admission(context: TenantContext, enabled: boolean) {
      if (!identities.has(context.userId)) throw new Error("studio_paid_image_fixture_unknown_actor");
      process.env.STUDIO_PAID_IMAGE_ENABLED = enabled ? "1" : "0";
      process.env.STUDIO_PAID_IMAGE_TENANT_IDS = context.tenantId;
    }
    function processGeneration(context: TenantContext, generationId: string) {
      const value: JobEnvelope = { jobId: createEntityId(), idempotencyKey: generationId, correlationId: generationId,
        traceId: createEntityId(), tenantId: context.tenantId, requestedBy: context.userId, requestedAt: new Date().toISOString(),
        attempt: 0, maxAttempts: 1, payload: { generationId } };
      const pending = processor.process(value);
      running.add(pending); void pending.finally(() => running.delete(pending)).catch(() => undefined);
      return pending;
    }
    function holdTransport() {
      const began = deferred(), released = deferred();
      const release = () => { released.resolve(); releases.delete(release); };
      releases.add(release); transportHold = async () => { began.resolve(); await released.promise; };
      return { entered: began.promise, release, clear() { release(); transportHold = undefined; } };
    }
    function hold(stage: PrivateMode) {
      const held = base.hold(stage), release = () => { held.release(); releases.delete(release); };
      releases.add(release);
      return { entered: held.entered, release, clear() { release(); held.clear(); } };
    }
    async function facts(context: TenantContext) {
      return withTenant(base.database.db, context, async tx => {
        const [role] = await tx.execute<{ role: string }>(sql`select current_user as role`);
        if (role?.role !== "yummyai_app") throw new Error("studio_paid_image_fixture_non_owner_required");
        const requests = await tx.select().from(creativeStudioImageRequests).where(eq(creativeStudioImageRequests.ownerId, context.userId)).orderBy(asc(creativeStudioImageRequests.id));
        const rows = await tx.select().from(creativeStudioGenerations).where(eq(creativeStudioGenerations.ownerId, context.userId)).orderBy(asc(creativeStudioGenerations.id));
        const executions = rows.length ? await tx.select().from(creativeExecutions).where(inArray(creativeExecutions.studioGenerationId, rows.map(row => row.id))).orderBy(asc(creativeExecutions.id)) : [];
        const budget = rows.length ? await tx.select().from(aiBudgetLedger).where(inArray(aiBudgetLedger.requestId, rows.map(row => row.id))).orderBy(asc(aiBudgetLedger.id)) : [];
        const assets = await tx.select().from(assetFiles).where(eq(assetFiles.ownerUserId, context.userId)).orderBy(asc(assetFiles.id));
        const entries = await tx.select().from(creativeStudioEntries).where(eq(creativeStudioEntries.ownerId, context.userId)).orderBy(asc(creativeStudioEntries.id));
        const tables: Record<string, { count: number; sha256: string }> = {};
        for (const table of ["creative_studio_image_requests", "creative_studio_image_cancellations", "creative_studio_generations", "creative_executions", "creative_studio_entries", "creative_studio_revisions",
          "ai_budget_ledger", "asset_files", "creative_design_candidates", "creative_design_versions"]) {
          const [snapshot] = await tx.execute<{ count: number; value: string }>(sql`select count(*)::int as count,coalesce(jsonb_agg(to_jsonb(t) order by t.id),'[]'::jsonb)::text as value
            from (select * from ${sql.raw(table)} where tenant_id=${context.tenantId}) t`);
          if (!snapshot) throw new Error("studio_paid_image_fixture_snapshot_missing");
          tables[table] = { count: snapshot.count, sha256: paidImageFixtureSha(snapshot.value) };
        }
        return { role: role.role, requests, rows, executions, budget, assets, entries, tables,
          queueCalls: queueCalls.map(row => ({ ...row })), calls: calls.map(row => ({ ...row, referenceChecksums: [...row.referenceChecksums] })), scans, modelSecretReads };
      }, { isolationLevel: "repeatable read", accessMode: "read only" });
    }
    async function expiredHistory(context: TenantContext, original: StudioPaidImageRequest) {
      // A valid past prepared record is a negative fixture, never proof of prepare().
      const id = createEntityId(), requestId = randomUUID(), input = { ...original.input, requestId };
      const source = (await facts(context)).requests.find(row => row.id === original.id);
      if (!source) throw new Error("studio_paid_image_fixture_original_request_missing");
      const originalInput = { ...source.originalInput, requestId }, { quoteHash: ignoredHash, ...fields } = original.quote;
      void ignoredHash;
      const body = { ...fields, inputFingerprint: studioImageHash(input),
        createdAt: "2020-01-01T00:00:00.000Z", expiresAt: "2020-01-01T00:05:00.000Z" };
      const quote = { ...body, quoteHash: studioImageHash(body) };
      await withTenant(base.database.db, context, tx => tx.insert(creativeStudioImageRequests).values({
        id, tenantId: context.tenantId, ownerId: context.userId, scope: original.scope, requestId, originalInput, input, quote, createdAt: new Date(body.createdAt) }));
      const found = await lookup(context, original.scope, requestId);
      if (found.status !== "found") throw new Error("studio_paid_image_fixture_expired_history_missing");
      return found.request;
    }
    async function shortLivedHistory(context: TenantContext, original: StudioPaidImageRequest) {
      // A short, fully pinned historical preparation tests real DB-clock expiry
      // during lock waiting without changing the production five-minute quote.
      const id = createEntityId(), requestId = randomUUID(), input = { ...original.input, requestId };
      const source = (await facts(context)).requests.find(row => row.id === original.id);
      if (!source) throw new Error("studio_paid_image_fixture_original_request_missing");
      const originalInput = { ...source.originalInput, requestId }, { quoteHash: ignoredHash, ...fields } = original.quote;
      void ignoredHash;
      const [clock] = await withTenant(base.database.db, context, tx => tx.execute<{ now: string }>(sql`select clock_timestamp()::text as now`));
      const createdAt = new Date(clock!.now), expiresAt = new Date(createdAt.getTime() + 5_000);
      const body = { ...fields, inputFingerprint: studioImageHash(input), createdAt: createdAt.toISOString(), expiresAt: expiresAt.toISOString() };
      const quote = { ...body, quoteHash: studioImageHash(body) };
      await withTenant(base.database.db, context, tx => tx.insert(creativeStudioImageRequests).values({
        id, tenantId: context.tenantId, ownerId: context.userId, scope: original.scope, requestId, originalInput, input, quote, createdAt }));
      const found = await lookup(context, original.scope, requestId);
      if (found.status !== "found") throw new Error("studio_paid_image_fixture_short_history_missing");
      return found.request;
    }
    async function legacy(context: TenantContext, scope: string, modelId: string) {
      const selected = StudioModelSchema.array().parse(await generations.models(context)).find(row => row.id === modelId);
      const channel = [...channels].find(([, value]) => value.routeIds.includes(modelId));
      if (!selected || !channel) throw new Error("studio_paid_image_fixture_legacy_model_missing");
      const id = createEntityId(), input = StudioGenerateSchema.parse({
        requestId: randomUUID(), modelId, prompt: "Synthetic immutable legacy input without paid quote" });
      await withTenant(base.database.db, context, tx => tx.insert(creativeStudioGenerations).values({
        id, tenantId: context.tenantId, ownerId: context.userId, scope, requestId: input.requestId, input,
        references: [], modelSnapshot: { providerConfigId: channel[0], routeId: modelId, model: selected.model, capability: "image" },
        status: "failed", error: "synthetic_retained_legacy" }));
      return id;
    }
    async function rawImageCap(context: TenantContext, value: string) {
      if (!/^(0|[1-9]\d{0,7})(?:[.]\d{1,30})?$/.test(value)) throw new Error("studio_paid_image_fixture_raw_cap_invalid");
      await rememberPolicy(context);
      await withTenant(base.database.db, context, async tx => {
        const rows = await tx.update(aiBudgetPolicies).set({ taskCapsUsd: sql`jsonb_set(${aiBudgetPolicies.taskCapsUsd},'{studio_image}',${value}::jsonb,true)` })
          .where(eq(aiBudgetPolicies.tenantId, context.tenantId)).returning({ tenantId: aiBudgetPolicies.tenantId });
        if (rows.length !== 1) throw new Error("studio_paid_image_fixture_policy_missing");
      });
    }
    async function paidHoldTimes(context: TenantContext, generationId: string) {
      return withTenant(base.database.db, context, async tx => {
        const rows = await tx.execute<{ role: string; generationId: string; ledgerId: string; amountUsd: string; state: string;
          createdAtSql: string; createdAtMicros: string; generationCreatedAtMicros: string; monthStartMicros: string }>(sql`
          select current_user as role,g.id as "generationId",b.id as "ledgerId",b.amount_usd::text as "amountUsd",b.state,
            b.created_at::text as "createdAtSql",(extract(epoch from b.created_at)*1000000)::bigint::text as "createdAtMicros",
            (extract(epoch from g.created_at)*1000000)::bigint::text as "generationCreatedAtMicros",
            (extract(epoch from (date_trunc('month',clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'))*1000000)::bigint::text as "monthStartMicros"
          from ai_budget_ledger b join creative_studio_generations g on g.tenant_id=b.tenant_id and g.id=b.request_id
          where g.id=${generationId} and g.tenant_id=${context.tenantId} and g.owner_id=${context.userId}`);
        if (rows.length !== 1 || rows[0]!.role !== "yummyai_app") throw new Error("studio_paid_image_fixture_exact_hold_missing");
        return rows[0]!;
      });
    }
    async function priorMonthHold(context: TenantContext, original: StudioPaidImageRequest) {
      // Explicit negative-history INSERT seed. No ledger timestamp UPDATE, owner
      // role, trigger disabling or production-time override is permitted.
      const generationId = createEntityId();
      await withTenant(base.database.db, context, async tx => {
        const [role] = await tx.execute<{ role: string }>(sql`select current_user as role`);
        if (role?.role !== "yummyai_app") throw new Error("studio_paid_image_fixture_non_owner_required");
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${"model-configuration:" + context.tenantId},0))`);
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${context.tenantId + ":" + context.userId + ":studio-generation"},0))`);
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${context.tenantId + ":ai-assist-budget"},0))`);
        const [row] = await tx.select().from(creativeStudioImageRequests).where(and(eq(creativeStudioImageRequests.id, original.id),
          eq(creativeStudioImageRequests.ownerId, context.userId), eq(creativeStudioImageRequests.tenantId, context.tenantId))).for("update");
        if (!row || row.generationId || row.cancelledAt || row.scope !== original.scope || !isDeepStrictEqual(row.quote, original.quote))
          throw new Error("studio_paid_image_fixture_unsubmitted_original_changed");
        const [provider] = await tx.select().from(modelProviderConfigs).where(eq(modelProviderConfigs.id, row.quote.providerConfigId));
        if (!provider) throw new Error("studio_paid_image_fixture_original_provider_missing");
        await tx.insert(creativeStudioGenerations).values({ id: generationId, tenantId: context.tenantId, ownerId: context.userId,
          scope: row.scope, requestId: row.requestId, input: row.input, references: row.quote.references, modelSnapshot: {
            providerConfigId: row.quote.providerConfigId, routeId: row.quote.modelId, model: row.quote.model, capability: "image",
            providerFingerprint: row.quote.providerFingerprint, paidImage: { imageRequestId: row.id, quoteHash: row.quote.quoteHash,
              reservationUsd: row.quote.pricing.reservationUsd, estimatedUsd: row.quote.pricing.estimatedUsd },
          } });
        await tx.insert(aiBudgetLedger).values({ id: createEntityId(), tenantId: context.tenantId, requestId: generationId, taskType: "studio_image",
          modelKey: row.quote.model, provider: provider.provider, amountUsd: row.quote.pricing.reservationUsd, state: "reserved",
          createdAt: sql`(date_trunc('month',clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')-interval '1 microsecond'` });
        await stageCreativeExecution(tx, context, { kind: "studio_generation", ownerId: generationId, stepKey: "generate" }, "external_request");
        await tx.update(creativeStudioImageRequests).set({ generationId, committedAt: sql`clock_timestamp()` }).where(eq(creativeStudioImageRequests.id, row.id));
      });
      const result = await lookup(context, original.scope, original.requestId);
      if (result.status !== "found" || result.request.generationId !== generationId) throw new Error("studio_paid_image_fixture_prior_month_pair_missing");
      return result.request;
    }
    async function archivedRecoveryDue(context: TenantContext, generationId: string) {
      await withTenant(base.database.db, context, async tx => {
        const [row] = await tx.select({ execution: creativeExecutions }).from(creativeExecutions)
          .innerJoin(creativeStudioGenerations, eq(creativeStudioGenerations.id, creativeExecutions.studioGenerationId))
          .where(and(eq(creativeStudioGenerations.id, generationId), eq(creativeStudioGenerations.ownerId, context.userId),
            eq(creativeExecutions.tenantId, context.tenantId))).for("update", { of: [creativeExecutions] });
        if (!row || row.execution.phase !== "response_staging" || !row.execution.submittedAt || !row.execution.responseObjectKey || row.execution.leaseToken)
          throw new Error("studio_paid_image_fixture_archived_recovery_not_deferred");
        await tx.update(creativeExecutions).set({ nextAttemptAt: sql`clock_timestamp()` }).where(eq(creativeExecutions.id, row.execution.id));
      });
    }
    async function close(): Promise<StudioPaidImageCleanup> {
      if (closing) return closing;
      closing = (async () => {
        const failures: unknown[] = [], projectStates: StudioPaidImageCleanup["projectStates"] = [];
        const budgetPolicies: StudioPaidImageCleanup["budgetPolicies"] = [], failedPhases: string[] = [];
        let cancelledPreparations = 0, stoppedUnsubmittedExecutions = 0, removedDocuments = 0;
        const retainedAssetIds = new Set<string>();
        const attempt = async (phase: string, action: () => Promise<void>) => {
          try { await action(); } catch (cause) {
            const codes = cleanupDatabaseCodes(cause); failedPhases.push(phase + ":" + (codes.join("+") || "no_pg_code"));
            failures.push(new Error("studio_paid_image_fixture_cleanup_" + phase + "_failed", { cause }));
          }
        };
        try {
          for (const release of releases) release(); transportHold = undefined;
          await Promise.allSettled([...running]);
          for (const known of identities.values()) await attempt("authority", () => withTenant(base.database.db, known.initial, async tx => {
            for (const role of known.snapshots) await tx.update(roles).set({ permissions: role.permissions, dataScope: role.dataScope }).where(eq(roles.id, role.id));
          }));
          for (const known of identities.values()) await attempt("requests", async () => {
            const context = await current(known.initial), before = await facts(context);
            for (const value of before.requests.filter(row => !row.generationId && !row.cancelledAt)) {
              const reply = StudioPaidImageAbandonSchema.parse(await paid.abandon(context, { scope: value.scope, requestId: value.requestId }));
              if (reply.status !== "cancelled" || reply.scope !== value.scope || reply.requestId !== value.requestId)
                throw new Error("studio_paid_image_fixture_preparation_cleanup_failed");
              cancelledPreparations++;
            }
            for (const row of before.executions.filter(row => !["completed", "failed", "uncertain"].includes(row.phase))) {
              if (row.submittedAt || row.responseObjectKey) throw new Error("studio_paid_image_fixture_active_external_execution_retained");
              await recovery.fail(context, { kind: "studio_generation", ownerId: row.studioGenerationId!, stepKey: "generate" }, undefined,
                "CREATIVE_FIXTURE_UNSUBMITTED_CANCELLED", true);
              stoppedUnsubmittedExecutions++;
            }
            for (const asset of before.assets) retainedAssetIds.add(asset.id);
          });
          for (const [scope, saved] of scopes) await attempt("documents_and_project", async () => {
            const context = await current(saved), rows = (await facts(context)).entries.filter(row => row.scope === scope && !row.deletedAt);
            for (const row of rows) {
              await base.invoke(context, { scope, operation: "state.remove", namespace: StudioNamespaceSchema.parse(row.namespace), key: row.key, revision: row.revision });
              removedDocuments++;
            }
            const [before] = await withTenant(base.database.db, context, tx => tx.select().from(creativeDesignBatches).where(eq(creativeDesignBatches.id, scope)));
            if (before?.status !== "cancelled") await base.pod.cancelDesignBatch(context, scope);
            await base.pod.archiveDesignBatch(context, scope, { archived: true, reason: "Synthetic paid-image acceptance cleanup 73e2c9b1" });
            const [project] = await withTenant(base.database.db, context, tx => tx.select().from(creativeDesignBatches).where(eq(creativeDesignBatches.id, scope)));
            if (project?.status !== "cancelled" || !project.archivedAt) throw new Error("studio_paid_image_fixture_project_cleanup_failed");
            projectStates.push({ id: scope, status: "cancelled", archived: true });
          });
          for (const [id, saved] of channels) await attempt("channels", async () => {
            const context = await current(saved.context), value = await readChannel(context, id);
            await configure(context, { operation: "channel.remove", id, revision: value.revision });
          });
          for (const saved of policies.values()) await attempt("policy_restore", () => withTenant(base.database.db, saved.context, async tx => {
            if (saved.original) await tx.update(aiBudgetPolicies).set({ monthlyCapUsd: saved.original.monthlyCapUsd, defaultTaskCapUsd: saved.original.defaultTaskCapUsd,
              taskCapsUsd: sql`${saved.originalCapsSql}::jsonb`, updatedAt: sql`${saved.originalTimestamp}::timestamptz` }).where(eq(aiBudgetPolicies.tenantId, saved.context.tenantId));
            const snapshot = await readBudgetPolicy(tx, saved.context);
            if (!saved.original && !snapshot.policy) {
              if (snapshot.sha256 !== saved.originalHash || snapshot.timestamp !== null || snapshot.taskCapsSql !== null)
                throw new Error("studio_paid_image_fixture_budget_absence_preservation_failed");
              return;
            }
            if (!snapshot.policy || saved.original && (!isDeepStrictEqual(snapshot.policy, saved.original) || snapshot.sha256 !== saved.originalHash))
              throw new Error("studio_paid_image_fixture_budget_policy_preservation_failed");
            // The ordinary application role has no DELETE grant or supported
            // removal flow for policies. New synthetic policy rows remain only
            // in this guarded disposable DB; immutable billing history remains.
            budgetPolicies.push({ tenantId: saved.context.tenantId, disposition: saved.original ? "restored_original" : "retained_fixture_until_disposable_removal",
              sha256: snapshot.sha256 });
          }));
          for (const known of identities.values()) await attempt("verification", async () => {
            const context = await current(known.initial), after = await facts(context);
            if (after.rows.some(row => ["queued", "running"].includes(row.status)) || after.requests.some(row => !row.generationId && !row.cancelledAt)
                || after.entries.some(row => scopes.has(row.scope) && !row.deletedAt)) throw new Error("studio_paid_image_fixture_visible_cleanup_incomplete");
            const ids = [...channels].filter(([, item]) => item.context.tenantId === context.tenantId).map(([id]) => id);
            if (ids.length) {
              const values = await withTenant(base.database.db, context, tx => tx.select({ id: modelProviderConfigs.id, status: modelProviderConfigs.status,
                cleared: sql<boolean>`${modelProviderConfigs.encryptedApiKey}=''` }).from(modelProviderConfigs).where(inArray(modelProviderConfigs.id, ids)));
              if (values.length !== ids.length || values.some(row => row.status !== "deleted" || !row.cleared))
                throw new Error("studio_paid_image_fixture_channel_cleanup_incomplete");
              const routeIds = [...channels.values()].filter(value => value.context.tenantId === context.tenantId).flatMap(value => value.routeIds);
              const routes = await withTenant(base.database.db, context, tx => tx.select({ status: modelRoutes.status }).from(modelRoutes).where(inArray(modelRoutes.id, routeIds)));
              if (routes.length !== routeIds.length || routes.some(row => row.status !== "disabled"))
                throw new Error("studio_paid_image_fixture_route_cleanup_incomplete");
            }
          });
        } catch (error) { failedPhases.push("unexpected:" + (cleanupDatabaseCodes(error).join("+") || "no_pg_code")); failures.push(error); }
        finally {
          restoreAdmission();
          try { await base.close(); } catch (cause) {
            failedPhases.push("base_close:" + (cleanupDatabaseCodes(cause).join("+") || "no_pg_code"));
            failures.push(new Error("studio_paid_image_fixture_cleanup_base_close_failed", { cause }));
          }
        }
        if (failures.length) throw new AggregateError(failures, "studio_paid_image_fixture_cleanup_failed phases=" + failedPhases.join(","));
        return { role: "yummyai_app", cancelledPreparations, stoppedUnsubmittedExecutions, removedDocuments, projectStates,
          remainingActiveChannels: 0, remainingPreparedRequests: 0, remainingLiveDocuments: 0, remainingQueuedOrRunning: 0,
          retainedHistory: true, retainedAssetIds: [...retainedAssetIds].sort(), budgetPolicies,
          retainedUntilDisposableRemoval: "immutable requests executions budgets revisions private originals and fixture-created budget policies" };
      })();
      return closing;
    }
    if (options.context) await remember(options.context);
    return { environment, base, database: base.database, storage: base.storage, paid, budgets, generations, studio, personal, configuration, recovery,
      vault, modelVault, processor, image, actor, current, grant, configure, channel, readChannel, price, policy, request, project, reference,
      prepare, commit, lookup, page, cancel, invoke, admission, processGeneration, hold, holdTransport, facts, expiredHistory, shortLivedHistory, legacy,
      budgetPolicy, rememberPolicy, budgetWorkspace, saveBudget,
      rawImageCap, paidHoldTimes, priorMonthHold, archivedRecoveryDue,
      mode(value: TransportMode) { transportMode = value; }, loseQueueAck() { lostQueueAck = true; }, loseArchiveAck() { lostArchiveAck = true; }, queueCalls, calls, close };
  } catch (primary) {
    restoreAdmission();
    try { await base.close(); } catch (cleanup) { throw new AggregateError([primary, cleanup], "studio_paid_image_fixture_setup_and_cleanup_failed"); }
    throw primary;
  }
}
