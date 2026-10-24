import { ErpSessionViewSchema, erpSessionAuthority } from "../../packages/contracts/src/auth/session.js";
import { TenantContextSchema, type TenantContext } from "../../packages/contracts/src/tenant/tenant-context.js";
import { requireStudioOriginalEnvironment } from "./require-studio-original-environment.mjs";
import type { createStudioOriginalFixture } from "../../apps/api/src/design/studio-original.test-fixture.js";

export type StudioOriginalBrowserRequest = { id: number; nonce: string; operation: "seed"; context: TenantContext; scenario: "handoff" | "lifecycle" }
  | { id: number; nonce: string; operation: "facts" | "close" };
export type StudioOriginalBrowserSeed = { nonce: string; scope: string; key: string; assetId: string; canvasId: string;
  canvasTitle: string; imageTitle: string; text: string; checksumSha256: string; byteSize: number; width: number; height: number;
  viewport: { x: number; y: number; k: number } };
type Fixture = Awaited<ReturnType<typeof createStudioOriginalFixture>>;
type Packet = { id: number; ok: true; result: unknown } | { id: number; ok: false; errorCode: string };

function invalid(): never { throw new Error("studio_original_browser_request_invalid"); }
async function send(packet: Packet) {
  await new Promise<void>((resolve, reject) => {
    if (!process.send || !process.connected) return reject(new Error("studio_original_browser_channel_closed"));
    process.send(packet, error => error ? reject(new Error("studio_original_browser_channel_closed")) : resolve());
  });
}
/** IPC admits only one authenticated synthetic seed, exact seeded facts and
 * failure-safe close. It cannot execute SQL, caller-selected mutations or URLs. */
