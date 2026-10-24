import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createEntityId, TenantContextSchema, type TenantContext } from "@yummyai/contracts";
import { intersectPermissionContexts } from "@yummyai/authz";
import { NormalizeOrderInputSchema } from "@yummyai/contracts/order/order";
import { SaveOrderWorkDraftInputSchema } from "@yummyai/contracts/order/workspace";
import { withTenant, roles, memberships, membershipRoles, marketplaceAccounts, loadCurrentMembershipContext, type DatabaseConnection } from "@yummyai/database";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { requireDisposableIntegrationEnvironment } from "../../../tools/testing/require-disposable-integration.mjs";
import { agentReadBrowserFixture, requireAgentReadBrowser } from "./agent-read-fixture";
import type * as S3Sdk from "../../../packages/storage/node_modules/@aws-sdk/client-s3/dist-types/index.js";

const workspace = fileURLToPath(new URL("../../../", import.meta.url)), thisFile = fileURLToPath(import.meta.url);
export function requireAgentEntryBrowser() {
  const url = new URL(requireDisposableIntegrationEnvironment()), api = new URL(process.env.API_BASE_URL ?? "https://invalid.invalid");
  const nonce = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(url.pathname)?.[1], redis = process.env.E2E_DISPOSABLE_REDIS_URL;
  if (!nonce || process.env.E2E_AGENT_ENTRY_ISOLATED !== "1" || process.env.E2E_AGENT_READ_ISOLATED !== "1" || process.env.E2E_COMPILED_WEB !== "1" ||
    process.env.WEB_AUTH_MODE !== "personal" || process.env.E2E_LEGACY_SCHEMA_TARGET !== "current" || process.env.S3_PRIVATE_BUCKET !== `order-daily-e2e-${nonce}` ||
    process.env.E2E_DISPOSABLE_REDIS_CONTAINER !== `yummyai-daily-${nonce}` || !redis || process.env.REDIS_URL !== redis ||
    !["redis:", "rediss:"].includes(new URL(redis).protocol) || !["127.0.0.1", "localhost", "[::1]"].includes(new URL(redis).hostname) ||
    !["127.0.0.1", "localhost", "[::1]"].includes(api.hostname) || api.port !== "8130")
    throw new Error("Agent entry browser requires its exact current compiled personal 3130/8130 nonce environment");
  requireAgentReadBrowser(); return { url: url.href, nonce };
}
const Seed = z.object({ orderId: z.uuidv7(), lineIds: z.array(z.uuidv7()).min(1), externalOrderId: z.string(), externalLineIds: z.array(z.string()).min(1), label: z.string() }).strict();
export type AgentEntrySeed = z.infer<typeof Seed>;
type ChildInput = { operation: "seed"; context: TenantContext; accountId: string; count: number; work: boolean; label: string } | { operation: "append" } | { operation: "close" };
class EntryOwnerChild {
  private readonly process: ChildProcess;
  private readonly ready: Promise<void>;
  private readonly ended: Promise<void>;
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  private sequence = 0; private exited = false; private exitFailed = false; private closing: Promise<void> | undefined;
  constructor() {
    const { nonce } = requireAgentEntryBrowser();
    this.process = spawn(process.execPath, ["--import", pathToFileURL(resolve(workspace, "apps/api/node_modules/tsx/dist/loader.mjs")).href, thisFile, "--agent-entry-owner-child"],
      { cwd: workspace, windowsHide: true, env: { ...process.env, TSX_DISABLE_CACHE: "1", TSX_TSCONFIG_PATH: resolve(workspace, "apps/api/tsconfig.json") }, stdio: ["ignore", "ignore", "ignore", "ipc"] });
    let ready!: () => void, failed!: (error: Error) => void;
    this.ready = new Promise((accept, reject) => { ready = accept; failed = reject; });
    const timeout = setTimeout(() => failed(new Error("agent_entry_owner_ready_timeout")), 30_000);
    this.ended = new Promise(accept => this.process.once("exit", (code, signal) => {
      this.exited = true; this.exitFailed = code !== 0 || signal !== null; clearTimeout(timeout); failed(new Error("agent_entry_owner_exited"));
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("agent_entry_owner_exited_pending")); }
      this.pending.clear(); accept();
    }));
    this.process.once("error", () => { clearTimeout(timeout); failed(new Error("agent_entry_owner_spawn_failed")); });
    this.process.on("message", raw => {
      if (!raw || typeof raw !== "object") return;
      const message = raw as Record<string, unknown>; if (message.nonce !== nonce) return;
      if (message.type === "ready") { clearTimeout(timeout); ready(); return; }
      if (typeof message.id !== "number") return;
      const pending = this.pending.get(message.id); if (!pending) return; this.pending.delete(message.id); clearTimeout(pending.timer);
      if (message.type === "result") pending.resolve(message.value);
      else pending.reject(new Error("agent_entry_owner_failed_" + (typeof message.phase === "string" && /^[a-z0-9_]{1,60}$/.test(message.phase) ? message.phase : "unknown") +
        (typeof message.code === "string" && /^[A-Z0-9]{5}$/.test(message.code) ? "_" + message.code : "")));
    });
  }
  async request(input: ChildInput): Promise<unknown> {
    await this.ready; if (this.exited || !this.process.connected) throw new Error("agent_entry_owner_unavailable");
    const id = ++this.sequence, { nonce } = requireAgentEntryBrowser();
    return new Promise((accept, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("agent_entry_owner_request_timeout")); }, 120_000);
      this.pending.set(id, { resolve: accept, reject, timer });
      this.process.send({ ...input, nonce, id }, error => { if (error) { clearTimeout(timer); this.pending.delete(id); reject(new Error("agent_entry_owner_delivery_failed")); } });
    });
  }
  close() { return this.closing ??= this.drain(); }
  private async drain() {
    const failures: unknown[] = [];
    if (!this.exited) {
      try { const ack = z.object({ closed: z.literal(true) }).parse(await this.request({ operation: "close" })); if (!ack.closed) throw new Error("agent_entry_close_ack_missing"); }
      catch (error) { failures.push(error); }
      if (this.process.connected) this.process.disconnect();
    }
    let timer: NodeJS.Timeout | undefined;
    try { await Promise.race([this.ended, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("agent_entry_owner_drain_timeout")), 20_000); })]); }
    catch (error) {
      failures.push(error); this.process.kill("SIGKILL"); let killed: NodeJS.Timeout | undefined;
      try { await Promise.race([this.ended, new Promise<never>((_, reject) => { killed = setTimeout(() => reject(new Error("agent_entry_owner_kill_exit_timeout")), 2_000); })]); }
      catch (cause) { failures.push(cause); }
      finally { if (killed) clearTimeout(killed); }
    }
    finally { if (timer) clearTimeout(timer); }
    if (this.exitFailed) failures.push(new Error("agent_entry_owner_unclean_exit"));
    if (failures.length) throw new AggregateError(failures, "agent_entry_owner_cleanup_failed");
  }
}

