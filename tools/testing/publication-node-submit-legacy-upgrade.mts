import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { requirePublicationNodeSubmitEnvironment } from "./publication-node-submit-environment.mjs";
import { assertPublicationNodeSubmitOriginal182Graph, original182Root } from "../../apps/api/src/marketplaces/publication-node-submit-graph.test-fixture.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const tables = ["marketplace_accounts", "marketplace_credentials", "marketplace_capability_snapshots", "product_plans", "spus", "asset_files", "listings", "listing_versions",
  "marketplace_publication_requests", "marketplace_publication_events", "marketplace_publication_intents", "marketplace_store_nodes", "marketplace_store_node_bindings",
  "marketplace_store_node_executions", "marketplace_store_node_execution_steps"] as const;
export function publicationSubmitLegacyCellSha(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (item instanceof Date) return item.toISOString(); if (typeof item === "bigint") return item.toString();
    if (Buffer.isBuffer(item)) return { base64: item.toString("base64") };
    if (Array.isArray(item)) return item.map(normalize);
    if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, nested]) => [key, normalize(nested)]));
    return item;
  };
  return createHash("sha256").update(JSON.stringify(normalize(value))).digest("hex");
}
export const publicationSubmitLegacyTables = tables;
async function emit(value: object) {
  if (!process.send || !process.connected) throw new Error("publication_submit_original182_ipc_unavailable");
  await new Promise<void>((done, fail) => process.send!(value, error => error ? fail(new Error("publication_submit_original182_ipc_failed")) : done()));
}
function safeFailure(error: unknown, phase: string) {
  const names = ["Error", "SyntaxError", "ReferenceError", "TypeError", "RangeError", "ZodError", "DrizzleQueryError", "ConflictException", "NotFoundException", "ServiceUnavailableException", "ForbiddenError"];
  let code: string | null = null, value = error;
  for (let depth = 0; value && typeof value === "object" && depth < 5; depth++) {
    if ("code" in value && typeof value.code === "string" && /^(?:[A-Z0-9]{5}|ERR_[A-Z0-9_]{1,64}|ENOENT|EACCES)$/.test(value.code)) { code = value.code; break; }
    value = "cause" in value ? value.cause : null;
  }
  let location: { file: string; line: number } | null = null;
  if (error instanceof Error) for (const line of (error.stack ?? "").split("\n").slice(1)) {
    const match = /((?:[A-Za-z]:[\\/]|file:\/\/\/)[^()\r\n]+\.(?:ts|mts|js|mjs)):(\d+):\d+/.exec(line); if (!match) continue;
    let absolute: string; try { absolute = match[1].startsWith("file:") ? fileURLToPath(match[1]) : resolve(match[1]); } catch { continue; }
    const file = relative(root, absolute).replaceAll("\\", "/");
    if (!file.startsWith("..") && !isAbsolute(file) && /^[A-Za-z0-9_./@+-]+$/.test(file)) { location = { file, line: Number(match[2]) }; break; }
  }
  return { type: "publication.submit.failed182", phase, code,
    errorName: error instanceof Error && names.includes(error.name) ? error.name : "Other",
    constructorName: error instanceof Error && names.includes(error.constructor.name) ? error.constructor.name : "Other", location };
}

