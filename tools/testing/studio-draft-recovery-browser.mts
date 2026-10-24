import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import process from "node:process";
import { ErpSessionViewSchema, erpSessionAuthority } from "../../packages/contracts/src/auth/session.js";
import { TenantContextSchema, type TenantContext } from "../../packages/contracts/src/tenant/tenant-context.js";
import { requireStudioDraftRecoveryEnvironment } from "./studio-draft-recovery-environment.mjs";
import type { createCreativeStudioPersonalFixture } from "../../apps/api/src/design/creative-studio-personal.test-fixture.js";

type Fixture = Awaited<ReturnType<typeof createCreativeStudioPersonalFixture>>;
type DatabaseTools = typeof import("../../packages/database/src/index.js");
type DrizzleTools = typeof import("../../packages/database/node_modules/drizzle-orm/index.js");
export type StudioDraftRecoveryBrowserRequest = { id: number; nonce: string; operation: "seed"; context: TenantContext }
  | { id: number; nonce: string; operation: "facts" | "close" };
export type StudioDraftRecoveryCleanupPhase = "authority" | "documents" | "archive" | "verification" | "base_close";
type Entry = { id: string; scope: string; namespace: string; key: string; revision: number; value: unknown; assetId: string | null; deleted: boolean; updatedAt: string };
type Revision = { entryId: string; revision: number; value: unknown; assetId: string | null; createdAt: string };
type Project = { id: string; status: string; archived: boolean };
const imageKey = "infinite-canvas:image_draft", videoKey = "infinite-canvas:video_draft";
const allowedKeys = new Set([imageKey, videoKey, "infinite-canvas:canvas_store", "infinite-canvas:asset_store", "studio:prompts"]);
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const date = "2026-10-24T00:00:00.000Z";
function invalid(): never { throw new Error("studio_draft_browser_request_invalid"); }
function cleanupFailure(phase: StudioDraftRecoveryCleanupPhase, cause: unknown) { return new Error("studio_draft_fixture_cleanup_" + phase + "_failed", { cause }); }
function cleanupPhases(error: unknown) {
  const result = new Set<StudioDraftRecoveryCleanupPhase>(), visited = new Set<Error>();
  const visit = (value: unknown, depth: number) => {
    if (!(value instanceof Error) || visited.has(value) || depth > 5 || visited.size >= 24) return;
    visited.add(value); const match = /^studio_draft_fixture_cleanup_(authority|documents|archive|verification|base_close)_failed$/.exec(value.message);
    if (match) result.add(match[1] as StudioDraftRecoveryCleanupPhase);
    if (value instanceof AggregateError) for (const item of value.errors) visit(item, depth + 1);
    visit(value.cause, depth + 1);
  };
  visit(error, 0); return [...result];
}
async function send(value: unknown) {
  await new Promise<void>((resolve, reject) => {
    if (!process.connected || !process.send) return reject(new Error("studio_draft_browser_channel_closed"));
    process.send(value, error => error ? reject(new Error("studio_draft_browser_send_failed")) : resolve());
  });
}

/** One nonce, one authenticated actor, two tracked synthetic projects. Only
 * seed/read/close IPC exists; all mutations use the original Studio/Pod owners. */
