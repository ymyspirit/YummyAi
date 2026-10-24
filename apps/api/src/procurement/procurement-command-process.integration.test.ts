import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { SecretVault } from "@yummyai/ai-core";
import { Permission } from "@yummyai/authz";
import { createEntityId } from "@yummyai/contracts";
import {
  PrepareProcurementCommandSchema, ProcurementCommandListSchema, ProcurementCommandViewSchema,
  type PrepareProcurementCommand, type ProcurementCommandKind, type ProcurementCommandView,
} from "@yummyai/contracts/procurement/procurement-command";
import {
  connectDatabase, migrateDatabase, withTenant, procurementCommands, inventoryProcurementWriteRequests,
  inventoryProcurementRequisitions, inventoryProcurementRequisitionVersions, inventoryProcurementRfqs,
  inventorySupplierQuoteVersions, inventoryPurchaseOrders, inventoryPurchaseOrderVersions, inventoryPurchaseOrderEvents,
} from "@yummyai/database";
import { and, eq, isNull, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createQueue, QueueName } from "../../../../packages/jobs/src/index.js";
import { startFactoryIdentityFixture } from "../../../../tools/testing/factory-identity-fixture.mjs";
import { ProcurementCommandService } from "./procurement-command.service.js";
import { procurementCommandBinding } from "./procurement-original-request.js";
import {
  procurementCommandFixture, procurementFixtureKey, procurementFixturePermissions, requireProcurementCommandFixture,
} from "./procurement-command.fixtures.js";

// Reject the ordinary database before constructing a connection or identity server.
requireProcurementCommandFixture();
if (process.env.E2E_PROCUREMENT_PROCESS_ISOLATED !== "1")
  throw new Error("Procurement API-process and privilege-fault checks require their independent disposable suite");

type Event = {
  type: string; phase?: string; state?: string; action?: string; commandId?: string; scheduler?: string;
  url?: string; pid?: number; queues?: string[]; schedulers?: string[]; redacted?: number; failures?: number; receivedAt?: number;
};
type StopMode = "ipc" | "SIGTERM" | "SIGKILL";
type Probe = {
  child: ChildProcess; events: Event[]; closed: Promise<number>;
  wait(type: string, phase?: string, after?: number, timeoutMs?: number): Promise<Event>;
  stop(mode?: StopMode): Promise<number>;
};
type Scenario = { original: PrepareProcurementCommand; sourceVersionId?: string };
const phases = ["before_commit", "after_commit"] as const;
const kinds = ["requisition_create", "rfq_create", "quote_record", "purchase_create",
  "supply_purchase_create", "purchase_revise", "purchase_review"] as const satisfies readonly ProcurementCommandKind[];
const apiDirectory = fileURLToPath(new URL("../../", import.meta.url));
const factTables = ["inventory_procurement_requisitions", "inventory_procurement_requisition_versions", "inventory_procurement_rfqs",
  "inventory_supplier_quote_versions", "inventory_purchase_orders", "inventory_purchase_order_versions", "inventory_purchase_order_events",
  "inventory_procurement_write_requests"] as const;
type Facts = Record<typeof factTables[number], { count: number; checksum: string }>;

