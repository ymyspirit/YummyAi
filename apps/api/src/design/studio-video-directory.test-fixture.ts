import { randomUUID } from "node:crypto";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { StudioRpcSchema } from "@yummyai/contracts/pod/creative-studio";
import { StudioVideoDirectorySchema, StudioVideoPreflightSchema } from "@yummyai/contracts/pod/studio-video-directory";
import { creativeStudioEntries, creativeStudioRevisions, creativeStudioGenerations, withTenant } from "@yummyai/database";
import { and, asc, eq, sql } from "drizzle-orm";
import { createCreativeStudioPersonalFixture, studioPersonalSha } from "./creative-studio-personal.test-fixture.js";
import { requireStudioVideoDirectoryEnvironment } from "../../../../tools/testing/studio-video-directory-environment.mjs";

export const videoFixtureDate = 1_792_780_000_000;
export function nativeVideoLog(key: string, status: "pending" | "success" | "failed" = "failed") {
  return { id: key, title: "Synthetic native video " + key, createdAt: videoFixtureDate, prompt: "SYNTHETIC_PRIVATE_PROMPT_b6e9a3f2",
    time: "00:00", model: "synthetic-history-video", config: { model: "synthetic-history-video", videoModel: "synthetic-history-video", size: "640x360",
      vquality: "720p", videoSeconds: "4", videoGenerateAudio: "false", videoWatermark: "false", videoMode: "text" },
    references: [], durationMs: 1, size: "640x360", resolution: "720p", seconds: "4", status,
    ...(status === "pending" ? { task: { id: "synthetic-untracked-provider-task", provider: "openai", model: "synthetic-history-video" } } : {}),
  };
}
export function frozenVideoLog(key: string) {
  return { ...nativeVideoLog(key, "pending"), _yummyaiOrigin: { version: 1, sourceScope: "unassigned", requestId: randomUUID(), executionFrozen: true } };
}

/** Composes actual personal owners. Direct admissions below are explicitly
 * synthetic legacy/corrupt rows confined to the nonce database, never jobs. */
