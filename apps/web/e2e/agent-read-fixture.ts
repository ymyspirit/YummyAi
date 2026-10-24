import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { z } from "zod";
import { Permission, intersectPermissionContexts } from "@yummyai/authz";
import { createEntityId, TenantContextSchema, type TenantContext } from "@yummyai/contracts";
import { ErpSessionViewSchema } from "@yummyai/contracts/auth/session";
import { connectDatabase, loadCurrentMembershipContext, memberships, membershipRoles, roles, marketplaceAccounts, withTenant } from "@yummyai/database";
import { and, eq, sql } from "drizzle-orm";
import { requireDisposableIntegrationEnvironment } from "../../../tools/testing/require-disposable-integration.mjs";
import { actors } from "./erp-identity-fixture";
import { centerApi } from "./order-centers-fixture";
import { knowledgeGovernanceFixture } from "./knowledge-governance-fixture";
import { createQueue, QueueName } from "../../../packages/jobs/src/index";
import type * as AuditOwnerModule from "../../api/src/audit/audit.service.js";
import type * as OrderOwnerModule from "../../api/src/orders/order.service.js";
import type * as InventoryOwnerModule from "../../api/src/inventory/inventory.service.js";
import type * as OrderVaultModule from "../../api/src/orders/order-pii-vault.js";

const workspace = fileURLToPath(new URL("../../../", import.meta.url));
const thisFile = fileURLToPath(import.meta.url);
const loopback = ["localhost", "127.0.0.1", "[::1]"];
export function requireAgentReadBrowser() {
  const url = new URL(requireDisposableIntegrationEnvironment()), api = new URL(process.env.API_BASE_URL ?? "https://invalid.invalid");
  const nonce = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(url.pathname)?.[1];
  if (!nonce || !loopback.includes(url.hostname) || !loopback.includes(api.hostname) || api.port !== "8130" ||
      process.env.E2E_AGENT_READ_ISOLATED !== "1" || process.env.E2E_LEGACY_SCHEMA_TARGET !== "current" ||
      process.env.E2E_COMPILED_WEB !== "1" || process.env.WEB_AUTH_MODE !== "personal" ||
      process.env.S3_PRIVATE_BUCKET !== `order-daily-e2e-${nonce}` || !process.env.ERP_FIXTURE_ACTORS)
    throw new Error("Agent read browser fixture requires its exact compiled personal nonce resources before connection");
  return { url: url.href, nonce };
}

const Id = z.uuidv7();
const SeedSchema = z.object({ orderId: Id, exceptionIds: z.array(Id).min(27), stockItemId: Id, warehouseId: Id, locationIds: z.array(Id).length(27),
  balances: z.array(z.object({ locationId: Id, physicalQuantity: z.union([z.number(), z.string()]), reservedQuantity: z.union([z.number(), z.string()]),
    availableQuantity: z.union([z.number(), z.string()]) }).strict()).length(27) }).strict();
export type AgentReadSeed = z.infer<typeof SeedSchema>;
type ChildRequest = { operation: "seed"; context: TenantContext; accountId: string } | { operation: "append" } | { operation: "close" };