describe.sequential("original procurement commands across actual API and maintenance process exits", () => {
  const database = connectDatabase(), fixture = procurementCommandFixture(database), { context, coworker, outsider, owner, audit } = fixture;
  const key = randomBytes(32), commands = new ProcurementCommandService(database, new SecretVault(key), owner, audit);
  const probes: Probe[] = [], owned = new Set<string>();
  let identity: Awaited<ReturnType<typeof startFactoryIdentityFixture>>;

  beforeAll(async () => {
    await migrateDatabase(database); await fixture.initialize();
    identity = await startFactoryIdentityFixture(context.tenantId, `procurement-command-${context.userId}`, "http://localhost:3130", {
      application: "erp", clientId: "yummyai-web", accounts: {
        coworker: { subject: `procurement-command-${coworker.userId}`, name: "Synthetic procurement coworker" },
        outsider: { subject: `procurement-command-${outsider.userId}`, name: "Synthetic other tenant", tenantId: outsider.tenantId },
      },
    });
    log({ type: "procurement.process.fixtures", tenantId: context.tenantId, operatorId: context.userId,
      coworkerId: coworker.userId, foreignTenantId: outsider.tenantId, foreignUserId: outsider.userId });
  }, 60_000);
  afterEach(async () => {
    // Always stop owned children first: a failed barrier must not hold the row
    // that the original-input acknowledgement needs for failure-safe teardown.
    const stopped = await Promise.allSettled(probes.map(probe => probe.stop("SIGKILL")));
    await fixture.setPermissions(context, procurementFixturePermissions);
    // A commit can succeed before the parent receives the IPC barrier or HTTP
    // result. Recover only this fixture's private unacknowledged rows as well.
    const retained = await withTenant(database.db, context, tx => tx.select({ id: procurementCommands.id }).from(procurementCommands)
      .where(and(eq(procurementCommands.createdBy, context.userId), isNull(procurementCommands.acknowledgedAt))));
    for (const row of retained) owned.add(row.id);
    for (const id of owned) {
      const row = await commands.get(context, id);
      if (row.status === "prepared") await commands.cancel(context, id);
      await commands.acknowledge(context, id);
      expect((await commands.get(context, id)).acknowledged).toBe(true);
    }
    owned.clear();
    if (stopped.some(result => result.status === "rejected")) throw new Error("Procurement child-process teardown incomplete");
  }, 60_000);
  afterAll(async () => {
    const stopped = await Promise.allSettled(probes.map(probe => probe.stop("SIGKILL")));
    try { await identity?.close(); } finally { key.fill(0); await database.client.end(); }
    const allExited = probes.every(probe => probe.child.exitCode !== null || probe.child.signalCode !== null);
    log({ type: "procurement.process.teardown", pids: probes.map(probe => probe.child.pid), allExited, identityClosed: true });
    if (!allExited || stopped.some(result => result.status === "rejected")) throw new Error("Procurement process cleanup incomplete");
  }, 30_000);

  function log(value: unknown) { process.stdout.write(JSON.stringify(value) + "\n"); }
  function requireClean(results: PromiseSettledResult<unknown>[], message: string) {
    if (results.some(result => result.status === "rejected")) throw new Error(message);
  }
  function observe(child: ChildProcess): Probe {
    let exited = false, diagnostic = "";
    const events: Event[] = [];
    // Drain app output. Only lifecycle identifiers and safe error codes escape
    // this fixture, never synthetic JWTs, encryption keys or raw private input.
    child.stdout?.on("data", () => {});
    child.stderr?.on("data", data => { diagnostic = /ERR_[A-Z0-9_]+/.exec(String(data))?.[0] ?? "child stderr"; });
    const closed = new Promise<number>(resolve => {
      child.once("error", () => { exited = true; resolve(-1); });
      child.once("exit", code => { exited = true; resolve(code ?? -1); });
    });
    child.on("message", message => {
      if (message && typeof message === "object" && "type" in message && typeof message.type === "string")
        events.push({ ...message as Event, receivedAt: performance.now() });
    });
    const probe: Probe = { child, events, closed,
      wait: (type, phase, after = 0, timeoutMs = 35_000) => new Promise<Event>((resolve, reject) => {
        const find = () => events.slice(after).find(item => item.type === type && (!phase || item.phase === phase || item.state === phase));
        const known = find(); if (known) { resolve(known); return; }
        if (exited) { reject(new Error(`Owned procurement process exited before ${type}: ${diagnostic}`)); return; }
        const cleanup = () => { clearTimeout(timer); child.off("message", changed); child.off("exit", stopped); child.off("error", stopped); };
        const timer = setTimeout(() => { cleanup(); reject(new Error(`Procurement lifecycle deadline: ${type}`)); }, timeoutMs);
        const stopped = () => { cleanup(); reject(new Error(`Owned procurement process exited before ${type}: ${diagnostic}`)); };
        const changed = () => { const event = find(); if (event) { cleanup(); resolve(event); } };
        child.on("message", changed); child.once("exit", stopped); child.once("error", stopped);
      }),
      stop: async (mode = "ipc") => {
        if (!exited) {
          if (mode !== "ipc" || !child.connected) child.kill(mode === "ipc" ? "SIGKILL" : mode);
          else child.send("shutdown", () => {});
        }
        let deadline: ReturnType<typeof setTimeout> | undefined;
        try {
          return await Promise.race([closed, new Promise<never>((_, reject) => {
            deadline = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Owned procurement stop deadline")); }, 10_000);
          })]);
        } finally { if (deadline) clearTimeout(deadline); }
      },
    };
    probes.push(probe); return probe;
  }
  function launch(options: { gate?: typeof phases[number]; action?: "prepare" | "execute"; commandId?: string; requestKey?: string } = {}) {
    return observe(spawn(process.execPath, ["--import", "./node_modules/tsx/dist/loader.mjs", "../../tools/testing/procurement-api-process-fixture.mts"], {
      cwd: apiDirectory, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"], env: {
        ...process.env, TSX_DISABLE_CACHE: "1", NODE_ENV: "test", OIDC_ISSUER: identity.baseUrl,
        OIDC_JWKS_URI: `${identity.baseUrl}/protocol/openid-connect/certs`, PROCUREMENT_COMMAND_ENCRYPTION_KEY: key.toString("base64url"),
        PROCUREMENT_FIXTURE_GATE: options.gate ?? "none", PROCUREMENT_FIXTURE_ACTION: options.action ?? "execute",
        PROCUREMENT_FIXTURE_COMMAND_ID: options.commandId, PROCUREMENT_FIXTURE_REQUEST_KEY: options.requestKey,
      },
    }));
  }
  async function token(actor: "operator" | "coworker" | "outsider") {
    if (actor === "operator") return identity.operatorToken();
    const response = await fetch(`${identity.baseUrl}/_fixture/token`, { method: "POST", headers: {
      "content-type": "application/x-www-form-urlencoded", "x-fixture-control": identity.controlKey,
    }, body: new URLSearchParams({ account: actor }), signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error("Synthetic procurement identity token unavailable");
    const value = await response.json() as { access_token?: unknown };
    if (typeof value.access_token !== "string") throw new Error("Synthetic procurement identity token invalid");
    return value.access_token;
  }
  async function request(probe: Probe, path = "", body?: unknown, options: { actor?: "operator" | "coworker" | "outsider"; token?: string } = {}) {
    const ready = await probe.wait("procurement.fixture.ready");
    if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(ready.url ?? "")) throw new Error("Unsafe synthetic procurement API origin");
    return fetch(`${ready.url}/v1/procurement/commands${path}`, { method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${options.token ?? await token(options.actor ?? "operator")}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(45_000),
    });
  }
  async function view(response: Response, status = 200) {
    expect(response.status).toBe(status);
    const value = ProcurementCommandViewSchema.parse(await response.json()); owned.add(value.id); return value;
  }
  async function stored(id: string) {
    const [row] = await withTenant(database.db, context, tx => tx.select().from(procurementCommands).where(eq(procurementCommands.id, id)));
    expect(row).toBeDefined(); return row!;
  }
  async function forKey(original: PrepareProcurementCommand) {
    const binding = procurementCommandBinding(original);
    return withTenant(database.db, context, tx => tx.select().from(procurementCommands).where(and(
      eq(procurementCommands.operation, binding.operation), eq(procurementCommands.requestKey, binding.idempotencyKey))));
  }
  function protectedOriginal(row: typeof procurementCommands.$inferSelect) {
    return { id: row.id, tenantId: row.tenantId, createdBy: row.createdBy, kind: row.kind, operation: row.operation, targetId: row.targetId,
      requestKey: row.requestKey, requestChecksum: row.requestChecksum, authoritySnapshot: row.authoritySnapshot,
      encryptedInput: row.encryptedInput, contractVersion: row.contractVersion, createdAt: row.createdAt, expiresAt: row.expiresAt };
  }
  async function facts(): Promise<Facts> {
    return withTenant(database.db, context, async tx => {
      const state = {} as Facts;
      for (const table of factTables) {
        const rows = await tx.execute(sql`select * from ${sql.identifier(table)} order by id`);
        state[table] = { count: rows.length, checksum: createHash("sha256").update(JSON.stringify(rows)).digest("hex") };
      }
      return state;
    });
  }
  async function scenario(kind: typeof kinds[number]): Promise<Scenario> {
    if (kind === "supply_purchase_create") {
      const b = await fixture.supplied(), [source] = await fixture.supply.history(context, b.link.id);
      return { original: { kind, targetId: b.link.id, input: b.input }, sourceVersionId: source!.id };
    }
    if (kind === "purchase_create" || kind === "quote_record") {
      const b = await fixture.quoted();
      return { original: kind === "purchase_create" ? { kind, targetId: null, input: b.quotedPurchaseInput }
        : { kind, targetId: b.rfq.id, input: { ...b.quoteInput, idempotencyKey: procurementFixtureKey() } } };
    }
    const b = await fixture.basis();
    if (kind === "requisition_create") return { original: { kind, targetId: null, input: b.requisitionInput } };
    if (kind === "rfq_create") {
      const requisition = await owner.createRequisition(context, b.requisitionInput);
      return { original: { kind, targetId: requisition.id, input: { expectedRequisitionVersion: 1, supplierIds: [fixture.supplierId],
        responseDueAt: b.future, idempotencyKey: procurementFixtureKey() } } };
    }
    const order = await owner.createPurchaseOrder(context, b.purchaseInput);
    return { original: kind === "purchase_revise" ? { kind, targetId: order.id, input: { expectedVersion: 1, currency: "USD", expectedAt: b.future,
      lines: b.purchaseInput.lines.map(line => ({ ...line, quantity: 21, unitCostMinor: 124 })), idempotencyKey: procurementFixtureKey() } }
      : { kind, targetId: order.id, input: { expectedVersion: 1, decision: "approved", reasonCode: "SYNTHETIC", idempotencyKey: procurementFixtureKey() } } };
  }
  async function assertActual(s: Scenario, result: ProcurementCommandView, before: Facts) {
    const { original } = s, binding = procurementCommandBinding(original), row = await stored(result.id);
    if (binding.operation === "invoice_record" || binding.operation === "invoice_reconcile") throw new Error("This fixture asserts the original 0146 proof domain");
    expect(result).toMatchObject({ status: "succeeded", original, result: { kind: original.kind }, canExecute: false });
    const [proof] = await withTenant(database.db, context, tx => tx.select().from(inventoryProcurementWriteRequests).where(and(
      eq(inventoryProcurementWriteRequests.operation, binding.operation), eq(inventoryProcurementWriteRequests.idempotencyKey, binding.idempotencyKey))));
    expect(proof).toBeDefined();
    expect(row).toMatchObject({ status: "succeeded", resultProofId: proof!.id, createdBy: context.userId,
      requestKey: binding.idempotencyKey, requestChecksum: binding.requestChecksum });
    expect(proof).toMatchObject({ tenantId: context.tenantId, createdBy: context.userId, operation: binding.operation,
      targetId: original.targetId, idempotencyKey: binding.idempotencyKey, requestChecksum: binding.requestChecksum });
    const added: Partial<Record<typeof factTables[number], number>> = { inventory_procurement_write_requests: 1 };
    await withTenant(database.db, context, async tx => {
      if (original.kind === "requisition_create") {
        const [request] = await tx.select().from(inventoryProcurementRequisitions).where(eq(inventoryProcurementRequisitions.id, proof!.requisitionId!));
        const [version] = await tx.select().from(inventoryProcurementRequisitionVersions).where(eq(inventoryProcurementRequisitionVersions.id, result.result!.versionId!));
        expect(request).toMatchObject({ id: result.result!.id, code: original.input.code, createdBy: context.userId, idempotencyKey: original.input.idempotencyKey });
        expect(version).toMatchObject({ requisitionId: request!.id, versionNumber: 1, lineSnapshot: original.input.lines });
        added.inventory_procurement_requisitions = 1; added.inventory_procurement_requisition_versions = 1;
      } else if (original.kind === "rfq_create") {
        const [rfq] = await tx.select().from(inventoryProcurementRfqs).where(eq(inventoryProcurementRfqs.id, proof!.rfqId!));
        expect(rfq).toMatchObject({ id: result.result!.id, requisitionId: original.targetId, supplierIds: original.input.supplierIds,
          createdBy: context.userId, idempotencyKey: original.input.idempotencyKey });
        expect(result.result).toMatchObject({ versionId: null, version: null }); added.inventory_procurement_rfqs = 1;
      } else if (original.kind === "quote_record") {
        const [quote] = await tx.select().from(inventorySupplierQuoteVersions).where(eq(inventorySupplierQuoteVersions.id, proof!.quoteId!));
        expect(quote).toMatchObject({ id: result.result!.id, rfqId: original.targetId, supplierId: original.input.supplierId,
          currency: original.input.currency, lineSnapshot: original.input.lines, versionNumber: 2, createdBy: context.userId,
          idempotencyKey: original.input.idempotencyKey });
        expect(result.result).toMatchObject({ versionId: quote!.id, version: 2 }); added.inventory_supplier_quote_versions = 1;
      } else {
        const [order] = await tx.select().from(inventoryPurchaseOrders).where(eq(inventoryPurchaseOrders.id, proof!.purchaseOrderId!));
        const [version] = await tx.select().from(inventoryPurchaseOrderVersions).where(eq(inventoryPurchaseOrderVersions.id, proof!.purchaseOrderVersionId!));
        const [event] = await tx.select().from(inventoryPurchaseOrderEvents).where(eq(inventoryPurchaseOrderEvents.id, proof!.purchaseOrderEventId!));
        const revised = original.kind === "purchase_revise", reviewed = original.kind === "purchase_review";
        expect(order).toMatchObject({ id: result.result!.id, createdBy: context.userId, status: reviewed ? "approved" : "draft", currentVersion: revised ? 2 : 1 });
        expect(version).toMatchObject({ id: result.result!.versionId, purchaseOrderId: order!.id, versionNumber: result.result!.version });
        expect(event).toMatchObject({ purchaseOrderId: order!.id, actorUserId: context.userId, idempotencyKey: original.input.idempotencyKey,
          action: reviewed ? "approved" : revised ? "revised" : "created", toStatus: reviewed ? "approved" : "draft" });
        if (original.kind === "purchase_create") expect(order).toMatchObject({ code: original.input.code, requisitionId: original.input.requisitionId,
          quoteId: original.input.quoteId, sourceSupplyVersionId: null });
        if (original.kind === "supply_purchase_create") {
          expect(order).toMatchObject({ code: original.input.code, sourceSupplyVersionId: s.sourceVersionId, purpose: original.input.purpose });
          expect(version!.lineSnapshot[0]).toMatchObject({ quantity: original.input.quantity, unitCostMinor: 123 });
        }
        if (original.kind === "purchase_create" || original.kind === "purchase_revise") expect(version!.lineSnapshot).toEqual(original.input.lines);
        if (!revised && !reviewed) added.inventory_purchase_orders = 1;
        if (!reviewed) added.inventory_purchase_order_versions = 1;
        added.inventory_purchase_order_events = 1;
      }
    });
    const after = await facts();
    for (const table of factTables) expect(after[table].count - before[table].count, table).toBe(added[table] ?? 0);
    return { proofId: proof!.id, after };
  }

  it.each(phases)("recovers the same original key after actual prepare-response loss %s", async phase => {
    const s = await scenario("requisition_create"), original = PrepareProcurementCommandSchema.parse(s.original), before = await facts();
    const interrupted = launch({ gate: phase, action: "prepare", requestKey: original.input.idempotencyKey });
    const response = request(interrupted, "", original).then(value => ({ received: true, status: value.status }), () => ({ received: false, status: 0 }));
    const barrier = await interrupted.wait("procurement.fixture.barrier", phase);
    expect(barrier).toMatchObject({ action: "prepare", pid: interrupted.child.pid }); expect(barrier.commandId).toBeTruthy();
    const admitted = await forKey(original);
    expect(admitted).toHaveLength(phase === "before_commit" ? 0 : 1);
    const admittedProtected = phase === "after_commit" ? protectedOriginal(admitted[0]!) : null;
    if (phase === "after_commit") owned.add(barrier.commandId!);
    expect(await facts()).toEqual(before);
    const stopMode = phase === "before_commit" ? "SIGTERM" : "SIGKILL";
    await interrupted.stop(stopMode); expect((await response).received).toBe(false);
    const restarted = launch();
    try {
      const listingResponse = await request(restarted); expect(listingResponse.status).toBe(200);
      const listing = ProcurementCommandListSchema.parse(await listingResponse.json());
      expect(listing.items.map(row => row.id)).toEqual(phase === "after_commit" ? [barrier.commandId] : []);
      const recovered = await view(await request(restarted, "", original), 201);
      expect(recovered).toMatchObject({ status: "prepared", original, result: null, canExecute: true });
      if (phase === "after_commit") expect(recovered.id).toBe(barrier.commandId);
      else expect(recovered.id).not.toBe(barrier.commandId);
      const protectedBefore = protectedOriginal(await stored(recovered.id));
      if (admittedProtected) expect(protectedBefore).toEqual(admittedProtected);
      expect((await view(await request(restarted, "", original), 201)).id).toBe(recovered.id);
      expect(await forKey(original)).toHaveLength(1); expect(await facts()).toEqual(before);
      expect((await request(restarted, "", { ...original, input: { ...original.input, code: "DIFFERENT-CODE" } })).status).toBe(409);
      for (const actor of ["coworker", "outsider"] as const) {
        expect((await request(restarted, `/${recovered.id}`, undefined, { actor })).status).toBe(404);
        expect((await request(restarted, `/${recovered.id}/execute`, {}, { actor })).status).toBe(404);
      }
      expect(protectedOriginal(await stored(recovered.id))).toEqual(protectedBefore);
      const executed = await view(await request(restarted, `/${recovered.id}/execute`, {}));
      const actual = await assertActual({ ...s, original }, executed, before);
      expect(protectedOriginal(await stored(recovered.id))).toEqual(protectedBefore);
      log({ type: "procurement.process.prepare", phase, stopMode, lostResponse: true, recoveredCommandId: recovered.id,
        rolledBackCommandId: phase === "before_commit" ? barrier.commandId : null, proofId: actual.proofId,
        pids: [interrupted.child.pid, restarted.child.pid], commandCount: 1, actualProofCount: 1 });
    } finally { await restarted.stop(); }
  }, 120_000);

  it.each(kinds.flatMap(kind => phases.map(phase => ({ kind, phase }))))("recovers $kind exactly once after actual API exit $phase", async ({ kind, phase }) => {
    const s = await scenario(kind); s.original = PrepareProcurementCommandSchema.parse(s.original);
    const original = s.original, before = await facts(), preparation = launch();
    const prepared = await view(await request(preparation, "", original), 201), protectedBefore = protectedOriginal(await stored(prepared.id));
    expect(prepared).toMatchObject({ status: "prepared", original, result: null });
    expect(await facts()).toEqual(before); expect(await preparation.stop()).toBe(0);
    const interrupted = launch({ gate: phase, commandId: prepared.id });
    const response = request(interrupted, `/${prepared.id}/execute`, {}).then(value => ({ received: true, status: value.status }), () => ({ received: false, status: 0 }));
    const barrier = await interrupted.wait("procurement.fixture.barrier", phase);
    expect(barrier).toMatchObject({ commandId: prepared.id, action: "execute", pid: interrupted.child.pid });
    const atBarrier = await stored(prepared.id);
    expect(atBarrier.status).toBe(phase === "before_commit" ? "prepared" : "succeeded");
    expect(protectedOriginal(atBarrier)).toEqual(protectedBefore);
    if (phase === "before_commit") { expect(atBarrier.resultProofId).toBeNull(); expect(await facts()).toEqual(before); }
    else expect(atBarrier.resultProofId).not.toBeNull();
    const stopMode = phase === "before_commit" ? "SIGTERM" : "SIGKILL";
    await interrupted.stop(stopMode); expect((await response).received).toBe(false);
    const restarted = launch();
    try {
      const restored = await view(await request(restarted, `/${prepared.id}`));
      expect(restored).toMatchObject({ status: phase === "before_commit" ? "prepared" : "succeeded", original });
      expect(protectedOriginal(await stored(prepared.id))).toEqual(protectedBefore);
      const replayedPreparation = await view(await request(restarted, "", original), 201);
      expect(replayedPreparation.id).toBe(prepared.id);
      const executed = await view(await request(restarted, `/${prepared.id}/execute`, {}));
      const actual = await assertActual(s, executed, before);
      if (phase === "after_commit") expect(executed.result).toEqual(restored.result);
      expect((await view(await request(restarted, `/${prepared.id}/execute`, {}))).result).toEqual(executed.result);
      expect(await facts()).toEqual(actual.after);
      expect(await forKey(original)).toHaveLength(1);
      expect(protectedOriginal(await stored(prepared.id))).toEqual(protectedBefore);
      log({ type: "procurement.process.execute", kind, phase, stopMode, commandId: prepared.id, proofId: actual.proofId,
        resultId: executed.result!.id, resultVersionId: executed.result!.versionId, recoveredStatus: restored.status,
        pids: [preparation.child.pid, interrupted.child.pid, restarted.child.pid], lostResponse: true, actualProofCount: 1, replayChangedFacts: false });
    } finally { await restarted.stop(); }
  }, 120_000);

  it.each(["purchase_create", "purchase_review"] as const)("rechecks actual current authority after restarting a pending %s", async kind => {
    const s = await scenario(kind), before = await facts(), preparation = launch();
    const prepared = await view(await request(preparation, "", s.original), 201), protectedBefore = protectedOriginal(await stored(prepared.id));
    const oldAccessToken = await identity.operatorToken(); expect(await preparation.stop()).toBe(0);
    const permission = kind === "purchase_review" ? Permission.ProcurementApprove : Permission.ProcurementWrite;
    await fixture.setPermissions(context, procurementFixturePermissions.filter(value => value !== permission));
    const restarted = launch();
    try {
      const denied = await view(await request(restarted, `/${prepared.id}`, undefined, { token: oldAccessToken }));
      expect(denied).toMatchObject({ status: "prepared", original: s.original, canExecute: false, blockReason: "permission_denied" });
      expect((await request(restarted, `/${prepared.id}/execute`, {}, { token: oldAccessToken })).status).toBe(403);
      for (const actor of ["coworker", "outsider"] as const) {
        expect((await request(restarted, `/${prepared.id}`, undefined, { actor })).status).toBe(404);
        expect((await request(restarted, `/${prepared.id}/execute`, {}, { actor })).status).toBe(404);
      }
      expect(await facts()).toEqual(before); expect(protectedOriginal(await stored(prepared.id))).toEqual(protectedBefore);
      await fixture.setPermissions(context, procurementFixturePermissions);
      const executed = await view(await request(restarted, `/${prepared.id}/execute`, {})), actual = await assertActual(s, executed, before);
      await fixture.setPermissions(context, procurementFixturePermissions.filter(value => value !== Permission.ProcurementRead));
      expect((await request(restarted, `/${prepared.id}`, undefined, { token: oldAccessToken })).status).toBe(403);
      expect((await request(restarted, `/${prepared.id}/execute`, {}, { token: oldAccessToken })).status).toBe(403);
      expect(await facts()).toEqual(actual.after); expect(protectedOriginal(await stored(prepared.id))).toEqual(protectedBefore);
      log({ type: "procurement.process.authority", kind, commandId: prepared.id, proofId: actual.proofId,
        pids: [preparation.child.pid, restarted.child.pid], oldTokenCannotRestorePermission: true, privateActorUnchanged: true });
    } finally { await fixture.setPermissions(context, procurementFixturePermissions); await restarted.stop(); }
  }, 120_000);

  it("runs actual minute privacy cycles, skips a locked original, preserves real proofs and restarts with zero consumers", async () => {
    const b = await fixture.basis(), dueIds: string[] = [];
    let retainedId = "", succeededId = "";
    for (let index = 0; index < 102; index++) {
      const requisition = await owner.createRequisition(context, { ...b.requisitionInput, code: `${b.requisitionInput.code}-TTL-${index}`, idempotencyKey: procurementFixtureKey() });
      const prepared = await commands.prepare(context, { kind: "rfq_create", targetId: requisition.id, input: { expectedRequisitionVersion: 1,
        supplierIds: [fixture.supplierId], responseDueAt: b.future, idempotencyKey: procurementFixtureKey() } });
      owned.add(prepared.id);
      if (index < 101) dueIds.push(prepared.id); else retainedId = prepared.id;
      if (index === 1) { succeededId = prepared.id; await commands.execute(context, prepared.id); }
    }
    const succeeded = await stored(succeededId), successView = await commands.get(context, succeededId), before = await facts();
    expect(succeeded.resultProofId).not.toBeNull();
    const [lifetime] = await withTenant(database.db, context, tx => tx.execute<{ exact: boolean }>(sql`select expires_at=created_at+interval '7 days' as exact
      from inventory_procurement_commands where id=${retainedId}::uuid`));
    expect(lifetime!.exact).toBe(true);
    // Exact synthetic rows only. The normal app/maintenance transactions keep
    // all production CHECKs, RLS and mutation guards enabled during execution.
    requireProcurementCommandFixture();
    await database.client.begin(async synthetic => {
      await synthetic.unsafe("set local session_replication_role=replica");
      await synthetic.unsafe("with t as (select clock_timestamp() as at) update inventory_procurement_commands set created_at=t.at-interval '8 days',expires_at=t.at-interval '1 day' from t where tenant_id=$1 and id=any($2::uuid[])",
        [context.tenantId, `{${dueIds.join(",")}}`]);
    });
    let releaseLock!: () => void, lockReady!: () => void, lockFailed!: (error: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => { lockReady = resolve; lockFailed = reject; });
    const lockHeld = withTenant(database.db, context, async tx => {
      await tx.select({ id: procurementCommands.id }).from(procurementCommands).where(eq(procurementCommands.id, dueIds[0]!)).for("update");
      await new Promise<void>(resolve => { releaseLock = resolve; lockReady(); });
    }).catch(error => { lockFailed(error); throw error; });
    await ready;
    let queue: ReturnType<typeof createQueue> | undefined;
    let sentinel: Awaited<ReturnType<ReturnType<typeof createQueue>["add"]>> | undefined, maintenance: Probe | undefined, restarted: Probe | undefined;
    const launchMaintenance = () => observe(spawn(process.execPath, ["--import", "./node_modules/tsx/dist/loader.mjs", "../../tools/scripts/procurement-retention-runtime.mjs"], {
      cwd: apiDirectory, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"], env: { ...process.env, TSX_DISABLE_CACHE: "1",
        WORKER_QUEUES: "all", WORKER_SCHEDULERS: "all", WORKER_STARTUP_TIMEOUT_MS: "10000", WORKER_SHUTDOWN_TIMEOUT_MS: "10000" },
    }));
    try {
      queue = createQueue(QueueName.WorkflowNode);
      sentinel = await queue.add("synthetic-procurement-retention-sentinel", { fixture: "owned-disposable-only" }, { jobId: createEntityId() });
      // Table privilege faults are permitted only in this independent disposable
      // suite and are restored even if the real worker fails to start.
      await database.client.unsafe("revoke update on inventory_procurement_commands from yummyai_app");
      maintenance = launchMaintenance();
      const started = await maintenance.wait("worker.lifecycle", "ready");
      expect(started.queues).toEqual([]); expect(started.schedulers).toEqual(["procurementCommandRetentionScheduler"]);
      const deferred = await maintenance.wait("worker.maintenance");
      expect(deferred).toMatchObject({ scheduler: "procurementCommandRetentionScheduler", state: "deferred", redacted: 0 });
      expect(deferred.failures).toBeGreaterThan(0);
      expect((await stored(dueIds[2]!)).encryptedInput).not.toBeNull(); expect(await facts()).toEqual(before);
      await database.client.unsafe("grant update on inventory_procurement_commands to yummyai_app");
      const first = await maintenance.wait("worker.maintenance", undefined, maintenance.events.length, 90_000);
      expect(first).toMatchObject({ scheduler: "procurementCommandRetentionScheduler", state: "completed", redacted: 100, failures: 0 });
      expect(first.receivedAt! - deferred.receivedAt!).toBeGreaterThanOrEqual(50_000);
      expect((await stored(dueIds[0]!)).encryptedInput).not.toBeNull();
      expect((await stored(dueIds[2]!))).toMatchObject({ status: "expired", encryptedInput: null, resultProofId: null });
      expect((await stored(retainedId))).toMatchObject({ status: "prepared", redactedAt: null });
      expect((await stored(retainedId)).encryptedInput).not.toBeNull();
      expect((await stored(succeededId))).toMatchObject({ status: "succeeded", resultProofId: succeeded.resultProofId, encryptedInput: null, completedAt: succeeded.completedAt });
      expect((await commands.get(context, succeededId))).toMatchObject({ status: "succeeded", original: null, result: successView.result });
      expect(await facts()).toEqual(before); expect(await sentinel.getState()).toBe("waiting");
      releaseLock(); await lockHeld;
      const second = await maintenance.wait("worker.maintenance", undefined, maintenance.events.length, 90_000);
      expect(second).toMatchObject({ scheduler: "procurementCommandRetentionScheduler", state: "completed", redacted: 1, failures: 0 });
      expect(second.receivedAt! - first.receivedAt!).toBeGreaterThanOrEqual(50_000);
      expect((await stored(dueIds[0]!))).toMatchObject({ status: "expired", encryptedInput: null });
      expect((await commands.get(context, retainedId)).original).not.toBeNull();
      expect(await facts()).toEqual(before); expect(await sentinel.getState()).toBe("waiting");
      expect(await maintenance.stop()).toBe(0);
      restarted = launchMaintenance();
      const restartedReady = await restarted.wait("worker.lifecycle", "ready");
      expect(restartedReady.queues).toEqual([]); expect(restartedReady.schedulers).toEqual(["procurementCommandRetentionScheduler"]);
      expect(await restarted.wait("worker.maintenance")).toMatchObject({ scheduler: "procurementCommandRetentionScheduler", state: "completed", redacted: 0, failures: 0 });
      expect(await sentinel.getState()).toBe("waiting"); expect(await facts()).toEqual(before); expect(await restarted.stop()).toBe(0);
      log({ type: "procurement.process.retention", pids: [maintenance.child.pid, restarted.child.pid], expiredCommandIds: dueIds,
        liveCommandId: retainedId, succeededCommandId: succeededId, proofId: succeeded.resultProofId, sentinelJobId: sentinel.id,
        zeroConsumers: true, inheritedAllOverridden: true, deferredFailures: deferred.failures, actualTimerBatches: [first.redacted, second.redacted],
        timerGapsMs: [first.receivedAt! - deferred.receivedAt!, second.receivedAt! - first.receivedAt!], lockedRowSkipped: true, actualFactsUnchanged: true });
    } finally {
      const cleanup = await Promise.allSettled([
        database.client.unsafe("grant update on inventory_procurement_commands to yummyai_app"),
        (async () => { releaseLock(); await lockHeld; })(),
        maintenance?.stop("SIGKILL"), restarted?.stop("SIGKILL"),
        (async () => { try { await sentinel?.remove(); } finally { await queue?.close(); } })(),
      ]);
      requireClean(cleanup, "Procurement retention process teardown incomplete");
    }
  }, 300_000);
});