export async function createStudioVideoDirectoryFixture(options: Parameters<typeof createCreativeStudioPersonalFixture>[0] = {}) {
  const environment = requireStudioVideoDirectoryEnvironment(), base = await createCreativeStudioPersonalFixture(options);
  const counts = { get: 0, create: 0, bridge: 0 }, restorers: Array<() => void> = [];
  function observe<T extends object, K extends keyof T>(target: T, key: K, before: () => void) {
    const original = target[key];
    if (typeof original !== "function") throw new Error("studio_video_fixture_observer_missing");
    target[key] = function(this: T, ...args: unknown[]) { before(); return Reflect.apply(original, this, args); } as T[K];
    restorers.push(() => { target[key] = original; });
  }
  try {
    observe(base.generations, "get", () => counts.get++); observe(base.generations, "create", () => counts.create++);
    observe(base.bridge, "submit", () => counts.bridge++);
  } catch (error) { for (const restore of restorers.reverse()) restore(); await base.close(); throw error; }
  const invoke = (context: TenantContext, raw: unknown) => base.invoke(context, StudioRpcSchema.parse(raw));
  async function directory(context: TenantContext, scope: string) {
    const reply = await invoke(context, { operation: "video.directory", scope });
    if (reply.operation !== "video.directory") throw new Error("studio_video_fixture_directory_reply_invalid");
    return StudioVideoDirectorySchema.parse(reply.data);
  }
  async function preflight(context: TenantContext, scope: string, snapshotHash: string) {
    const reply = await invoke(context, { operation: "video.preflight", scope, snapshotHash });
    if (reply.operation !== "video.preflight") throw new Error("studio_video_fixture_preflight_reply_invalid");
    return StudioVideoPreflightSchema.parse(reply.data);
  }
  async function rawLogs(context: TenantContext, scope: string, rows: Array<{ key: string; value: unknown; assetId?: string }>) {
    const admitted: Array<{ entryId: string; key: string }> = [];
    await withTenant(base.database.db, context, async tx => {
      for (let offset = 0; offset < rows.length; offset += 250) {
        const entries = rows.slice(offset, offset + 250).map(row => ({ id: createEntityId(), tenantId: context.tenantId,
          ownerId: context.userId, scope, namespace: "video_generation_logs", key: row.key, value: row.value,
          revision: 1, ...(row.assetId ? { assetId: row.assetId } : {}) }));
        await tx.insert(creativeStudioEntries).values(entries);
        await tx.insert(creativeStudioRevisions).values(entries.map(row => ({ id: createEntityId(), tenantId: row.tenantId,
          entryId: row.id, revision: 1, value: row.value, assetId: row.assetId })));
        admitted.push(...entries.map(row => ({ entryId: row.id, key: row.key })));
      }
    });
    return admitted;
  }
  async function revise(context: TenantContext, scope: string, key: string, value?: unknown, remove = false) {
    const prior = await invoke(context, { scope, operation: "state.get", namespace: "video_generation_logs", key });
    if (prior.operation !== "state.get") throw new Error("studio_video_fixture_revision_missing");
    return invoke(context, { scope, namespace: "video_generation_logs", key, revision: prior.data.revision,
      ...(remove ? { operation: "state.remove" } : { operation: "state.set", value }) });
  }
  async function generation(context: TenantContext, scope: string, capability: "image" | "video" = "video") {
    const id = createEntityId();
    await withTenant(base.database.db, context, tx => tx.insert(creativeStudioGenerations).values({ id, tenantId: context.tenantId,
      ownerId: context.userId, scope, requestId: randomUUID(), input: { requestId: randomUUID(), modelId: createEntityId(), prompt: "SYNTHETIC_PRIVATE_GENERATION_PROMPT",
        referenceKeys: [], size: "640x360", quality: "medium", background: "opaque", seconds: 4 },
      modelSnapshot: { providerConfigId: createEntityId(), model: "synthetic-history-video", capability }, references: [],
      status: "running", providerTaskId: "SYNTHETIC_PRIVATE_PROVIDER_TASK_ID", error: "SYNTHETIC_PRIVATE_PROVIDER_ERROR" }));
    return id;
  }
  async function generationStatus(context: TenantContext, id: string, status: "queued" | "running" | "completed" | "failed") {
    await withTenant(base.database.db, context, tx => tx.update(creativeStudioGenerations).set({ status }).where(eq(creativeStudioGenerations.id, id)));
  }
  async function facts(context: TenantContext) {
    const originals = await base.facts(context);
    const tables = await withTenant(base.database.db, context, async tx => {
      const values: Record<string, { count: number; hash: string }> = {};
      for (const table of ["creative_studio_entries", "creative_studio_revisions", "creative_studio_generations", "creative_design_candidates",
        "creative_design_versions", "creative_design_batches", "creative_design_batch_items", "design_versions", "creative_executions", "ai_budget_ledger",
        "asset_files", "audit_events"]) {
        const [row] = await tx.execute<{ count: number; body: string }>(sql`select count(*)::int as count,coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text)::text,'[]') as body from ${sql.identifier(table)} t`);
        if (!row) throw new Error("studio_video_fixture_facts_missing"); values[table] = { count: row.count, hash: studioPersonalSha(row.body) };
      }
      return values;
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
    return { ...originals, tables: { ...originals.tables, ...tables }, videoCalls: { ...counts } };
  }
  async function logs(context: TenantContext, scope: string) {
    return withTenant(base.database.db, context, tx => tx.select().from(creativeStudioEntries).where(and(eq(creativeStudioEntries.ownerId, context.userId),
      eq(creativeStudioEntries.scope, scope), eq(creativeStudioEntries.namespace, "video_generation_logs")))
      .orderBy(asc(creativeStudioEntries.scope), asc(creativeStudioEntries.id)));
  }
  async function documents(context: TenantContext, scopes: readonly [string, string]) {
    return withTenant(base.database.db, context, async tx => {
      const [role] = await tx.execute<{ role: string }>(sql`select current_user as role`);
      if (role?.role !== "yummyai_app") throw new Error("studio_video_fixture_non_owner_required");
      const entries = await tx.execute(sql`select scope,namespace,key,revision,encode(sha256(convert_to(coalesce(value::text,'null'),'UTF8')),'hex') as value_sha256
        from creative_studio_entries where tenant_id=${context.tenantId} and owner_id=${context.userId}
        and scope in (${scopes[0]},${scopes[1]}) order by scope,namespace,key`);
      return { role: role.role, entries: Array.from(entries) };
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
  }
  async function seed(context: TenantContext, scenario: "mixed" | "safe" | "late") {
    const scope = (await base.project(context)).id, key = "video-frozen-" + createEntityId();
    const frozen = frozenVideoLog(key), prompt = "Synthetic unsent video draft b6e9a3f2";
    await rawLogs(context, scope, [{ key, value: frozen }]);
    if (scenario === "mixed") {
      await rawLogs(context, scope, Array.from({ length: 63 }, (_, index) => { const key = "tail-history-" + index; return { key, value: nativeVideoLog(key) }; }));
      // Separate committed seed step: the unsafe record is the real final
      // source entry, beyond both the old forty-row prefix and UI's first fifty.
      await rawLogs(context, scope, [{ key: "video-last-unsafe", value: nativeVideoLog("video-last-unsafe", "pending") }]);
    }
    await invoke(context, { scope, operation: "state.set", namespace: "app_state", key: "infinite-canvas:video_draft", revision: 0,
      value: { version: 1, drafts: [{ id: "video-draft-b6e9a3f2", prompt, references: [], config: frozen.config }], activeId: "video-draft-b6e9a3f2" } });
    await invoke(context, { scope, operation: "state.set", namespace: "app_state", key: "infinite-canvas:image_draft", revision: 0,
      value: { version: 1, drafts: [{ id: "image-draft-b6e9a3f2", prompt: "Synthetic unsent image draft b6e9a3f2", references: [],
        config: { model: "synthetic-history-image", imageModel: "synthetic-history-image", size: "640x360", quality: "medium", count: "1" } }], activeId: "image-draft-b6e9a3f2" } });
    await invoke(context, { scope, operation: "state.set", namespace: "app_state", key: "infinite-canvas:canvas_store", revision: 0,
      value: JSON.stringify({ version: 0, state: { projects: [{ id: "video-directory-canvas", title: "Synthetic retained canvas", createdAt: videoFixtureDate,
        updatedAt: videoFixtureDate, nodes: [{ id: "retained-text", type: "text", title: "Retained text", position: { x: 20, y: 30 }, width: 280, height: 160,
          metadata: { content: "Synthetic retained source content", status: "success" } }], connections: [], chatSessions: [], activeChatId: null,
        viewport: { x: 0, y: 0, k: 1 }, backgroundMode: "lines", showImageInfo: true }], deletedProjects: [] } }) });
    await invoke(context, { scope, operation: "state.set", namespace: "app_state", key: "infinite-canvas:asset_store", revision: 0,
      value: JSON.stringify({ version: 0, state: { assets: [] } }) });
    return { scope, key, prompt, frozen };
  }
  async function close() { for (const restore of restorers.splice(0).reverse()) restore(); await base.close(); }
  return { ...base, environment, invoke, directory, preflight, rawLogs, revise, generation, generationStatus, facts, logs, documents, seed, videoCounts: counts, close };
}