async function original182Child() {
  let phase = "original182_entry", database: Awaited<ReturnType<typeof import("../../packages/database/src/index.js")["connectDatabase"]>> | undefined;
  let fixture: ReturnType<typeof import("../../apps/api/src/marketplaces/publication-node-preview.test-fixture.js")["publicationNodePreviewFixture"]> | undefined;
  try {
    const parentEnvironment = { ...process.env }, isolated = requirePublicationNodeSubmitEnvironment(parentEnvironment, "pre-0183");
    phase = "original182_graph"; await assertPublicationNodeSubmitOriginal182Graph(parentEnvironment.E2E_PUBLICATION_NODE_SUBMIT_LEGACY_SOURCE!);
    // Only this old child uses its original current182 fixture protocol. The parent remains pre-0183.
    process.env.E2E_LEGACY_SCHEMA_TARGET = "current"; process.env.E2E_AMAZON_PUBLIC_NODE_ISOLATED = "1"; process.env.E2E_PUBLICATION_NODE_PREVIEW_ISOLATED = "1";
    const old = (path: string) => import(pathToFileURL(resolve(original182Root, path)).href);
    phase = "original182_imports";
    const db = await old("packages/database/src/index.ts") as typeof import("../../packages/database/src/index.js"),
      contract = await old("packages/contracts/src/index.ts") as typeof import("../../packages/contracts/src/index.js"),
      preview = await old("packages/contracts/src/marketplace/publication-preview.ts") as typeof import("../../packages/contracts/src/marketplace/publication-preview.js"),
      originalFixture = await old("apps/api/src/marketplaces/publication-node-preview.test-fixture.ts") as typeof import("../../apps/api/src/marketplaces/publication-node-preview.test-fixture.js");
    database = db.connectDatabase(isolated.url); fixture = originalFixture.publicationNodePreviewFixture(database, { amazonPublic: true });
    phase = "original182_initialize"; await fixture.initialize();
    const context = await fixture.current(), oldRequire = createRequire(pathToFileURL(resolve(original182Root, "apps/api/package.json"))),
      { sql } = oldRequire("drizzle-orm") as typeof import("../../packages/database/node_modules/drizzle-orm/index.js");
    phase = "original182_credential_anchor";
    // An original owner-created grant outside the fixture's retirement map is preserved for byte-level migration checks.
    // The parent later revokes it through the current authorization owner before destroying the disposable database.
    const anchor = await fixture.accounts.create(context, contract.CreateMarketplaceAccountInputSchema.parse({ platform: "amazon", authorizationMode: "amazon_private", region: "NA",
      marketplaceIds: ["ATVPDKIKX0DER"], requestedScopes: ["product-listing"], displayName: "Synthetic genuine182 retained credential" }));
    await fixture.authorization.authorizeAmazonPrivate(context, anchor.id, { ...fixture.provider.privateInput, sellingPartnerId: fixture.provider.sellerId + "-" + anchor.id });
    phase = "original182_actual_capability"; const store = await fixture.bootstrapStore(), source = await fixture.seedListing(store.store.id);
    async function createPreview() {
      const input = await fixture!.previewInput(source), response = await fixture!.http("/v1/marketplace-publications/preview", input);
      if (response.status !== 201) throw new Error("publication_submit_original182_preview_create_failed");
      return { input, view: preview.PublicationPreviewRequestViewSchema.parse(response.body) };
    }
    phase = "original182_completed_preview";
    const created = await createPreview(), work = await fixture.workNode(store.node.keys);
    const completed = await fixture.waitPreview(created.view.request.id, work); await settled(work); await work.close();
    if (completed.request.current.status !== "validation_passed") throw new Error("publication_submit_original182_real_preview_not_passed");
    phase = "original182_central_child"; const central = await fixture.publications.continue(await fixture.current(), completed.request.id);
    if (central.action !== "amazon_submit" || central.parentRequestId !== completed.request.id) throw new Error("publication_submit_original182_real_child_invalid");
    phase = "original182_unknown_preview";
    const unknownCreated = await createPreview(); fixture.provider.controls.fault = "lose"; fixture.provider.controls.faultKind = "amazon_listing_validation_preview";
    const uncertainWork = await fixture.workNode(store.node.keys), uncertain = await fixture.waitPreview(unknownCreated.view.request.id, uncertainWork); await settled(uncertainWork); await uncertainWork.close();
    if (uncertain.execution?.state !== "unknown_outcome") throw new Error("publication_submit_original182_real_unknown_missing");
    fixture.provider.controls.fault = "none"; fixture.provider.controls.faultKind = null;
    phase = "original182_waiting_preview"; const waiting = await createPreview();
    const providerCounts = fixture.provider.counts();
    phase = "original182_stop_services"; await fixture.close();
    if (!fixture.evidence.apiClosed || !fixture.evidence.bootstrapClosed || !fixture.evidence.providerClosed || fixture.evidence.childExits.some(raw => {
      const row = raw as { exited?: boolean; leaked?: boolean }; return row.exited !== true || row.leaked;
    })) throw new Error("publication_submit_original182_services_not_closed");
    const rows = await db.withTenant(database.db, context, async tx => {
      const output: Array<{ table: string; columns: string[]; rows: Array<{ key: string; columns: Record<string, string> }> }> = [];
      for (const table of tables) {
        const selected = await tx.execute<Record<string, unknown>>(sql.raw("select * from " + table)), columns = [...new Set(selected.flatMap(row => Object.keys(row)))].sort();
        output.push({ table, columns, rows: selected.map(row => ({ key: String(row.id ?? row.account_id),
          columns: Object.fromEntries(columns.map(column => [column, publicationSubmitLegacyCellSha(row[column])])) })).sort((a, b) => a.key.localeCompare(b.key)) });
      } return output;
    });
    if (!rows.find(row => row.table === "marketplace_credentials")?.rows.length) throw new Error("publication_submit_original182_anchor_missing");
    await database.client.end(); database = undefined;
    phase = "original182_seeded";
    await emit({ type: "publication.submit.seeded182", nonce: isolated.nonce, context, original: central, preview: completed.request, waiting: waiting.view.request,
      unknown: uncertain.request, anchorAccountId: anchor.id, rows, providerCounts, serviceClose: { apiClosed: fixture.evidence.apiClosed,
        bootstrapClosed: fixture.evidence.bootstrapClosed, providerClosed: fixture.evidence.providerClosed, databaseClosed: true,
        childExits: fixture.evidence.childExits.map(raw => { const row = raw as { pid: number | null; exited: boolean; forced: boolean; leaked: boolean; stderrCode: string | null };
          return { pid: row.pid, exited: row.exited, forced: row.forced, leaked: row.leaked, stderrCode: row.stderrCode }; }) },
      environmentBoundary: { parentTarget: parentEnvironment.E2E_LEGACY_SCHEMA_TARGET, childTarget: process.env.E2E_LEGACY_SCHEMA_TARGET,
        originalRoot: original182Root, oldFixtureLaneInsideOwnedCopy: originalFixture.lane.startsWith(original182Root) }, syntheticHistoricalAssetMetadata: true });
    process.disconnect?.();
  } catch (error) {
    try { await fixture?.close(); } catch { /* The finite failure remains primary; parent failure-safe teardown owns resources. */ }
    try { await database?.client.end(); } catch { /* No raw database errors. */ }
    try { await emit(safeFailure(error, phase)); } catch { /* IPC may already have closed. */ }
    process.exitCode = 1; process.disconnect?.();
  }
}
async function settled(child: { evidence: { exited: boolean; states: Array<{ state: string }> } }) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.evidence.states.some(row => row.state === "execution_finished")) return;
    if (child.evidence.exited) throw new Error("publication_submit_original182_cli_ended_before_local_receipt");
    await new Promise<void>(done => setTimeout(done, 50));
  }
  throw new Error("publication_submit_original182_local_receipt_deadline");
}
async function original182ReadChild() {
  let phase = "original182_read_entry", database: Awaited<ReturnType<typeof import("../../packages/database/src/index.js")["connectDatabase"]>> | undefined,
    producer: InstanceType<typeof import("../../apps/api/src/marketplaces/redis-marketplace-publication-enqueuer.js")["RedisMarketplacePublicationEnqueuer"]> | undefined;
  try {
    const isolated = requirePublicationNodeSubmitEnvironment(process.env, "pre-0183");
    await assertPublicationNodeSubmitOriginal182Graph(process.env.E2E_PUBLICATION_NODE_SUBMIT_LEGACY_SOURCE!);
    const old = (path: string) => import(pathToFileURL(resolve(original182Root, path)).href),
      db = await old("packages/database/src/index.ts") as typeof import("../../packages/database/src/index.js"),
      contract = await old("packages/contracts/src/index.ts") as typeof import("../../packages/contracts/src/index.js"),
      originalOwner = await old("apps/api/src/marketplaces/marketplace-publication.service.ts") as typeof import("../../apps/api/src/marketplaces/marketplace-publication.service.js"),
      audit = await old("apps/api/src/audit/audit.service.ts") as typeof import("../../apps/api/src/audit/audit.service.js"),
      queue = await old("apps/api/src/marketplaces/redis-marketplace-publication-enqueuer.ts") as typeof import("../../apps/api/src/marketplaces/redis-marketplace-publication-enqueuer.js");
    const pendingInput = new Promise<{ context: unknown; requestId: string; previewId: string }>((done, fail) => {
      process.once("disconnect", () => fail(new Error("publication_submit_original182_read_parent_disconnected")));
      process.on("message", raw => { if (raw && typeof raw === "object" && "operation" in raw && raw.operation === "read" && "context" in raw &&
        "requestId" in raw && typeof raw.requestId === "string" && "previewId" in raw && typeof raw.previewId === "string" && Object.keys(raw).length === 4)
        done({ context: raw.context, requestId: raw.requestId, previewId: raw.previewId }); });
    });
    await emit({ type: "publication.submit.reader.ready182", nonce: isolated.nonce }); const input = await pendingInput;
    phase = "original182_post_upgrade_read"; const context = contract.TenantContextSchema.parse(input.context), requestId = contract.EntityIdSchema.parse(input.requestId), previewId = contract.EntityIdSchema.parse(input.previewId);
    database = db.connectDatabase(isolated.url); producer = new queue.RedisMarketplacePublicationEnqueuer();
    const owner = new originalOwner.MarketplacePublicationService(database, producer, new audit.AuditService(database)),
      original = await owner.get(context, requestId), events = await owner.events(context, requestId), preview = await owner.getPreview(context, previewId);
    await producer.onModuleDestroy(); producer = undefined; await database.client.end(); database = undefined;
    await emit({ type: "publication.submit.checked182", nonce: isolated.nonce, original, events, preview,
      originalReaderSource: "frozen182", cliStarted: false, databaseClosed: true, queueClosed: true });
    process.disconnect?.();
  } catch (error) {
    try { await producer?.onModuleDestroy(); } catch { /* Safe finite failure only. */ }
    try { await database?.client.end(); } catch { /* Safe finite failure only. */ }
    try { await emit(safeFailure(error, phase)); } catch { /* IPC may already be closed. */ }
    process.exitCode = 1; process.disconnect?.();
  }
}
if (process.argv.includes("--publication-node-submit-original182-seed-child")) await original182Child();
if (process.argv.includes("--publication-node-submit-original182-read-child")) await original182ReadChild();