export async function studioDraftRecoveryBrowserChild() {
  const environment = requireStudioDraftRecoveryEnvironment(process.env, true);
  let fixture: Fixture | undefined, context: TenantContext | undefined, db: DatabaseTools | undefined, orm: DrizzleTools | undefined;
  const scopes: string[] = [];
  let closing = false, chain = Promise.resolve(), finish!: () => void;
  const done = new Promise<void>(resolve => { finish = resolve; });
  async function current() {
    if (!fixture || !context) invalid();
    return TenantContextSchema.strict().parse(await fixture.current({ tenantId: context.tenantId, userId: context.userId }));
  }
  async function documents(actor: TenantContext) {
    if (!fixture || !db || !orm) invalid();
    const { sql } = orm;
    return db.withTenant(fixture.database.db, actor, async tx => {
      const [role] = await tx.execute<{ role: string }>(sql`select current_user as role`);
      if (role?.role !== "yummyai_app") throw new Error("studio_draft_fixture_non_owner_required");
      if (!scopes.length) return { role: role.role, entries: [] as Entry[], revisions: [] as Revision[], projects: [] as Project[] };
      const scopeList = sql.join(scopes.map(scope => sql`${scope}`), sql`, `);
      const entries = await tx.execute<Entry>(sql`select id,scope,namespace,key,revision,value,asset_id as "assetId",deleted_at is not null as deleted,updated_at::text as "updatedAt"
        from creative_studio_entries where tenant_id=${actor.tenantId} and owner_id=${actor.userId} and scope in (${scopeList}) order by scope,namespace,key,id`);
      const revisions = await tx.execute<Revision>(sql`select r.entry_id as "entryId",r.revision,r.value,r.asset_id as "assetId",r.created_at::text as "createdAt"
        from creative_studio_revisions r join creative_studio_entries e on e.tenant_id=r.tenant_id and e.id=r.entry_id
        where e.tenant_id=${actor.tenantId} and e.owner_id=${actor.userId} and e.scope in (${scopeList}) order by r.entry_id,r.revision`);
      const projects = await tx.execute<Project>(sql`select id,status,archived_at is not null as archived from creative_design_batches
        where tenant_id=${actor.tenantId} and created_by=${actor.userId} and id::text in (${scopeList}) and execution_mode='infinite_canvas' order by id`);
      return { role: role.role, entries: Array.from(entries), revisions: Array.from(revisions), projects: Array.from(projects) };
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
  }
  async function facts() {
    if (!fixture || !db || !orm) invalid();
    const actor = await current(), { sql } = orm;
    const extra = await db.withTenant(fixture.database.db, actor, async tx => {
      const tables: Record<string, { count: number; hash: string }> = {};
      for (const name of ["creative_design_batches", "creative_design_batch_items", "creative_design_candidates", "creative_design_versions", "canvas_production_handoffs", "creative_studio_transfers"]) {
        const [row] = await tx.execute<{ count: number; value: string }>(sql`select count(*)::int as count,coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text)::text,'[]') as value
          from ${sql.identifier(name)} t where tenant_id=${actor.tenantId}`);
        if (!row) throw new Error("studio_draft_fixture_facts_missing");
        tables[name] = { count: row.count, hash: sha(row.value) };
      }
      return tables;
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
    return { effects: await fixture.facts(actor), extra, documents: await documents(actor) };
  }
  let cleaning: Promise<unknown> | undefined;
  function cleanup() {
    cleaning ??= (async () => {
      if (!fixture) return null;
      const errors: unknown[] = [];
      let actor: TenantContext | undefined, before: Awaited<ReturnType<typeof documents>> | undefined;
      let removedDocuments = 0, proof: Record<string, unknown> | undefined;
      try {
        try { actor = await current(); before = await documents(actor); } catch (error) { errors.push(cleanupFailure("authority", error)); }
        if (actor && before) {
          for (const scope of scopes) {
            try {
              for (const entry of before.entries.filter(row => row.scope === scope && !row.deleted)) {
                if (entry.namespace !== "app_state" || !allowedKeys.has(entry.key) || entry.assetId) throw new Error("studio_draft_fixture_unexpected_owned_document");
                let revision = entry.revision, removed = false;
                for (let attempt = 0; attempt < 3 && !removed; attempt++) {
                  try { await fixture.invoke(actor, { operation: "state.remove", scope, namespace: "app_state", key: entry.key, revision }); removed = true; removedDocuments++; }
                  catch (error) {
                    const conflict = error && typeof error === "object" && "getStatus" in error && typeof error.getStatus === "function" && error.getStatus() === 409;
                    if (!conflict) throw error;
                    const latest = await fixture.address(actor, scope, "app_state", entry.key);
                    if (latest.deleted) { removed = true; break; }
                    if (latest.count !== 1 || latest.revision === revision) throw error;
                    revision = latest.revision;
                  }
                }
                if (!removed) throw new Error("studio_draft_fixture_cleanup_conflict");
              }
              const keys = await fixture.invoke(actor, { operation: "state.keys", scope, namespace: "app_state" });
              if (keys.operation !== "state.keys" || keys.data.length) throw new Error("studio_draft_fixture_cleanup_visible_document");
            } catch (error) { errors.push(cleanupFailure("documents", error)); }
            try {
              await fixture.pod.cancelDesignBatch(actor, scope);
              await fixture.pod.archiveDesignBatch(actor, scope, { archived: true, reason: "Synthetic draft recovery fixture cleanup f29c6a81" });
            } catch (error) { errors.push(cleanupFailure("archive", error)); }
          }
        }
        if (actor && before) try {
          const after = await documents(actor);
          const originalHistory = after.revisions.filter(row => before!.revisions.some(old => old.entryId === row.entryId && old.revision === row.revision));
          const visible = await fixture.bridge.projectSummaries(actor);
          if (after.entries.length !== before.entries.length || after.entries.some(row => !row.deleted)
            || before.entries.some(old => {
              const retained = after.entries.find(row => row.id === old.id);
              return !retained || retained.scope !== old.scope || retained.namespace !== old.namespace || retained.key !== old.key
                || retained.revision !== old.revision + (old.deleted ? 0 : 1) || retained.assetId !== null || retained.value !== null;
            })
            || JSON.stringify(originalHistory) !== JSON.stringify(before.revisions) || after.revisions.length !== before.revisions.length + removedDocuments
            || before.entries.filter(row => !row.deleted).some(old => !after.revisions.some(row => row.entryId === old.id
              && row.revision === old.revision + 1 && row.assetId === null && row.value === null))
            || after.projects.length !== scopes.length || after.projects.some(row => row.status !== "cancelled" || !row.archived)
            || visible.some(row => scopes.includes(row.id))) throw new Error("studio_draft_fixture_cleanup_not_verified");
          proof = { role: after.role, scopeIds: [...scopes], projectStates: after.projects, removedDocuments, retainedRevisions: after.revisions.length,
            originalHistoryExact: true, remainingLiveDocuments: 0, remainingVisibleProjects: 0, retainedHistory: true };
        } catch (error) { errors.push(cleanupFailure("verification", error)); }
      } catch (error) { errors.unshift(error); }
      finally { try { await fixture.close(); } catch (error) { errors.push(cleanupFailure("base_close", error)); } }
      if (errors.length) throw new AggregateError(errors, "studio_draft_fixture_cleanup_failed");
      return proof;
    })();
    return cleaning;
  }
  process.on("message", (raw: unknown) => { chain = chain.then(async () => {
    const value = raw && typeof raw === "object" ? raw as Record<string, unknown> : null;
    const id = value && typeof value.id === "number" && Number.isSafeInteger(value.id) && value.id > 0 ? value.id : 0;
    try {
      if (!value || !id || value.nonce !== environment.nonce || !["seed", "facts", "close"].includes(String(value.operation)) || closing) invalid();
      const keys = value.operation === "seed" ? ["id", "nonce", "operation", "context"] : ["id", "nonce", "operation"];
      if (Object.keys(value).some(key => !keys.includes(key))) invalid();
      if (value.operation === "close") { closing = true; const proof = await cleanup(); await send({ id, ok: true, result: { closed: true, cleanup: proof } }); process.disconnect(); finish(); return; }
      if (value.operation === "seed") {
        if (fixture) invalid(); const incoming = TenantContextSchema.strict().parse(value.context), api = process.env.API_BASE_URL, token = process.env.API_ACCESS_TOKEN;
        if (!api || !token) invalid();
        const response = await fetch(new URL("/v1/identity/session", api), { redirect: "error", signal: AbortSignal.timeout(15_000), headers: { authorization: "Bearer " + token } });
        if (response.status !== 200) { await response.body?.cancel(); invalid(); }
        const session = ErpSessionViewSchema.parse(await response.json());
        const actors = JSON.parse(process.env.ERP_FIXTURE_ACTORS ?? "null") as { operator?: { userId?: string; tenantId?: string } } | null;
        if (!actors?.operator || incoming.userId !== session.userId || incoming.tenantId !== session.tenantId || session.userId !== actors.operator.userId
          || session.tenantId !== actors.operator.tenantId || erpSessionAuthority(incoming) !== erpSessionAuthority(session)) invalid();
        context = TenantContextSchema.strict().parse(TenantContextSchema.parse(session));
        db = await import("../../packages/database/src/index.js");
        orm = createRequire(new URL("../../packages/database/package.json", import.meta.url))("drizzle-orm") as DrizzleTools;
        const module = await import("../../apps/api/src/design/creative-studio-personal.test-fixture.js"); fixture = await module.createCreativeStudioPersonalFixture({ context });
        const [schema] = await fixture.database.client.unsafe("select current_database() as name,(select count(*)::int from drizzle.__drizzle_migrations) as migrations");
        if (schema?.name !== environment.name || schema.migrations !== 188) invalid();
        for (let index = 0; index < 2; index++) scopes.push((await fixture.project(context)).id);
        const scope = scopes[0]!, targetScope = scopes[1]!, imagePrompt = "Synthetic original image input f29c6a81", videoPrompt = "Synthetic original video input f29c6a81";
        const imageDraft = { version: 1, drafts: [{ id: "draft-image-original", prompt: imagePrompt, references: [], config: { model: "", imageModel: "", size: "640x360", quality: "medium", count: "1" } }], activeId: "draft-image-original" };
        const videoDraft = { version: 1, drafts: [{ id: "draft-video-original", prompt: videoPrompt, references: [], config: { model: "", videoModel: "", size: "16:9", videoSeconds: "4", vquality: "720p", videoGenerateAudio: "false", videoWatermark: "false", videoMode: "text" } }], activeId: "draft-video-original" };
        for (const [key, data] of [[imageKey, imageDraft], [videoKey, videoDraft]] as const)
          await fixture.invoke(context, { operation: "state.set", scope, namespace: "app_state", key, revision: 0, value: data });
        for (const selected of scopes) {
          const target = selected === targetScope;
          const value = JSON.stringify({ version: 0, state: { projects: [{ id: target ? "draft-target-canvas" : "draft-source-canvas", title: target ? "Synthetic existing target" : "Synthetic source preserved",
            createdAt: date, updatedAt: date, nodes: [{ id: "preserved-text", type: "text", title: "Synthetic retained text", position: { x: 10, y: 20 }, width: 280, height: 160, metadata: { content: "Synthetic unchanged input", status: "success" } }],
            connections: [], chatSessions: [], activeChatId: null, viewport: { x: 0, y: 0, k: 1 }, backgroundMode: "lines", showImageInfo: true }], deletedProjects: [] } });
          await fixture.invoke(context, { operation: "state.set", scope: selected, namespace: "app_state", key: "infinite-canvas:canvas_store", revision: 0, value });
          await fixture.invoke(context, { operation: "state.set", scope: selected, namespace: "app_state", key: "infinite-canvas:asset_store", revision: 0, value: JSON.stringify({ version: 0, state: { assets: [] } }) });
        }
        await send({ id, ok: true, result: { nonce: environment.nonce, scope, targetScope, imagePrompt, videoPrompt, imageDraft } }); return;
      }
      if (!fixture || !context || scopes.length !== 2) invalid();
      await send({ id, ok: true, result: await facts() });
    } catch (error) {
      const code = error instanceof Error && /^studio_draft_(?:browser|fixture)_[a-z_]+$/.test(error.message) ? error.message : "studio_draft_browser_operation_failed";
      await send({ id, ok: false, errorCode: code, cleanupPhases: cleanupPhases(error) });
      if (closing) { process.exitCode = 1; process.disconnect(); finish(); }
    }
  }).catch(async () => { process.exitCode = 1; try { await cleanup(); } catch { /* Keep the failed child result. */ } if (process.connected) process.disconnect(); finish(); }); });
  process.once("disconnect", () => { if (!closing) { closing = true; chain = chain.then(cleanup).then(() => { process.exitCode = 1; finish(); }, () => { process.exitCode = 1; finish(); }); } });
  await done;
}
if (process.argv.includes("--studio-draft-recovery-browser-child")) await studioDraftRecoveryBrowserChild().catch(() => { process.exitCode = 1; });