export async function agentEntryBrowserFixture(leaf: string) {
  const isolated = requireAgentEntryBrowser(), base = await agentReadBrowserFixture("entry-" + leaf);
  let child: EntryOwnerChild | undefined, auxiliaryRoleId: string | undefined;
  const originalRoles = await withTenant(base.database.db, base.context, tx => tx.select({ id: roles.id, permissions: roles.permissions, dataScope: roles.dataScope })
    .from(roles).innerJoin(membershipRoles, eq(membershipRoles.roleId, roles.id)).innerJoin(memberships, eq(memberships.id, membershipRoles.membershipId))
    .where(and(eq(memberships.userId, base.context.userId), eq(memberships.status, "active"))))
    .catch(async error => {
      const failures = [error];
      try { await base.close(); } catch (cause) { failures.push(cause); }
      throw new AggregateError(failures, "agent_entry_fixture_initialization_failed");
    });
  let memberId: string | undefined;
  async function removeAuxiliary() {
    if (!auxiliaryRoleId || !memberId) return;
    await withTenant(base.database.db, base.context, async tx => {
      await tx.delete(membershipRoles).where(and(eq(membershipRoles.membershipId, memberId!), eq(membershipRoles.roleId, auxiliaryRoleId!)));
      await tx.delete(roles).where(eq(roles.id, auxiliaryRoleId!));
    }); auxiliaryRoleId = undefined;
  }
  return { ...base, nonce: isolated.nonce,
    async seed(count: number, work = false) {
      child ??= new EntryOwnerChild();
      return Seed.parse(await child.request({ operation: "seed", context: base.context, accountId: base.model.storeId, count, work, label: "Synthetic entry " + randomUUID().replace(/[0-9]/g, value => String.fromCharCode(97 + Number(value))) }));
    },
    async append() { if (!child) throw new Error("Agent entry owner has no seed"); return Seed.parse(await child.request({ operation: "append" })); },
    async narrow(bit: string) {
      await removeAuxiliary();
      await withTenant(base.database.db, base.context, async tx => {
        for (const role of originalRoles) await tx.update(roles).set({ permissions: role.permissions.filter(value => value !== bit) }).where(eq(roles.id, role.id));
        const [member] = await tx.select({ id: memberships.id }).from(memberships).where(and(eq(memberships.userId, base.context.userId), eq(memberships.status, "active"))); if (!member) throw new Error("Synthetic entry member missing");
        memberId = member.id; auxiliaryRoleId = createEntityId();
        await tx.insert(roles).values({ id: auxiliaryRoleId, tenantId: base.context.tenantId, name: "Synthetic narrow entry role", permissions: [bit], dataScope: "self" });
        await tx.insert(membershipRoles).values({ tenantId: base.context.tenantId, membershipId: member.id, roleId: auxiliaryRoleId });
      });
    },
    async restore() { await removeAuxiliary(); await base.restore(); },
    async businessState() {
      return withTenant(base.database.db, base.context, async tx => {
        const result: Record<string, { count: number; hash: string }> = {};
        for (const table of ["orders", "order_lines", "order_work_items", "order_work_revisions", "order_work_events", "order_events"])
          result[table] = (await tx.execute<{ count: number; hash: string }>(sql`select count(*)::int as count,
            md5(coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text)::text,'[]')) as hash from ${sql.identifier(table)} t`))[0]!;
        return result;
      });
    },
    async close() {
      const failures: unknown[] = [];
      try { await child?.close(); } catch (error) { failures.push(error); }
      try { await removeAuxiliary(); } catch (error) { failures.push(error); }
      try { await base.close(); } catch (error) { failures.push(error); }
      if (failures.length) throw new AggregateError(failures, "agent_entry_fixture_cleanup_failed");
    },
  };
}

