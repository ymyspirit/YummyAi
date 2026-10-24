import { ErpSessionViewSchema, erpSessionAuthority } from "../../packages/contracts/src/auth/session.js";
import { TenantContextSchema, type TenantContext } from "../../packages/contracts/src/tenant/tenant-context.js";
import { requireStudioVideoDirectoryEnvironment } from "./studio-video-directory-environment.mjs";
import type { createStudioVideoDirectoryFixture } from "../../apps/api/src/design/studio-video-directory.test-fixture.js";

type Fixture = Awaited<ReturnType<typeof createStudioVideoDirectoryFixture>>;
export type StudioVideoBrowserRequest = { id: number; nonce: string; operation: "seed"; context: TenantContext }
  | { id: number; nonce: string; operation: "facts" | "close" };
function invalid(): never { throw new Error("studio_video_browser_request_invalid"); }
async function send(value: unknown) {
  await new Promise<void>((resolve, reject) => {
    if (!process.connected || !process.send) return reject(new Error("studio_video_browser_channel_closed"));
    process.send(value, error => error ? reject(new Error("studio_video_browser_send_failed")) : resolve());
  });
}
export async function studioVideoDirectoryBrowserChild() {
  const environment = requireStudioVideoDirectoryEnvironment(process.env, true);
  let fixture: Fixture | undefined, context: TenantContext | undefined, closing = false, chain = Promise.resolve(), finish!: () => void;
  let scopes: string[] = [];
  const done = new Promise<void>(resolve => { finish = resolve; });
  const cleanup = async () => { await fixture?.close(); };
  process.on("message", (raw: unknown) => { chain = chain.then(async () => {
    const value = raw && typeof raw === "object" ? raw as Record<string, unknown> : null;
    const id = value && Number.isSafeInteger(value.id) && Number(value.id) > 0 ? Number(value.id) : 0;
    try {
      if (!value || !id || value.nonce !== environment.nonce || !["seed", "facts", "close"].includes(String(value.operation)) || closing) invalid();
      const keys = value.operation === "seed" ? ["id", "nonce", "operation", "context"] : ["id", "nonce", "operation"];
      if (Object.keys(value).some(key => !keys.includes(key))) invalid();
      if (value.operation === "close") { closing = true; await cleanup(); await send({ id, ok: true, result: { closed: true } }); process.disconnect(); finish(); return; }
      if (value.operation === "seed") {
        if (fixture) invalid(); const incoming = TenantContextSchema.parse(value.context), api = process.env.API_BASE_URL, token = process.env.API_ACCESS_TOKEN;
        if (!api || !token) invalid();
        const response = await fetch(new URL("/v1/identity/session", api), { redirect: "error", signal: AbortSignal.timeout(15_000), headers: { authorization: "Bearer " + token } });
        if (response.status !== 200) { await response.body?.cancel(); invalid(); }
        const session = ErpSessionViewSchema.parse(await response.json());
        const actors = JSON.parse(process.env.ERP_FIXTURE_ACTORS ?? "null") as { operator?: { userId?: string; tenantId?: string } } | null;
        if (!actors?.operator || session.userId !== actors.operator.userId || session.tenantId !== actors.operator.tenantId
          || incoming.userId !== session.userId || incoming.tenantId !== session.tenantId || erpSessionAuthority(incoming) !== erpSessionAuthority(session)) invalid();
        context = TenantContextSchema.parse(session);
        const module = await import("../../apps/api/src/design/studio-video-directory.test-fixture.js"); fixture = await module.createStudioVideoDirectoryFixture({ context });
        const [schema] = await fixture.database.client.unsafe("select current_database() as name,(select count(*)::int from drizzle.__drizzle_migrations) as migrations");
        if (schema?.name !== environment.name || schema.migrations !== 188) invalid();
        const safe = await fixture.seed(context, "safe"), mixed = await fixture.seed(context, "mixed"); scopes = [safe.scope, mixed.scope];
        await send({ id, ok: true, result: { nonce: environment.nonce, safe, mixed } }); return;
      }
      if (!fixture || !context || scopes.length !== 2) invalid();
      const documents = await fixture.documents(context, [scopes[0]!, scopes[1]!]);
      await send({ id, ok: true, result: { effects: await fixture.facts(context), logs: await Promise.all(scopes.map(scope => fixture!.logs(context!, scope))), documents } });
    } catch (error) {
      const code = error instanceof Error && /^studio_video_(?:browser|fixture)_[a-z_]+$/.test(error.message) ? error.message : "studio_video_browser_operation_failed";
      await send({ id, ok: false, errorCode: code }); if (closing) { process.exitCode = 1; process.disconnect(); finish(); }
    }
  }).catch(async () => { process.exitCode = 1; try { await cleanup(); } catch { /* Retained nonzero cleanup failure. */ } if (process.connected) process.disconnect(); finish(); }); });
  process.once("disconnect", () => { if (!closing) { closing = true; chain = chain.then(cleanup).then(() => { process.exitCode = 1; finish(); }, () => { process.exitCode = 1; finish(); }); } });
  await done;
}
if (process.argv.includes("--studio-video-directory-browser-child")) await studioVideoDirectoryBrowserChild().catch(() => { process.exitCode = 1; });
