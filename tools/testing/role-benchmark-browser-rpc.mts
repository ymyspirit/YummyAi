import { createRequire } from "node:module";
import { z } from "../../apps/api/node_modules/zod/index.js";
import { requireDisposableIntegrationEnvironment } from "./require-disposable-integration.mjs";
import { TenantContextSchema, type TenantContext } from "../../packages/contracts/src/tenant/tenant-context.js";
import { LegacyAssistResultSchema, type AssistResult } from "../../packages/contracts/src/ai/assist.js";
import { createEnvironmentSecretVault, openBenchmarkValue, type AssistContext } from "../../packages/ai-core/src/index.js";
import { runRoleBenchmarkBaseline } from "../../packages/ai-core/src/role-benchmark.js";
import { createOrderPiiVault } from "../../apps/api/src/orders/order-pii-vault.js";
import { connectDatabase, loadCurrentMembershipContext, withTenant, type DatabaseConnection } from "../../packages/database/src/index.js";
import type * as Drizzle from "../../packages/database/node_modules/drizzle-orm/index.js";

const { sql } = createRequire(new URL("../../packages/database/package.json", import.meta.url))("drizzle-orm") as typeof Drizzle;

const roles = ["creative", "order_review", "artwork_preflight", "template_config", "sku_package", "after_sales_review"] as const;
const Id = z.uuidv7(), Nonce = z.string().regex(/^[a-f0-9]{32}$/);
const RequestSchema = z.discriminatedUnion("operation", [
  z.object({ id: z.int().positive(), nonce: Nonce, operation: z.literal("initialize"), context: TenantContextSchema }).strict(),
  z.object({ id: z.int().positive(), nonce: Nonce, operation: z.literal("source"), role: z.enum(roles), complete: z.boolean() }).strict(),
  z.object({ id: z.int().positive(), nonce: Nonce, operation: z.literal("state") }).strict(),
  z.object({ id: z.int().positive(), nonce: Nonce, operation: z.literal("output"), itemId: Id, versionId: Id }).strict(),
  z.object({ id: z.int().positive(), nonce: Nonce, operation: z.literal("close") }).strict(),
]);
function isolate() {
  const url = new URL(requireDisposableIntegrationEnvironment()), api = new URL(process.env.API_BASE_URL ?? "https://invalid.invalid");
  const nonce = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(url.pathname)?.[1];
  if (!process.send || !nonce || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || !["localhost", "127.0.0.1", "[::1]"].includes(api.hostname) || api.port !== "8130" ||
    process.env.E2E_ISOLATED_DAILY !== "1" || process.env.E2E_ROLE_BENCHMARK_ISOLATED !== "1" || process.env.E2E_BUSINESS_BENCHMARK_ISOLATED !== "1" ||
    process.env.E2E_KNOWLEDGE_BENCHMARK_ISOLATED !== "1" || process.env.E2E_KNOWLEDGE_EVALUATION_ISOLATED !== "1" || process.env.E2E_LEGACY_SCHEMA_TARGET !== "current" ||
    process.env.E2E_COMPILED_WEB !== "1" || process.env.WEB_AUTH_MODE !== "personal" || process.env.S3_PRIVATE_BUCKET !== `order-daily-e2e-${nonce}`)
    throw new Error("Role browser RPC requires the exact opt-in compiled personal nonce environment before connection");
  const actor = z.object({ userId: Id, tenantId: Id }).parse(JSON.parse(process.env.ERP_FIXTURE_ACTORS ?? "{}").operator);
  return { url, nonce, actor };
}
const isolated = isolate();
const safeFailureCodes = new Set(["role_rpc_resource_cleanup_failed", "role_rpc_initialization_and_cleanup_failed", "role_rpc_owner_close_failed", "role_rpc_database_close_failed"]);
type Owners = ReturnType<typeof import("./role-benchmark-fixture.mjs")["roleBenchmarkOwners"]>;
let database: DatabaseConnection | undefined, owners: Owners | undefined, context: TenantContext | undefined, closing = false;
let cleanup: Promise<void> | undefined, termination: Promise<void> | undefined;
let pending = Promise.resolve();
const send = (value: unknown) => { if (process.connected) process.send?.(value); };
async function check() {
  if (closing || isolate().nonce !== isolated.nonce || !database || !owners || !context) throw new Error("Role browser RPC owner unavailable");
  const [row] = await database.client.unsafe<{ name: string }[]>("select current_database() as name");
  if (row?.name !== `order_daily_e2e_${isolated.nonce}`) throw new Error("Role browser RPC exact nonce database required");
  return { database, owners, context };
}
function close() {
  if (cleanup) return cleanup;
  closing = true;
  const ownedOwners = owners, ownedDatabase = database; owners = undefined; database = undefined; context = undefined;
  cleanup = (async () => {
    const failures: Error[] = [];
    try { await ownedOwners?.close(); } catch { failures.push(new Error("role_rpc_owner_close_failed")); }
    try { await ownedDatabase?.client.end(); } catch { failures.push(new Error("role_rpc_database_close_failed")); }
    if (failures.length) throw new AggregateError(failures, "role_rpc_resource_cleanup_failed");
  })();
  return cleanup;
}
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
async function originalOutput(itemId: string, versionId: string): Promise<AssistResult> {
  const current = await check();
  const [row] = await withTenant(current.database.db, current.context, tx => tx.execute<{ encrypted: string | null }>(sql`select encrypted_basis as encrypted from knowledge_benchmark_items
    where id=${itemId}::uuid and version_id=${versionId}::uuid and created_by=${current.context.userId}::uuid`));
  if (!row?.encrypted) throw new Error("Original published role packet missing");
  const vault = createEnvironmentSecretVault("MODEL_CREDENTIAL_ENCRYPTION_KEY", "yummyai:ai-assist");
  const prepared = openBenchmarkValue<{ prepared: AssistContext }>(vault, "basis", row.encrypted).prepared;
  const result = LegacyAssistResultSchema.parse(runRoleBenchmarkBaseline(prepared));
  const source = prepared.sources.find(value => !prepared.images.some(image => image.sourceId === value.id) && !value.id.startsWith("knowledge:"));
  if (!source) throw new Error("Original non-image source required for synthetic provider response");
  const evidence = [{ sourceId: source.id, detail: "Synthetic provider response cites the actual fixed source; it does not approve or adopt business output" }];
  // These are explicitly synthetic provider proposals. The real native worker
  // still parses and grades every field against the fixed packet and media.
  if (prepared.request.kind === "creative") result.directions = [1, 2, 3].map(index => ({ title: `Synthetic original role direction ${index}`, rationale: "A controlled synthetic proposal for UI acceptance; no image has been generated or adopted",
    prompt: `Synthetic independent geometry ${index}`, negativePrompt: "Do not copy research art or claim production approval", requirements: { mode: "fixed", audience: "Synthetic audience", occasion: "", style: "Original geometry", fixedElements: "", imageInstructions: "Original controlled source only", acceptance: "Independent human review" }, fields: [], evidence }));
  if (prepared.request.kind === "order_review" && prepared.allowMatches && prepared.allowedArtworkIds[0] && prepared.allowedSpecificationIds[0])
    result.matches = [{ artworkVersionId: prepared.allowedArtworkIds[0], specificationVersionId: prepared.allowedSpecificationIds[0], reason: "Synthetic provider proposes this actually permitted fixed pair; no order field is adopted", evidence }];
  if (prepared.request.kind === "template_config") {
    const inspection = record(prepared.data.inspection), slots = Array.isArray(inspection.slots) ? inspection.slots.map(record) : [];
    const slot = slots.find(value => typeof value.stableKey === "string" && prepared.templateSlotKeys?.includes(value.stableKey));
    if (!slot || typeof slot.stableKey !== "string") throw new Error("Original parsed template slot required");
    const kind = ["image", "text", "background", "decoration"].includes(String(slot.kind)) ? slot.kind as "image" | "text" | "background" | "decoration" : "image";
    result.templateSlots = [{ stableKey: slot.stableKey, name: typeof slot.name === "string" ? slot.name : "Original parsed slot", kind, fillMode: kind === "text" ? "none" : "contain", replaceable: kind === "image" || kind === "text",
      fieldKey: kind === "image" || kind === "text" ? "original_field" : null, reuseLabel: "Synthetic original reuse suggestion", reason: "Only the original parsed structure was read; no PSD pixel review or template write", evidence }];
  }
  if (prepared.request.kind === "sku_package") {
    const copy = record(prepared.data.currentCopy);
    result.listingCopy = { title: typeof copy.title === "string" && copy.title ? copy.title.slice(0, prepared.listingPlatform === "etsy" ? 140 : 200) : "Synthetic controlled listing proposal", description: "Synthetic provider copy based on the fixed original source; independent human review is required before any use", bullets: prepared.listingPlatform === "etsy" ? [] : ["Synthetic original facts require review"], tags: prepared.listingPlatform === "amazon" ? [] : ["synthetic original"], personalizationInstructions: "Only the original allowed fields may be used", evidence,
      imageDescriptions: (prepared.listingMediaIds ?? []).filter(id => prepared.images.some(image => image.sourceId === id)).slice(0, 1).map(assetId => ({ assetId, text: "Synthetic description of the original fixed approved asset; not a production inspection", evidence: [{ sourceId: assetId, detail: "Actual fixed image supplied to the native worker" }] })) };
  }
  if (prepared.request.kind === "after_sales_review") result.replyDraft = { locale: prepared.request.locale, body: "We need to review the recorded evidence before confirming the next step. No refund, replacement, or message has been sent.", evidence };
  return LegacyAssistResultSchema.parse(result);
}
async function execute(message: z.infer<typeof RequestSchema>) {
  if (message.nonce !== isolated.nonce) throw new Error("Role browser RPC nonce mismatch");
  if (message.operation === "initialize") {
    if (database || owners || context || closing) throw new Error("Role browser RPC initialization already used");
    if (message.context.userId !== isolated.actor.userId || message.context.tenantId !== isolated.actor.tenantId) throw new Error("Role browser RPC requires the actual personal operator");
    database = connectDatabase(isolated.url.href);
    try {
      context = await withTenant(database.db, message.context, tx => loadCurrentMembershipContext(tx, message.context, { lock: true }));
      const module = await import("./role-benchmark-fixture.mjs");
      owners = module.roleBenchmarkOwners(database, createOrderPiiVault(), { assistVault: createEnvironmentSecretVault("MODEL_CREDENTIAL_ENCRYPTION_KEY", "yummyai:ai-assist") });
      await owners.initialize(); await check(); return { initialized: true, nonce: isolated.nonce };
    } catch (error) {
      try { await close(); } catch (failure) { throw new AggregateError([error, failure], "role_rpc_initialization_and_cleanup_failed"); }
      throw error;
    }
  }
  if (message.operation === "close") { await close(); return { closed: true }; }
  const current = await check();
  if (message.operation === "source") return current.owners.source(current.context, message.role, message.complete);
  if (message.operation === "state") return current.owners.state(current.context);
  return originalOutput(message.itemId, message.versionId);
}
process.on("message", raw => {
  pending = pending.then(async () => {
    const parsed = RequestSchema.safeParse(raw);
    if (!parsed.success) { send({ type: "protocol_error" }); return; }
    try { send({ type: "result", id: parsed.data.id, value: await execute(parsed.data) }); }
    catch (error) {
      const cleanupFailures = error instanceof AggregateError ? error.errors.filter((failure): failure is Error => failure instanceof Error && safeFailureCodes.has(failure.message)).map(failure => failure.message).slice(0, 2) : [];
      send({ type: "failure", id: parsed.data.id, operation: parsed.data.operation,
        code: error instanceof Error && safeFailureCodes.has(error.message) ? error.message : "owner_rpc_failed", cleanupFailures });
    }
  });
});
function terminate() {
  return termination ??= (async () => {
    let code = 0;
    try { await pending; await close(); } catch { code = 1; }
    process.exit(code);
  })();
}
process.once("disconnect", () => { void terminate(); });
process.once("SIGTERM", () => { void terminate(); });
send({ type: "ready", nonce: isolated.nonce });