async function entryOwnerChild() {
  const { url, nonce } = requireAgentEntryBrowser();
  const [{ connectDatabase }, { AuditService }, { OrderService }, { OrderWorkspaceService }, { ProductionEditorService }, { AmazonOrderReportService }, { createOrderPiiVault }, { Storage, ClamAvScanner }] = await Promise.all([
    import("@yummyai/database"), import("../../api/src/audit/audit.service.js"), import("../../api/src/orders/order.service.js"), import("../../api/src/orders/order-workspace.service.js"),
    import("../../api/src/design/production-editor.service.js"), import("../../api/src/orders/amazon-order-report.service.js"), import("../../api/src/orders/order-pii-vault.js"), import("@yummyai/storage"),
  ]);
  let database: DatabaseConnection | undefined, storageClient: S3Sdk.S3Client | undefined, serial = Promise.resolve();
  let source: { context: TenantContext; accountId: string; label: string } | undefined, phase = "ready";
  const close = async () => { storageClient?.destroy(); await database?.client.end(); database = undefined; };
  process.on("disconnect", () => { void serial.finally(close).catch(() => { process.exitCode = 1; }); });
  process.on("message", raw => {
    serial = serial.then(async () => {
      if (!raw || typeof raw !== "object") return; const value = raw as Record<string, unknown>;
      if (value.nonce !== nonce || typeof value.id !== "number") return;
      try {
        if (value.operation === "close") { await close(); process.send?.({ type: "result", nonce, id: value.id, value: { closed: true } }); return; }
        if (!database) database = connectDatabase(url);
        if (value.operation === "seed") {
          phase = "identity"; const ceiling = TenantContextSchema.parse(value.context);
          const context = await withTenant(database.db, ceiling, async tx => intersectPermissionContexts(ceiling, await loadCurrentMembershipContext(tx, ceiling, { lock: true })));
          const [account] = await withTenant(database.db, context, tx => tx.select({ id: marketplaceAccounts.id }).from(marketplaceAccounts)
            .where(and(eq(marketplaceAccounts.id, String(value.accountId)), eq(marketplaceAccounts.createdBy, context.userId))));
          if (!account || !Number.isSafeInteger(value.count) || Number(value.count) < 1 || Number(value.count) > 100) throw new Error("agent_entry_seed_invalid");
          source = { context, accountId: account.id, label: z.string().max(160).parse(value.label) };
        }
        if (!source || !["seed", "append"].includes(String(value.operation))) throw new Error("agent_entry_source_missing");
        const { context, accountId, label } = source, vault = createOrderPiiVault(), audit = new AuditService(database), orders = new OrderService(database, vault, audit), id = createEntityId();
        phase = "ingest"; const count = value.operation === "append" ? 1 : Number(value.count);
        const order = await orders.ingestNormalized(context, NormalizeOrderInputSchema.parse({ accountId, platform: "amazon", externalEventId: id + ":1", externalOrderId: id,
          providerStatus: "Unshipped", placedAt: new Date().toISOString(), orderTotal: { amountMinor: count * 1000, currency: "USD" },
          lines: Array.from({ length: count }, (_, index) => ({ externalLineId: id + "-" + index, title: label, quantity: 1, unitPrice: { amountMinor: 1000, currency: "USD" }, customizationCount: 0 })),
          redactedSource: { syntheticOnly: true }, protectedDetails: null }));
        if (value.work === true) {
          phase = "private_work"; const { S3Client } = createRequire(new URL("../../../packages/storage/package.json", import.meta.url))("@aws-sdk/client-s3") as typeof S3Sdk;
          storageClient = new S3Client({ endpoint: process.env.S3_ENDPOINT, forcePathStyle: true, region: process.env.S3_REGION ?? "us-east-1",
            credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID!, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY! } });
          const storage = new Storage(storageClient, process.env.S3_PRIVATE_BUCKET!), clam = new ClamAvScanner(), scan = { scan: (body: Uint8Array, fileName: string, mediaType: string) => clam.scan({ body, fileName, mediaType }) };
          const unavailable = async (): Promise<never> => { throw new Error("Synthetic private draft has no artwork or remote-file operation"); };
          const reports = new AmazonOrderReportService(database, vault, orders, audit, { download: unavailable, scan: body => clam.scan({ body, fileName: "synthetic-no-file.txt", mediaType: "text/plain" }) }, { schedule: unavailable }, { schedule: unavailable });
          const editor = new ProductionEditorService(database, vault, storage, reports, audit, { enqueue: unavailable }, scan, vault), work = new OrderWorkspaceService(database, vault, storage, reports, editor, scan);
          for (const line of order.lines) await work.save(context, line.id, SaveOrderWorkDraftInputSchema.parse({ expectedRevision: 0, expectedProjectionVersion: 0, expectedSourceVersionId: null,
            draft: { printProfileVersionId: null, fields: [], images: [], instructions: "Synthetic pending private requirements; no artwork approval", customerApprovalRequired: false, dueAt: null },
            status: "pending_review", reason: "Synthetic private draft through the original owner", idempotencyKey: randomUUID() }));
        }
        process.send?.({ type: "result", nonce, id: value.id, value: { orderId: order.id, lineIds: order.lines.map(line => line.id), externalOrderId: id, externalLineIds: order.lines.map(line => line.externalLineId), label } });
      } catch (error) {
        const cause = error && typeof error === "object" ? error as { code?: unknown; cause?: { code?: unknown } } : {};
        process.send?.({ type: "failure", nonce, id: value.id, phase, code: cause.code ?? cause.cause?.code ?? null });
      }
    });
  });
  process.send?.({ type: "ready", nonce });
}
if (process.argv.includes("--agent-entry-owner-child")) void entryOwnerChild().catch(() => { process.exitCode = 1; process.disconnect?.(); });
