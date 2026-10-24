import { ErpSessionViewSchema, erpSessionAuthority } from "../../packages/contracts/src/auth/session.js";
import { TenantContextSchema, type TenantContext } from "../../packages/contracts/src/tenant/tenant-context.js";
import { requireStudioDocumentTransferEnvironment } from "./require-studio-document-transfer-environment.mjs";
import type { createStudioDocumentTransferFixture } from "../../apps/api/src/design/studio-document-transfer.test-fixture.js";

export type StudioDocumentTransferBrowserRequest = { id: number; nonce: string; operation: "seed"; context: TenantContext; scenario: "complete" | "recovery" }
  | { id: number; nonce: string; operation: "facts" | "close" };
export type StudioDocumentTransferBrowserSeed = { nonce: string; scope: string; targetScope: string; canvasId: string; sourceTitle: string; targetTitle: string;
  literal: string; imageDraftPrompt: string; videoDraftPrompt: string; intentKey: string; viewport: { x: number; y: number; k: number };
  media: Array<{ key: string; namespace: "image_files" | "media_files"; assetId: string; checksumSha256: string; byteSize: number; mediaType: string }> };
type Fixture = Awaited<ReturnType<typeof createStudioDocumentTransferFixture>>;
type Packet = { id: number; ok: true; result: unknown } | { id: number; ok: false; errorCode: string };
function invalid(): never { throw new Error("studio_transfer_browser_request_invalid"); }
async function send(packet: Packet) {
  await new Promise<void>((resolve, reject) => {
    if (!process.send || !process.connected) return reject(new Error("studio_transfer_browser_channel_closed"));
    process.send(packet, error => error ? reject(new Error("studio_transfer_browser_channel_closed")) : resolve());
  });
}

/** Exact authenticated synthetic seed and seeded read-only facts only. No
 * caller-selected SQL, scopes, object mutations, provider jobs or URLs enter IPC. */
export async function studioDocumentTransferBrowserChild() {
  const environment = requireStudioDocumentTransferEnvironment(process.env, true);
  let fixture: Fixture | undefined, context: TenantContext | undefined, seed: StudioDocumentTransferBrowserSeed | undefined;
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
          if (fixture || seed || !("context" in value) || !("scenario" in value) || !["complete", "recovery"].includes(String(value.scenario))) invalid();
          const incoming = TenantContextSchema.parse(value.context), api = process.env.API_BASE_URL, token = process.env.API_ACCESS_TOKEN;
          if (!api || !token) invalid();
          const response = await fetch(new URL("/v1/identity/session", api), { redirect: "error", signal: AbortSignal.timeout(15_000), headers: { authorization: "Bearer " + token } });
          if (response.status !== 200) { await response.body?.cancel(); invalid(); }
          const session = ErpSessionViewSchema.parse(await response.json());
          const actors = JSON.parse(process.env.ERP_FIXTURE_ACTORS ?? "null") as { operator?: { userId?: string; tenantId?: string } } | null;
          if (!actors?.operator || session.userId !== actors.operator.userId || session.tenantId !== actors.operator.tenantId
            || incoming.userId !== session.userId || incoming.tenantId !== session.tenantId || erpSessionAuthority(incoming) !== erpSessionAuthority(session)) invalid();
          context = TenantContextSchema.parse(session);
          const module = await import("../../apps/api/src/design/studio-document-transfer.test-fixture.js");
          fixture = await module.createStudioDocumentTransferFixture({ context }); await fixture.schemaEvidence();
          const source = await fixture.project(context), target = await fixture.project(context);
          const documents = await fixture.seed(context, source.id, "source", value.scenario === "complete");
          const targetDocuments = await fixture.seed(context, target.id, "target");
          // These are legitimate previously copied histories. The source native
          // page otherwise resumes any unmarked pending provider task on load.
          // This transfer must replace the old origin with its own source/id.
          for (const [scope, history] of [[source.id, documents.videoLog], [target.id, targetDocuments.videoLog]] as const)
            await fixture.save(context, scope, history.id, { ...history,
              _yummyaiOrigin: { version: 1, sourceScope: "unassigned", requestId: "00000000-0000-4000-8000-000000000001", executionFrozen: true } }, 1, "video_generation_logs");
          // Use browser-native WebM for visible playback. MP4 remains an
          // independently pinned unreferenced original in the complete seed.
          if (value.scenario === "complete") {
            const canvas = fixture.copy(documents.canvas), video = canvas.state.projects[0]!.nodes.find(node => node.id === "node-video");
            if (!video || !video.metadata || typeof video.metadata !== "object") invalid();
            const originalWebm = documents.uploaded.find(item => item.key === "video:transfer-webm"); if (!originalWebm) invalid();
            video.metadata = { ...video.metadata, storageKey: originalWebm.key, mimeType: originalWebm.mediaType, bytes: originalWebm.bytes };
            await fixture.save(context, source.id, module.transferCanvasKey, JSON.stringify(canvas), 1);
          }
          const intent = await fixture.resultIntent(context, source.id, documents.uploaded[0]!.key);
          seed = { nonce: environment.nonce, scope: source.id, targetScope: target.id, canvasId: "canvas-collision",
            sourceTitle: "source native canvas", targetTitle: "target native canvas", literal: documents.literal,
            imageDraftPrompt: documents.imageDraft.drafts[0]!.prompt, videoDraftPrompt: documents.videoDraft.drafts[0]!.prompt,
            intentKey: intent.key, viewport: documents.canvas.state.projects[0]!.viewport,
            media: documents.uploaded.map(item => ({ key: item.key, namespace: item.namespace, assetId: item.assetId, checksumSha256: item.checksumSha256, byteSize: item.bytes, mediaType: item.mediaType })) };
          await send({ id, ok: true, result: seed }); return;
        }
        if (!fixture || !context || !seed) invalid();
        const source = await fixture.snapshot(context, seed.scope), target = await fixture.snapshot(context, seed.targetScope);
        const originals = [];
        for (const item of seed.media) {
          const body = await fixture.original(context, item.assetId), { studioPersonalSha } = await import("../../apps/api/src/design/creative-studio-personal.test-fixture.js");
          originals.push({ ...item, actualSha256: studioPersonalSha(body), actualByteSize: body.length });
        }
        await send({ id, ok: true, result: { paid: await fixture.facts(context), source, target, originals, transfers: await fixture.transfers(context) } });
      } catch (error) {
        const code = error instanceof Error && /^studio_transfer_(?:browser|fixture)_[a-z_]+$/.test(error.message) ? error.message : "studio_transfer_browser_operation_failed";
        await send({ id, ok: false, errorCode: code });
        if (closing) { process.exitCode = 1; process.disconnect(); finish(); }
      }
    }).catch(async () => {
      process.exitCode = 1; try { await cleanup(); } catch { /* Nonzero exit retains a cleanup failure. */ }
      if (process.connected) process.disconnect(); finish();
    });
  });
  process.once("disconnect", () => { if (!closing) {
    closing = true; chain = chain.then(cleanup).then(() => { process.exitCode = 1; finish(); }, () => { process.exitCode = 1; finish(); });
  } });
  await done;
}
if (process.argv.includes("--studio-document-transfer-browser-child")) await studioDocumentTransferBrowserChild().catch(() => { process.exitCode = 1; });