/** Node/tsx owns decorated services; Playwright only handles plain fixture DTOs. */
class AgentOwnerChild {
  private readonly child: ChildProcess;
  private readonly waiting = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  private sequence = 0;
  private readonly ready: Promise<void>;
  private readonly ended: Promise<void>;
  private exited = false;
  private closing: Promise<void> | undefined;
  constructor() {
    const { nonce } = requireAgentReadBrowser();
    this.child = spawn(process.execPath, ["--import", pathToFileURL(resolve(workspace, "apps/api/node_modules/tsx/dist/loader.mjs")).href,
      thisFile, "--agent-read-owner-child"], { cwd: workspace, windowsHide: true,
      env: { ...process.env, TSX_DISABLE_CACHE: "1", TSX_TSCONFIG_PATH: resolve(workspace, "apps/api/tsconfig.json") },
      stdio: ["ignore", "ignore", "ignore", "ipc"] });
    let readyResolve!: () => void, readyReject!: (error: Error) => void;
    this.ready = new Promise((accept, reject) => { readyResolve = accept; readyReject = reject; });
    const readyTimeout = setTimeout(() => readyReject(new Error("agent_owner_ready_timeout")), 30_000);
    this.ended = new Promise(accept => this.child.once("exit", (code, signal) => {
      clearTimeout(readyTimeout); this.exited = true;
      readyReject(new Error("agent_owner_exited_before_ready"));
      for (const pending of this.waiting.values()) { clearTimeout(pending.timer); pending.reject(new Error("agent_owner_exited_with_pending_request")); }
      this.waiting.clear(); if (code !== 0 || signal) this.exitFailure = true; accept();
    }));
    this.child.once("error", () => { clearTimeout(readyTimeout); readyReject(new Error("agent_owner_spawn_failed")); });
    this.child.on("message", value => {
      if (!value || typeof value !== "object") return;
      const message = value as Record<string, unknown>;
      if (message.nonce !== nonce) return;
      if (message.type === "ready") { clearTimeout(readyTimeout); readyResolve(); return; }
      if (typeof message.id !== "number") return;
      const pending = this.waiting.get(message.id); if (!pending) return;
      clearTimeout(pending.timer); this.waiting.delete(message.id);
      if (message.type === "result") pending.resolve(message.value);
      else pending.reject(new Error("agent_owner_failed_" + (typeof message.phase === "string" && /^[a-z0-9_]{1,60}$/.test(message.phase) ? message.phase : "unknown") +
        (typeof message.code === "string" && /^[A-Z0-9]{5}$/.test(message.code) ? "_" + message.code : "")));
    });
  }
  private exitFailure = false;
  async request(input: ChildRequest): Promise<unknown> {
    await this.ready;
    if (this.exited || !this.child.connected) throw new Error("agent_owner_unavailable");
    const id = ++this.sequence, { nonce } = requireAgentReadBrowser();
    return new Promise((accept, reject) => {
      const timer = setTimeout(() => { this.waiting.delete(id); reject(new Error("agent_owner_request_timeout")); }, input.operation === "seed" ? 120_000 : 20_000);
      this.waiting.set(id, { resolve: accept, reject, timer });
      this.child.send({ ...input, nonce, id }, error => { if (error) { clearTimeout(timer); this.waiting.delete(id); reject(new Error("agent_owner_delivery_failed")); } });
    });
  }
  close() { return this.closing ??= this.drain(); }
  private async drain() {
    const errors: unknown[] = [];
    if (!this.exited) {
      try { const result = await this.request({ operation: "close" }); if (!result || typeof result !== "object" || !("closed" in result) || !result.closed) throw new Error("agent_owner_close_ack_missing"); }
      catch (error) { errors.push(error); }
      if (this.child.connected) this.child.disconnect();
    }
    let timer: NodeJS.Timeout | undefined;
    try { await Promise.race([this.ended, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("agent_owner_drain_timeout")), 20_000); })]); }
    catch (error) {
      errors.push(error); this.child.kill("SIGKILL"); let killed: NodeJS.Timeout | undefined;
      try { await Promise.race([this.ended, new Promise<never>((_, reject) => { killed = setTimeout(() => reject(new Error("agent_owner_kill_exit_timeout")), 2_000); })]); }
      catch (failure) { errors.push(failure); }
      finally { if (killed) clearTimeout(killed); }
    }
    finally { if (timer) clearTimeout(timer); }
    if (this.exitFailure) errors.push(new Error("agent_owner_unclean_exit"));
    if (errors.length) throw new AggregateError(errors, "agent_owner_cleanup_failed");
  }
}

