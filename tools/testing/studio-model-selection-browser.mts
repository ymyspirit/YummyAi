import { ErpSessionViewSchema, erpSessionAuthority } from "../../packages/contracts/src/auth/session.js";
import { TenantContextSchema, type TenantContext } from "../../packages/contracts/src/tenant/tenant-context.js";
import { requireStudioModelSelectionEnvironment } from "./studio-model-selection-environment.mjs";
import type { createStudioModelSelectionFixture, StudioModelFixtureSeed, StudioModelCleanupPhase } from "../../apps/api/src/design/studio-model-selection.test-fixture.js";

type Fixture = Awaited<ReturnType<typeof createStudioModelSelectionFixture>>;
function cleanupPhases(error: unknown): StudioModelCleanupPhase[] {
  const phases = new Set<StudioModelCleanupPhase>(), visited = new Set<Error>();
  const read = (value: unknown, depth: number) => {
    if (!(value instanceof Error) || visited.has(value) || depth > 5 || visited.size >= 24) return;
    visited.add(value);
    const match = /^studio_model_fixture_cleanup_(authority|documents|archive|channels|verification|base_close)_failed$/.exec(value.message);
    if (match) phases.add(match[1] as StudioModelCleanupPhase);
    if (value instanceof AggregateError) for (const nested of value.errors) read(nested, depth + 1);
    read(value.cause, depth + 1);
  };
  read(error, 0); return [...phases];
}
export type StudioModelBrowserRequest = { id: number; nonce: string; operation: "seed"; context: TenantContext }
  | { id: number; nonce: string; operation: "mutate"; mutation: "disable" | "change_capability" | "empty" }
  | { id: number; nonce: string; operation: "facts" | "close" };
function invalid(): never { throw new Error("studio_model_browser_request_invalid"); }
async function send(value: unknown) {
  await new Promise<void>((resolve, reject) => {
    if (!process.connected || !process.send) return reject(new Error("studio_model_browser_channel_closed"));
    process.send(value, error => error ? reject(new Error("studio_model_browser_send_failed")) : resolve());
  });
}

/** Only this authenticated fixture's seed, known channel changes and read-only
 * facts are admitted. IPC never accepts arbitrary SQL, provider URLs or IDs. */
export async function studioModelSelectionBrowserChild() {
  const environment = requireStudioModelSelectionEnvironment(process.env, true);
  let fixture: Fixture | undefined, context: TenantContext | undefined, seed: StudioModelFixtureSeed | undefined;
  let closing = false, chain = Promise.resolve(), finish!: () => void;
  const done = new Promise<void>(resolve => { finish = resolve; });
  const cleanup = async () => await fixture?.close();
  process.on("message", (raw: unknown) => { chain = chain.then(async () => {
    const value = raw && typeof raw === "object" ? raw as Record<string, unknown> : null;
    const id = value && typeof value.id === "number" && Number.isSafeInteger(value.id) && value.id > 0 ? value.id : 0;
    try {
      if (!value || !id || value.nonce !== environment.nonce || !["seed", "mutate", "facts", "close"].includes(String(value.operation)) || closing) invalid();
      const keys = value.operation === "seed" ? ["id", "nonce", "operation", "context"] : value.operation === "mutate" ? ["id", "nonce", "operation", "mutation"] : ["id", "nonce", "operation"];
      if (Object.keys(value).some(key => !keys.includes(key))) invalid();
      if (value.operation === "close") { closing = true; const proof = await cleanup(); await send({ id, ok: true, result: { closed: true, cleanup: proof } }); process.disconnect(); finish(); return; }
      if (value.operation === "seed") {
        if (fixture) invalid(); const incoming = TenantContextSchema.strict().parse(value.context), api = process.env.API_BASE_URL, token = process.env.API_ACCESS_TOKEN;
        if (!api || !token) invalid();
        const response = await fetch(new URL("/v1/identity/session", api), { redirect: "error", signal: AbortSignal.timeout(15_000), headers: { authorization: "Bearer " + token } });
        if (response.status !== 200) { await response.body?.cancel(); invalid(); }
        const session = ErpSessionViewSchema.parse(await response.json());
        const actors = JSON.parse(process.env.ERP_FIXTURE_ACTORS ?? "null") as { operator?: { userId?: string; tenantId?: string } } | null;
        if (!actors?.operator || session.userId !== actors.operator.userId || session.tenantId !== actors.operator.tenantId
          || incoming.userId !== session.userId || incoming.tenantId !== session.tenantId || erpSessionAuthority(incoming) !== erpSessionAuthority(session)) invalid();
        context = TenantContextSchema.strict().parse(TenantContextSchema.parse(session));
        const module = await import("../../apps/api/src/design/studio-model-selection.test-fixture.js"); fixture = await module.createStudioModelSelectionFixture({ context });
        const [schema] = await fixture.database.client.unsafe("select current_database() as name,(select count(*)::int from drizzle.__drizzle_migrations) as migrations");
        if (schema?.name !== environment.name || schema.migrations !== 188) invalid();
        if ((await fixture.catalogue(context)).length) throw new Error("studio_model_fixture_initial_catalogue_not_empty");
        seed = await fixture.seed(context); await send({ id, ok: true, result: { nonce: environment.nonce, ...seed } }); return;
      }
      if (!fixture || !context || !seed) invalid();
      if (value.operation === "mutate") {
        if (value.mutation === "disable") await fixture.status(context, seed.channelId, "disabled");
        else if (value.mutation === "change_capability") {
          await fixture.status(context, seed.channelId, "enabled"); await fixture.changeCapability(context, seed.channelId, seed.video.id, "image");
        } else if (value.mutation === "empty") {
          await fixture.status(context, seed.channelId, "disabled"); await fixture.status(context, seed.duplicateChannelId, "disabled");
        } else invalid();
        await send({ id, ok: true, result: { mutation: value.mutation, catalogue: await fixture.catalogue(context) } }); return;
      }
      await send({ id, ok: true, result: { effects: await fixture.facts(context), documents: await fixture.documents(context, seed.scope) } });
    } catch (error) {
      const code = error instanceof Error && /^studio_model_(?:browser|fixture)_[a-z_]+$/.test(error.message) ? error.message : "studio_model_browser_operation_failed";
      const phases = cleanupPhases(error);
      await send({ id, ok: false, errorCode: code, ...(phases.length ? { cleanupPhases: phases } : {}) }); if (closing) { process.exitCode = 1; process.disconnect(); finish(); }
    }
  }).catch(async () => { process.exitCode = 1; try { await cleanup(); } catch { /* A nonzero close failure stays visible. */ } if (process.connected) process.disconnect(); finish(); }); });
  process.once("disconnect", () => { if (!closing) { closing = true; chain = chain.then(cleanup).then(() => { process.exitCode = 1; finish(); }, () => { process.exitCode = 1; finish(); }); } });
  await done;
}
if (process.argv.includes("--studio-model-selection-browser-child")) await studioModelSelectionBrowserChild().catch(() => { process.exitCode = 1; });