export async function studioOriginalBrowserChild() {
  const environment = requireStudioOriginalEnvironment(process.env, true);
  let fixture: Fixture | undefined, context: TenantContext | undefined, seed: StudioOriginalBrowserSeed | undefined;
  let closing = false, chain = Promise.resolve(), finish!: () => void;
  const done = new Promise<void>(resolve => { finish = resolve; });
  const cleanup = async () => { await fixture?.close(); };
  process.on("message", (raw: unknown) => {
    chain = chain.then(async () => {
      const value = raw && typeof raw === "object" ? raw : null;
      const id = value && "id" in value && typeof value.id === "number" && Number.isSafeInteger(value.id) && value.id > 0 ? value.id : 0;
      try {
        if (!id || !value || !("nonce" in value) || value.nonce !== environment.nonce || !("operation" in value)
          || !["seed", "facts", "close"].includes(String(value.operation)) || closing) invalid();
        const allowed = value.operation === "seed" ? ["id", "nonce", "operation", "context", "scenario"] : ["id", "nonce", "operation"];
        if (Object.keys(value).some(key => !allowed.includes(key))) invalid();
        if (value.operation === "close") {
          closing = true; await cleanup(); await send({ id, ok: true, result: { closed: true } }); process.disconnect(); finish(); return;
        }
        if (value.operation === "seed") {
          if (fixture || seed || !("context" in value) || !("scenario" in value) || !["handoff", "lifecycle"].includes(String(value.scenario))) invalid();
          const incoming = TenantContextSchema.parse(value.context), api = process.env.API_BASE_URL, token = process.env.API_ACCESS_TOKEN;
          if (!api || !token) invalid();
          const response = await fetch(new URL("/v1/identity/session", api), { redirect: "error", signal: AbortSignal.timeout(15_000), headers: { authorization: "Bearer " + token } });
          if (response.status !== 200) { await response.body?.cancel(); invalid(); }
          const session = ErpSessionViewSchema.parse(await response.json());
          const actors = JSON.parse(process.env.ERP_FIXTURE_ACTORS ?? "null") as { operator?: { userId?: string; tenantId?: string } } | null;
          if (!actors?.operator || session.userId !== actors.operator.userId || session.tenantId !== actors.operator.tenantId
            || incoming.userId !== session.userId || incoming.tenantId !== session.tenantId
            || erpSessionAuthority(incoming) !== erpSessionAuthority(session)) invalid();
          context = TenantContextSchema.parse(session);
          const module = await import("../../apps/api/src/design/studio-original.test-fixture.js");
          fixture = await module.createStudioOriginalFixture({ context });
          if (value.scenario === "handoff") context = await fixture.noReview(context);
          const project = await fixture.project(context), upload = await fixture.upload(context, project.id, fixture.media.png);
          if (value.scenario === "handoff") await fixture.legacy(context, project.id,
            Buffer.from("1a45dfa300000000000000000000000000000000", "hex"), "video/webm");
          const canvasId = "original-canvas-a", canvasTitle = "Synthetic original canvas A", text = "Synthetic A private original text";
          const imageTitle = "synthetic-original-640x360.png", viewport = { x: 137, y: 83, k: 0.65 }, now = "2026-10-24T08:00:00.000Z";
          const document = { state: { projects: [{ id: canvasId, title: canvasTitle, createdAt: now, updatedAt: now,
            nodes: [{ id: "original-a-text", type: "text", title: "Synthetic original text", position: { x: 140, y: 130 }, width: 280, height: 150,
              metadata: { content: text, status: "success" } },
            { id: "original-a-image", type: "image", title: imageTitle, position: { x: 480, y: 130 }, width: 320, height: 180,
              metadata: { content: "blob:previous-synthetic-session", storageKey: upload.key, naturalWidth: 640, naturalHeight: 360,
                bytes: fixture.media.png.length, mimeType: "image/png", status: "success" } }],
            connections: [{ id: "original-a-connection", fromNodeId: "original-a-text", toNodeId: "original-a-image" }],
            chatSessions: [], activeChatId: null, backgroundMode: "lines", showImageInfo: false, viewport }], deletedProjects: [] }, version: 0 };
          await fixture.invoke(context, { scope: project.id, operation: "state.set", namespace: "app_state", key: "infinite-canvas:canvas_store", revision: 0, value: JSON.stringify(document) });
          seed = { nonce: environment.nonce, scope: project.id, key: upload.key, assetId: upload.assetId, canvasId, canvasTitle, imageTitle, text,
            checksumSha256: module.studioOriginalFixtureSha(fixture.media.png), byteSize: fixture.media.png.length, width: 640, height: 360, viewport };
          await send({ id, ok: true, result: seed }); return;
        }
        if (!fixture || !context || !seed) invalid();
        await send({ id, ok: true, result: { paid: await fixture.facts(context), candidates: await fixture.candidates(context, seed.scope),
          documents: await fixture.documents(context, seed.scope), source: await fixture.source(context, seed.assetId).then(row => ({
            id: row.id, version: row.version, checksumSha256: row.checksumSha256, byteSize: row.byteSize, rightsStatus: row.rightsStatus,
          })) } });
      } catch (error) {
        const code = error instanceof Error && /^studio_original_(?:browser|fixture)_[a-z_]+$/.test(error.message) ? error.message : "studio_original_browser_operation_failed";
        await send({ id, ok: false, errorCode: code });
        if (closing) { process.exitCode = 1; process.disconnect(); finish(); }
      }
    }).catch(async () => {
      process.exitCode = 1; try { await cleanup(); } catch { /* Nonzero exit preserves cleanup failure. */ }
      if (process.connected) process.disconnect(); finish();
    });
  });
  process.once("disconnect", () => { if (!closing) {
    closing = true; chain = chain.then(cleanup).then(() => { process.exitCode = 1; finish(); }, () => { process.exitCode = 1; finish(); });
  } });
  await done;
}
if (process.argv.includes("--studio-original-browser-child")) await studioOriginalBrowserChild().catch(() => { process.exitCode = 1; });
