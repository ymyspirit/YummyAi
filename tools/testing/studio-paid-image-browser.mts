import process from "node:process";
import { ErpSessionViewSchema, erpSessionAuthority } from "../../packages/contracts/src/auth/session.js";
import { TenantContextSchema, type TenantContext } from "../../packages/contracts/src/tenant/tenant-context.js";
import { STUDIO_IMAGE_DRAFT_KEY } from "../../packages/contracts/src/pod/studio-document-transfer.js";
import type { createStudioPaidImageFixture } from "../../apps/api/src/design/studio-paid-image.test-fixture.js";
import { requireStudioPaidImageEnvironment } from "./studio-paid-image-environment.mjs";

type Fixture = Awaited<ReturnType<typeof createStudioPaidImageFixture>>;
export type StudioPaidImageBrowserRequest = { id: number; nonce: string; operation: "seed"; context: TenantContext }
  | { id: number; nonce: string; operation: "facts" | "process_original" | "close" };
const cleanupNames = ["authority", "requests", "documents_and_project", "channels", "policy_restore", "verification", "base_close"] as const;
export type StudioPaidImageCleanupPhase = typeof cleanupNames[number];
function cleanupPhases(error: unknown) {
  const phases = new Set<StudioPaidImageCleanupPhase>(), visited = new Set<Error>();
  const read = (value: unknown, depth: number) => {
    if (!(value instanceof Error) || visited.has(value) || depth > 6 || visited.size >= 32) return;
    visited.add(value);
    for (const name of cleanupNames) if (value.message === `studio_paid_image_fixture_cleanup_${name}_failed`) phases.add(name);
    if (value instanceof AggregateError) for (const nested of value.errors) read(nested, depth + 1);
    read(value.cause, depth + 1);
  };
  read(error, 0); return [...phases];
}
function invalid(): never { throw new Error("studio_paid_image_browser_request_invalid"); }
async function send(value: unknown) {
  await new Promise<void>((resolve, reject) => {
    if (!process.connected || !process.send) return reject(new Error("studio_paid_image_browser_channel_closed"));
    process.send(value, error => error ? reject(new Error("studio_paid_image_browser_send_failed")) : resolve());
  });
}

/** A real personal owner and Processor with a non-network synthetic gateway.
 * IPC admits no URLs, SQL, provider credentials or caller-selected generation. */