export async function agentReadBrowserFixture(leaf: string) {
  const isolated = requireAgentReadBrowser(), identity = actors().operator;
  const session = ErpSessionViewSchema.parse(await centerApi("identity/session"));
  if (session.tenantId !== identity.tenantId || session.userId !== identity.userId)
    throw new Error("Agent read requires the same actual personal operator for Node fixture and browser");
  const context = TenantContextSchema.parse(session), database = connectDatabase(isolated.url);
  let model: Awaited<ReturnType<typeof knowledgeGovernanceFixture>> | undefined, child: AgentOwnerChild | undefined;
  let auxiliaryRoleId: string | undefined, closed = false;
  const originalRoles = await withTenant(database.db, context, tx => tx.select({ id: roles.id, permissions: roles.permissions, dataScope: roles.dataScope })
    .from(roles).innerJoin(membershipRoles, eq(membershipRoles.roleId, roles.id)).innerJoin(memberships, eq(memberships.id, membershipRoles.membershipId))
    .where(and(eq(memberships.id, identity.membershipId), eq(memberships.userId, identity.userId), eq(memberships.status, "active"))))
    .catch(async error => { await database.client.end(); throw error; });
  if (!originalRoles.length) { await database.client.end(); throw new Error("Agent read original personal role missing"); }
  async function restore() {
    await withTenant(database.db, context, async tx => {
      for (const role of originalRoles) await tx.update(roles).set({ permissions: role.permissions, dataScope: role.dataScope }).where(eq(roles.id, role.id));
      if (auxiliaryRoleId) {
        await tx.delete(membershipRoles).where(and(eq(membershipRoles.membershipId, identity.membershipId), eq(membershipRoles.roleId, auxiliaryRoleId)));
        await tx.delete(roles).where(eq(roles.id, auxiliaryRoleId)); auxiliaryRoleId = undefined;
      }
    });
    const actual = await withTenant(database.db, context, tx => tx.select({ id: roles.id, permissions: roles.permissions, dataScope: roles.dataScope })
      .from(roles).innerJoin(membershipRoles, eq(membershipRoles.roleId, roles.id)).where(eq(membershipRoles.membershipId, identity.membershipId)));
    if (JSON.stringify(actual.sort((a, b) => a.id.localeCompare(b.id))) !== JSON.stringify([...originalRoles].sort((a, b) => a.id.localeCompare(b.id))))
      throw new Error("Agent read original personal role restoration mismatch");
  }
  try {
    model = await knowledgeGovernanceFixture(`agent-read-${leaf}`);
    const verified = ErpSessionViewSchema.parse(await centerApi("identity/session"));
    if (verified.tenantId !== identity.tenantId || verified.userId !== identity.userId) throw new Error("Agent read fixture identity changed");
    const [fixtureActor] = await withTenant(database.db, context, tx => tx.select({ createdBy: marketplaceAccounts.createdBy })
      .from(marketplaceAccounts).where(eq(marketplaceAccounts.id, model!.storeId)));
    if (fixtureActor?.createdBy !== identity.userId) throw new Error("Knowledge fixture Node actor differs from the actual personal browser operator");
    if (leaf === "tools") { child = new AgentOwnerChild(); }
  } catch (error) {
    const failures = [error];
    try { await child?.close(); } catch (failure) { failures.push(failure); }
    try { await model?.close(); } catch (failure) { failures.push(failure); }
    try { await restore(); } catch (failure) { failures.push(failure); }
    await database.client.end(); throw new AggregateError(failures, "agent_read_fixture_initialization_failed");
  }
  const owner = model;
  return {
    context, database, model: owner, nonce: isolated.nonce,
    async seed() { if (!child) throw new Error("Agent owner not initialized"); return SeedSchema.parse(await child.request({ operation: "seed", context, accountId: owner.storeId })); },
    async append() { if (!child) throw new Error("Agent owner not initialized"); await child.request({ operation: "append" }); },
    async inventorySelf() {
      await withTenant(database.db, context, async tx => {
        for (const role of originalRoles) await tx.update(roles).set({ permissions: role.permissions.filter(bit => bit !== Permission.InventoryRead) }).where(eq(roles.id, role.id));
        if (!auxiliaryRoleId) {
          const id = createEntityId(); await tx.insert(roles).values({ id, tenantId: identity.tenantId, name: `Synthetic agent inventory ${id}`, permissions: [Permission.InventoryRead], dataScope: "self" });
          await tx.insert(membershipRoles).values({ tenantId: identity.tenantId, membershipId: identity.membershipId, roleId: id }); auxiliaryRoleId = id;
        }
      });
    },
    async removeWorkflowRead() {
      await withTenant(database.db, context, async tx => {
        for (const role of originalRoles) await tx.update(roles).set({ permissions: role.permissions.filter(bit => bit !== Permission.WorkflowRead) }).where(eq(roles.id, role.id));
      });
    },
    restore,
    async state(requestId: string) {
      return withTenant(database.db, context, async tx => {
        const runs = await tx.execute<{ id: string; status: string; requestChecksum: string; ownerId: string; expiresAt: string }>(sql`select id, status,
          request_fingerprint as "requestChecksum", owner_id as "ownerId", expires_at::text as "expiresAt" from ai_assist_runs
          where owner_id=${identity.userId}::uuid and request_id=${requestId}::uuid order by id`);
        const ids = Array.from(runs, row => row.id);
        const executions = ids.length ? await tx.execute<{ runId: string; phase: string; dispatchCount: number; attemptCount: number; submissionState: string }>(sql`select run_id as "runId", phase,
          dispatch_count as "dispatchCount", attempt_count as "attemptCount", submission_state as "submissionState"
          from ai_assist_executions where run_id=${ids[0]}::uuid order by run_id`) : [];
        const budgets = ids.length ? await tx.execute<{ id: string; state: string; amountUsd: string }>(sql`select id, state, amount_usd::text as "amountUsd" from ai_budget_ledger where request_id=${ids[0]}::uuid order by id`) : [];
        const ownerRuns = await tx.execute<{ id: string }>(sql`select id from ai_assist_runs where owner_id=${identity.userId}::uuid order by id`);
        const ownerExecutions = await tx.execute<{ id: string }>(sql`select e.run_id as id from ai_assist_executions e join ai_assist_runs r
          on r.tenant_id=e.tenant_id and r.id=e.run_id where r.owner_id=${identity.userId}::uuid order by e.run_id`);
        const ownerBudgets = await tx.execute<{ id: string }>(sql`select b.id from ai_budget_ledger b join ai_assist_runs r
          on r.tenant_id=b.tenant_id and r.id=b.request_id where r.owner_id=${identity.userId}::uuid order by b.id`);
        return { runs: Array.from(runs), executions: Array.from(executions), budgets: Array.from(budgets),
          ownerRunIds: Array.from(ownerRuns, row => row.id), ownerExecutionIds: Array.from(ownerExecutions, row => row.id), ownerBudgetIds: Array.from(ownerBudgets, row => row.id) };
      });
    },
    async queuedJobs(runId: string) {
      const redis = process.env.E2E_DISPOSABLE_REDIS_URL;
      if (!redis || process.env.E2E_DISPOSABLE_REDIS_CONTAINER !== `yummyai-daily-${isolated.nonce}` || process.env.REDIS_URL !== redis ||
          !loopback.includes(new URL(redis).hostname)) throw new Error("Agent queue evidence requires the exact owned nonce Redis");
      const queue = createQueue(QueueName.AiAssist, redis);
      try {
        const jobs = await queue.getJobs(["wait", "delayed", "active", "completed", "failed", "paused"], 0, -1);
        const target = Id.parse(runId);
        return jobs.filter(job => job.data?.tenantId === identity.tenantId && job.data?.requestedBy === identity.userId)
          .map(job => ({ id: job.id, name: job.name, original: job.data?.payload?.runId === target })).sort((a, b) => String(a.id).localeCompare(String(b.id)));
      } finally { await queue.close(); }
    },
    async close() {
      if (closed) return; const failures: unknown[] = [];
      try { await child?.close(); } catch (error) { failures.push(error); }
      try { await owner.close(); } catch (error) { failures.push(error); }
      try { await restore(); } catch (error) { failures.push(error); }
      try { await database.client.end(); } catch (error) { failures.push(error); }
      closed = true;
      if (failures.length) throw new AggregateError(failures, "agent_read_fixture_cleanup_failed");
    },
  };
}

