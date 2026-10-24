import { ErpSessionViewSchema, erpSessionAuthority } from "../../packages/contracts/src/auth/session.js";
import { TenantContextSchema, type TenantContext } from "../../packages/contracts/src/tenant/tenant-context.js";
import { requireStudioPersonalEnvironment } from "./require-studio-personal-environment.mjs";
import type { createCreativeStudioPersonalFixture } from "../../apps/api/src/design/creative-studio-personal.test-fixture.js";

export type StudioPersonalBrowserRequest = { id: number; nonce: string; operation: "seed"; context: TenantContext }
  | { id: number; nonce: string; operation: "facts" | "close" };
export type StudioPersonalBrowserFacts = Awaited<ReturnType<Awaited<ReturnType<typeof createCreativeStudioPersonalFixture>>["facts"]>>;
export type StudioPersonalBrowserPacket = { id: number; ok: true; result: { scope: string; nonce: string } | StudioPersonalBrowserFacts | { closed: true } }
  | { id: number; ok: false; errorCode: string };

function fail(code: string): never { throw new Error(code); }
function safeCode(error: unknown) {
  if (error instanceof Error && /^studio_personal_(?:browser|fixture)_[a-z_]+$/.test(error.message)) return error.message;
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string" && /^[A-Z0-9]{5}$/.test(error.code)) return error.code;
  return "studio_personal_browser_operation_failed";
}
async function send(packet: StudioPersonalBrowserPacket) {
  await new Promise<void>((resolve, reject) => {
    if (!process.send || !process.connected) { reject(new Error("studio_personal_browser_channel_closed")); return; }
    process.send(packet, error => error ? reject(new Error("studio_personal_browser_channel_closed")) : resolve());
  });
}

export async function studioPersonalBrowserChild() {
  const environment = requireStudioPersonalEnvironment(process.env, true);
  let fixture: Awaited<ReturnType<typeof createCreativeStudioPersonalFixture>> | undefined;
  let context: TenantContext | undefined, seeded = false, closing = false, chain = Promise.resolve();
  let finish!: () => void;
  const done = new Promise<void>(resolve => { finish = resolve; });
  const cleanup = async () => { if (fixture) await fixture.close(); };
  // Install the original channel listener before the first await so an immediate
  // parent seed cannot disappear during dynamic owner-module loading.
  process.on("message", (raw: unknown) => {
    chain = chain.then(async () => {
      const value = raw && typeof raw === "object" ? raw : null;
      const id = value && "id" in value && Number.isSafeInteger(value.id) && typeof value.id === "number" && value.id > 0 ? value.id : 0;
      try {
        if (!id || !value || !("nonce" in value) || value.nonce !== environment.nonce || !("operation" in value)
          || !["seed", "facts", "close"].includes(String(value.operation)) || closing) fail("studio_personal_browser_request_invalid");
        const allowed = value.operation === "seed" ? ["id", "nonce", "operation", "context"] : ["id", "nonce", "operation"];
        if (Object.keys(value).some(key => !allowed.includes(key))) fail("studio_personal_browser_request_invalid");
        if (value.operation === "close") {
          closing = true; await cleanup(); await send({ id, ok: true, result: { closed: true } });
          process.disconnect(); finish(); return;
        }
        if (value.operation === "seed") {
          if (seeded || fixture || !("context" in value)) fail("studio_personal_browser_seed_once");
          const incoming = TenantContextSchema.parse(value.context);
          const api = process.env.API_BASE_URL, token = process.env.API_ACCESS_TOKEN;
          if (!api || !token) fail("studio_personal_browser_identity_missing");
          const response = await fetch(new URL("/v1/identity/session", api), { redirect: "error", headers: { authorization: "Bearer " + token }, signal: AbortSignal.timeout(15_000) });
          if (response.status !== 200) { await response.body?.cancel(); fail("studio_personal_browser_identity_rejected"); }
          const session = ErpSessionViewSchema.parse(await response.json());
          const actors = JSON.parse(process.env.ERP_FIXTURE_ACTORS ?? "null") as { operator?: { userId?: string; tenantId?: string } } | null;
          if (!actors?.operator || session.userId !== actors.operator.userId || session.tenantId !== actors.operator.tenantId
            || incoming.userId !== session.userId || incoming.tenantId !== session.tenantId
            || erpSessionAuthority(incoming) !== erpSessionAuthority(session)) fail("studio_personal_browser_identity_mismatch");
          context = TenantContextSchema.parse(session);
          const module = await import("../../apps/api/src/design/creative-studio-personal.test-fixture.js");
          fixture = await module.createCreativeStudioPersonalFixture({ context });
          const project = await fixture.project(context); seeded = true;
          await send({ id, ok: true, result: { scope: project.id, nonce: environment.nonce } }); return;
        }
        if (!fixture || !context || !seeded) fail("studio_personal_browser_not_seeded");
        await send({ id, ok: true, result: await fixture.facts(context) });
      } catch (error) {
        await send({ id, ok: false, errorCode: safeCode(error) });
        if (closing) { process.exitCode = 1; process.disconnect(); finish(); }
      }
    }).catch(async () => {
      process.exitCode = 1; try { await cleanup(); } catch { /* Failed cleanup remains an unsuccessful child exit. */ }
      if (process.connected) process.disconnect(); finish();
    });
  });
  process.once("disconnect", () => { if (!closing) {
    closing = true; chain = chain.then(cleanup).then(() => { process.exitCode = 1; finish(); }, () => { process.exitCode = 1; finish(); });
  } });
  await done;
}

if (process.argv.includes("--studio-personal-browser-child")) {
  await studioPersonalBrowserChild().catch(() => { process.exitCode = 1; if (process.connected) process.disconnect(); });
}