export async function studioPaidImageBrowserChild() {
  const environment = requireStudioPaidImageEnvironment(process.env, true);
  let fixture: Fixture | undefined, context: TenantContext | undefined;
  let seed: { scope: string; draft: unknown; referenceKey: string } | undefined, processed = false;
  let closing = false, chain = Promise.resolve(), finish!: () => void;
  const done = new Promise<void>(resolve => { finish = resolve; });
  const cleanup = async () => await fixture?.close();
  const facts = async () => {
    if (!fixture || !context || !seed) invalid();
    const value = await fixture.facts(context), page = await fixture.page(context, seed.scope, 40);
    const draft = value.entries.find(row => row.scope === seed!.scope && row.namespace === "app_state" && row.key === STUDIO_IMAGE_DRAFT_KEY && !row.deletedAt);
    if (!draft) throw new Error("studio_paid_image_browser_source_draft_missing");
    const originals: Array<{ assetId: string; checksumSha256: string; byteSize: number; mediaType: string; actualSha256: string; actualBytes: number }> = [];
    const module = await import("../../apps/api/src/design/studio-paid-image.test-fixture.js");
    const ids = new Set(page.items.flatMap(row => row.result ? [row.result.assetId] : []));
    const reference = value.entries.find(row => row.scope === seed!.scope && row.key === seed!.referenceKey && !row.deletedAt);
    if (!reference?.assetId) throw new Error("studio_paid_image_browser_reference_missing"); ids.add(reference.assetId);
    for (const id of ids) {
      const asset = value.assets.find(row => row.id === id);
      if (!asset?.checksumSha256 || asset.assetDomain !== "authorized") throw new Error("studio_paid_image_browser_original_missing");
      const bytes = await fixture.storage.readPrivate(context, { ...asset, assetDomain: "authorized" }, { requiredDomain: "authorized" });
      originals.push({ assetId: id, checksumSha256: asset.checksumSha256, byteSize: asset.byteSize, mediaType: asset.mediaType,
        actualSha256: module.paidImageFixtureSha(bytes), actualBytes: bytes.byteLength });
    }
    return { role: value.role, tables: value.tables, requests: page.items, originals: originals.sort((a, b) => a.assetId.localeCompare(b.assetId)),
      draft: { id: draft.id, scope: draft.scope, key: draft.key, revision: draft.revision, value: draft.value, updatedAt: draft.updatedAt.toISOString() },
      generations: value.rows.map(row => ({ id: row.id, requestId: row.requestId, scope: row.scope, status: row.status,
        input: row.input, modelSnapshot: row.modelSnapshot, assetId: row.assetId })),
      executions: value.executions.map(row => ({ id: row.id, generationId: row.studioGenerationId, phase: row.phase,
        responseChecksum: row.responseChecksum, hasArchive: !!row.responseObjectKey, costUsd: row.receipt?.costUsd ?? null })),
      budget: value.budget.map(row => ({ id: row.id, requestId: row.requestId, state: row.state, amountUsd: row.amountUsd })),
      gatewayCalls: value.calls, scans: value.scans };
  };
  process.on("message", (raw: unknown) => { chain = chain.then(async () => {
    const value = raw && typeof raw === "object" ? raw as Record<string, unknown> : null;
    const id = value && typeof value.id === "number" && Number.isSafeInteger(value.id) && value.id > 0 ? value.id : 0;
    try {
      if (!value || !id || value.nonce !== environment.nonce || !["seed", "facts", "process_original", "close"].includes(String(value.operation)) || closing) invalid();
      const keys = value.operation === "seed" ? ["id", "nonce", "operation", "context"] : ["id", "nonce", "operation"];
      if (Object.keys(value).some(key => !keys.includes(key))) invalid();
      if (value.operation === "close") {
        closing = true; const proof = await cleanup();
        await send({ id, ok: true, result: { closed: true, cleanup: proof } }); process.disconnect(); finish(); return;
      }
      if (value.operation === "seed") {
        if (fixture) invalid();
        const incoming = TenantContextSchema.strict().parse(value.context), api = process.env.API_BASE_URL, token = process.env.API_ACCESS_TOKEN;
        if (!api || !token) invalid();
        const response = await fetch(new URL("/v1/identity/session", api), { redirect: "error", signal: AbortSignal.timeout(15_000), headers: { authorization: "Bearer " + token } });
        if (response.status !== 200) { await response.body?.cancel(); invalid(); }
        const session = ErpSessionViewSchema.parse(await response.json());
        const actors = JSON.parse(process.env.ERP_FIXTURE_ACTORS ?? "null") as { operator?: { userId?: string; tenantId?: string } } | null;
        if (!actors?.operator || session.userId !== actors.operator.userId || session.tenantId !== actors.operator.tenantId
          || incoming.userId !== session.userId || incoming.tenantId !== session.tenantId || erpSessionAuthority(incoming) !== erpSessionAuthority(session)) invalid();
        context = TenantContextSchema.strict().parse(TenantContextSchema.parse(session));
        const module = await import("../../apps/api/src/design/studio-paid-image.test-fixture.js");
        fixture = await module.createStudioPaidImageFixture({ context });
        if ((await fixture.generations.models(context)).length) throw new Error("studio_paid_image_browser_initial_catalogue_not_empty");
        const channel = await fixture.channel(context); await fixture.rememberPolicy(context);
        const scope = (await fixture.project(context)).id, reference = await fixture.reference(context, scope);
        const model = (await fixture.generations.models(context)).find(row => row.id === channel.modelId);
        if (!model?.imagePricing) throw new Error("studio_paid_image_browser_priced_model_missing");
        const prompt = "Synthetic single image 73e2c9b1 Preserve the actual stored native draft";
        const draft = { version: 1, drafts: [{ id: "paid-image-original", prompt,
          references: [{ id: "paid-image-reference", name: "Synthetic approved original", type: "image/png", dataUrl: "", storageKey: reference.key }],
          config: { model: `${model.id}::${model.model}`, imageModel: `${model.id}::${model.model}`, size: "1:1", quality: "high", count: "3" } }], activeId: "paid-image-original" };
        await fixture.base.invoke(context, { operation: "state.set", scope, namespace: "app_state", key: STUDIO_IMAGE_DRAFT_KEY,
          revision: 0, value: draft });
        seed = { scope, draft, referenceKey: reference.key };
        await send({ id, ok: true, result: { nonce: environment.nonce, scope, draft, prompt, modelId: model.id, providerId: channel.id,
          model: model.model, selectionRevision: model.selectionRevision, pricing: model.imagePricing, authorityHash: module.paidImageFixtureSha(erpSessionAuthority(context)),
          reference: { key: reference.key, assetId: reference.assetId, checksumSha256: reference.checksum, byteSize: reference.bytes.byteLength },
          output: { width: 1024, height: 1024, checksumSha256: module.paidImageFixtureSha(fixture.image), byteSize: fixture.image.byteLength } } }); return;
      }
      if (!fixture || !context || !seed) invalid();
      if (value.operation === "process_original") {
        if (processed) throw new Error("studio_paid_image_browser_original_already_processed");
        const page = await fixture.page(context, seed.scope, 40), queued = page.items.filter(row => row.status === "queued" && row.generationId);
        if (queued.length !== 1) throw new Error("studio_paid_image_browser_original_generation_not_unique");
        processed = true; fixture.admission(context, true);
        await fixture.processGeneration(context, queued[0]!.generationId!);
      }
      await send({ id, ok: true, result: await facts() });
    } catch (error) {
      const code = error instanceof Error && /^studio_paid_image_(?:browser|fixture)_[a-z_]+$/.test(error.message) ? error.message : "studio_paid_image_browser_operation_failed";
      await send({ id, ok: false, errorCode: code, cleanupPhases: cleanupPhases(error) });
      if (closing) { process.exitCode = 1; process.disconnect(); finish(); }
    }
  }).catch(async () => {
    process.exitCode = 1; try { await cleanup(); } catch { /* The child remains failed and cannot acknowledge cleanup. */ }
    if (process.connected) process.disconnect(); finish();
  }); });
  process.once("disconnect", () => { if (!closing) {
    closing = true; chain = chain.then(cleanup).then(() => { process.exitCode = 1; finish(); }, () => { process.exitCode = 1; finish(); });
  } });
  await done;
}
if (process.argv.includes("--studio-paid-image-browser-child")) await studioPaidImageBrowserChild().catch(() => { process.exitCode = 1; });