async function ownerChild() {
  const { url, nonce } = requireAgentReadBrowser();
  let phase = "ready", database: ReturnType<typeof connectDatabase> | undefined;
  let initialized: { context: TenantContext; inventory: InventoryOwnerModule.InventoryService;
    stockItemId: string; locationId: string } | undefined;
  let serial = Promise.resolve();
  const close = async () => { await database?.client.end(); database = undefined; };
  process.on("disconnect", () => { void serial.finally(close).catch(() => { process.exitCode = 1; }); });
  process.on("message", raw => {
    serial = serial.then(async () => {
      if (!raw || typeof raw !== "object") return;
      const value = raw as Record<string, unknown>;
      if (value.nonce !== nonce || typeof value.id !== "number") return;
      try {
        let result: unknown;
        if (value.operation === "close") { phase = "close"; await close(); result = { closed: true }; }
        else if (value.operation === "seed") {
          if (database || initialized || typeof value.accountId !== "string") throw new Error("seed_invalid");
          phase = "initialize"; const ceiling = TenantContextSchema.parse(value.context), actor = actors().operator;
          if (ceiling.userId !== actor.userId || ceiling.tenantId !== actor.tenantId) throw new Error("actor_invalid");
          database = connectDatabase(url);
          const context = await withTenant(database.db, ceiling, async tx => {
            const current = intersectPermissionContexts(ceiling, await loadCurrentMembershipContext(tx, ceiling, { lock: true }));
            const [account] = await tx.select({ id: marketplaceAccounts.id }).from(marketplaceAccounts).where(and(eq(marketplaceAccounts.id, String(value.accountId)), eq(marketplaceAccounts.createdBy, current.userId)));
            if (!account || ![Permission.OrderRead, Permission.OrderWrite, Permission.InventoryRead, Permission.InventoryWrite].every(bit => current.permissions.includes(bit))) throw new Error("source_authority_invalid");
            return current;
          });
          const [{ AuditService }, { OrderService }, { InventoryService }, { createOrderPiiVault }] = await Promise.all([
            import(pathToFileURL(resolve(workspace, "apps/api/src/audit/audit.service.ts")).href),
            import(pathToFileURL(resolve(workspace, "apps/api/src/orders/order.service.ts")).href),
            import(pathToFileURL(resolve(workspace, "apps/api/src/inventory/inventory.service.ts")).href),
            import(pathToFileURL(resolve(workspace, "apps/api/src/orders/order-pii-vault.ts")).href),
          ]) as [typeof AuditOwnerModule, typeof OrderOwnerModule, typeof InventoryOwnerModule, typeof OrderVaultModule];
          const audit = new AuditService(database), orders = new OrderService(database, createOrderPiiVault(), audit), inventory = new InventoryService(database, audit);
          phase = "order"; const external = createEntityId();
          const order = await orders.ingestNormalized(context, { accountId: value.accountId, platform: "amazon", externalEventId: external + ":1", externalOrderId: external,
            providerStatus: "paid", placedAt: new Date().toISOString(), orderTotal: { amountMinor: 1000, currency: "USD" },
            lines: [{ externalLineId: external + ":line", externalListingId: null, skuCode: null, title: "Synthetic agent metadata order", quantity: 1,
              unitPrice: { amountMinor: 1000, currency: "USD" }, customizationCount: 0 }], redactedSource: { fixture: "agent-read", id: external }, protectedDetails: null });
          const exceptionIds: string[] = [];
          for (let index = 0; index < 27; index++) {
            phase = "exception_" + index; const basis = await orders.exceptionOperations(context, order.id);
            const exception = await orders.openExceptionReviewed(context, order.id, { category: "address", code: "SYNTHETIC_AGENT_PRIVATE_CODE",
              message: "Synthetic private exception text excluded from the Agent tool", idempotencyKey: randomUUID(),
              expectedOrderSequence: basis.orderSequence, expectedSourceChecksum: basis.sourceChecksum }); exceptionIds.push(exception.id);
          }
          phase = "inventory"; const suffix = createEntityId().slice(-12).toUpperCase();
          const warehouse = await inventory.createWarehouse(context, { code: "AGENT-" + suffix, name: "Synthetic agent warehouse", type: "owned", countryCode: "US", timeZone: "UTC" });
          const item = await inventory.createStockItem(context, { code: "AGENT-MAT-" + suffix, name: "Synthetic exact agent stock", skuId: null, baseUnit: "meter" });
          const locationIds: string[] = [];
          for (let index = 0; index < 27; index++) {
            phase = "balance_" + index;
            const location = await inventory.createLocation(context, { warehouseId: warehouse.id, code: "AGENT-LOC-" + index, name: "Synthetic agent location " + index }); locationIds.push(location.id);
            await inventory.recordMovement(context, { stockItemId: item.id, locationId: location.id, lotId: null, bucket: "physical", type: "opening", quantityDelta: "1.000000001",
              unit: "meter", sourceType: "opening", sourceId: "synthetic-agent:" + location.id, reasonCode: "INITIAL_COUNT", occurredAt: new Date().toISOString(), idempotencyKey: randomUUID() });
          }
          phase = "zero_balance";
          await inventory.recordMovement(context, { stockItemId: item.id, locationId: locationIds[0]!, lotId: null, bucket: "physical", type: "adjustment", quantityDelta: "-1.000000001",
            unit: "meter", sourceType: "adjustment", sourceId: "synthetic-agent:zero", reasonCode: "SYNTHETIC", occurredAt: new Date().toISOString(), idempotencyKey: randomUUID() });
          await inventory.createReservation(context, { stockItemId: item.id, locationId: locationIds[1]!, lotId: null, quantity: "0.000000001", unit: "meter",
            sourceType: "manual", sourceId: "synthetic-agent:reserve", expiresAt: null, idempotencyKey: randomUUID() });
          const balances = (await inventory.listBalances(context)).filter(row => row.stockItemId === item.id).map(row => ({ locationId: row.locationId,
            physicalQuantity: row.physicalQuantity, reservedQuantity: row.reservedQuantity, availableQuantity: row.availableQuantity }));
          initialized = { context, inventory, stockItemId: item.id, locationId: locationIds[1]! };
          result = SeedSchema.parse({ orderId: order.id, exceptionIds, stockItemId: item.id, warehouseId: warehouse.id, locationIds, balances });
        } else if (value.operation === "append" && initialized) {
          phase = "append"; const { inventory, context, stockItemId, locationId } = initialized;
          await inventory.recordMovement(context, { stockItemId, locationId, lotId: null, bucket: "physical", type: "adjustment", quantityDelta: "0.000000001", unit: "meter",
            sourceType: "adjustment", sourceId: "synthetic-agent:changed", reasonCode: "SYNTHETIC", occurredAt: new Date().toISOString(), idempotencyKey: randomUUID() }); result = { appended: true };
        } else throw new Error("operation_invalid");
        process.send?.({ type: "result", nonce, id: value.id, value: result });
      } catch (error) {
        const candidate = error && typeof error === "object" ? error as { code?: unknown; cause?: { code?: unknown } } : {};
        process.send?.({ type: "failure", nonce, id: value.id, phase, code: candidate.code ?? candidate.cause?.code ?? null });
      }
    });
  });
  process.send?.({ type: "ready", nonce });
}

if (process.argv.includes("--agent-read-owner-child")) {
  void ownerChild().catch(() => { process.exitCode = 1; process.disconnect?.(); });
}
