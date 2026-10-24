import "reflect-metadata";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { Permission } from "@yummyai/authz";
import { createEntityId, TenantContextSchema } from "@yummyai/contracts";
import { ErpSessionViewSchema, erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { connectDatabase, roles, withTenant } from "@yummyai/database";
import { requirePublicationNodeSubmitEnvironment } from "../../../../tools/testing/publication-node-submit-environment.mjs";
import { publicationNodeSubmitFixture, submitFixtureDigest } from "./publication-node-submit.test-fixture.js";
import { nodeExecutionPermissions } from "./publication-node-preview.test-fixture.js";

const Id = z.uuidv7(), Actor = z.object({ userId: Id, tenantId: Id, roleId: Id, membershipId: Id, subject: z.string().optional() }).passthrough();
const Input = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("seed"), scenario: z.enum(["explicit_submit_status", "lost_submit_recovery"]) }).strict(),
  z.object({ operation: z.literal("work"), groupId: Id, executionId: Id }).strict(),
  z.object({ operation: z.enum(["snapshot", "withdraw", "close"]), groupId: Id }).strict(),
  z.object({ operation: z.literal("shutdown") }).strict(),
]);
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

async function browserApi() {
  const isolated = requirePublicationNodeSubmitEnvironment(process.env, "current", true),
    actor = Actor.parse(JSON.parse(process.env.ERP_FIXTURE_ACTORS!).operator), database = connectDatabase(isolated.url),
    ceiling = TenantContextSchema.parse({ tenantId: actor.tenantId, userId: actor.userId, permissions: [...nodeExecutionPermissions], dataScope: "tenant" });
  const [saved] = await withTenant(database.db, ceiling, tx => tx.select().from(roles).where(and(eq(roles.id, actor.roleId), eq(roles.tenantId, actor.tenantId))));
  if (!saved) { await database.client.end(); throw new Error("publication_submit_browser_original_role_missing"); }
  const augmented = [...new Set([...saved.permissions, ...nodeExecutionPermissions])], withdrawn = augmented.filter(value => value !== Permission.StoreRead);
  let ready = false, shuttingDown = false, closing: Promise<void> | undefined, control: ReturnType<typeof createServer> | undefined;
  const f = publicationNodeSubmitFixture(database, { actor: { ...actor, subject: actor.subject ?? "runner-owned-personal-operator" }, amazonPublic: true,
    apiPort: 8130, readyPath: "/__publication_node_submit_fixture_ready", ready: () => ready });
  type Group = { id: string; scenario: "explicit_submit_status" | "lost_submit_recovery"; scene: Awaited<ReturnType<typeof f.scene>>;
    child: Awaited<ReturnType<typeof f.original.workNode>> | null; closed: boolean; withdrawn: boolean };
  const groups = new Map<string, Group>();
  async function person() {
    const response = await f.original.http("/v1/identity/session"); if (response.status !== 200) throw new Error("publication_submit_browser_personal_session_failed");
    const value = ErpSessionViewSchema.parse(response.body);
    if (value.userId !== actor.userId || value.tenantId !== actor.tenantId) throw new Error("publication_submit_browser_person_mismatch");
    return { actorId: value.userId, tenantId: value.tenantId, authoritySha256: sha(erpSessionAuthority(value)) };
  }
  async function snapshot(group: Group) {
    const rows = await f.readOnlyRows(), requests = rows.requests.filter(row => row.listingId === group.scene.source.listingId), ids = new Set(requests.map(row => row.id)),
      operations = rows.operations.filter(row => ids.has(row.requestId)), results = rows.results.filter(row => ids.has(row.requestId)),
      business = await withTenant(database.db, ceiling, async tx => (await tx.execute<{ paid: number; listingSyncs: number }>(sql`select
        (select count(*)::int from ai_budget_ledger) paid,(select count(*)::int from marketplace_listing_sync_requests) "listingSyncs"`))[0]!);
    return { person: await person(), business, counts: f.original.provider.counts(),
      centralRefreshes: f.original.provider.records.filter(row => !row.node && row.kind === "amazon_lwa").length,
      requests: requests.map(row => ({ id: row.id, parentRequestId: row.parentRequestId, action: row.action, listingVersionId: row.listingVersionId,
        payloadChecksum: row.payloadChecksum, sha256: submitFixtureDigest(row) })),
      intents: rows.intents.filter(row => ids.has(row.requestId)).map(row => ({ requestId: row.requestId, route: row.route, sha256: submitFixtureDigest(row) })),
      operations: operations.map(row => ({ id: row.id, requestId: row.requestId, kind: row.kind, requestKey: row.requestKey, requestChecksum: row.requestChecksum,
        executionId: row.nodeExecutionId, sha256: submitFixtureDigest(row) })),
      results: results.map(row => ({ operationId: row.operationId, requestId: row.requestId, adoptedAsRequestStatus: row.adoptedAsRequestStatus, sha256: submitFixtureDigest(row) })),
      events: rows.events.filter(row => ids.has(row.requestId)).map(row => ({ id: row.id, requestId: row.requestId, sequence: row.sequence, status: row.status, sha256: submitFixtureDigest(row) })),
      child: group.child ? { pid: group.child.evidence.pid, exited: group.child.evidence.exited, leaked: group.child.evidence.leaked, states: group.child.evidence.states, stderrCode: group.child.evidence.stderrCode } : null };
  }
  async function restoreRole() {
    await withTenant(database.db, ceiling, async tx => {
      const [current] = await tx.select().from(roles).where(eq(roles.id, actor.roleId)).for("update");
      if (!current || ![saved.permissions, augmented, withdrawn, nodeExecutionPermissions].some(value => submitFixtureDigest([...value].sort()) === submitFixtureDigest([...current.permissions].sort())) ||
        ![saved.dataScope, "tenant"].includes(current.dataScope)) throw new Error("publication_submit_browser_role_changed");
      await tx.update(roles).set({ permissions: augmented, dataScope: "tenant" }).where(eq(roles.id, actor.roleId));
    });
  }
  async function closeGroup(group: Group) {
    if (group.closed) return { closed: true, originalAuthorizationRevoked: true, childrenExited: true };
    const errors: unknown[] = [];
    try { await group.child?.close(); await f.original.stopChildren(); } catch (error) { errors.push(error); }
    try {
      await restoreRole(); const rows = await f.readOnlyRows();
      for (const operation of rows.operations.filter(row => row.kind === "submit" && row.target.listingId === group.scene.source.listingId)) {
        const execution = rows.executions.find(row => row.id === operation.nodeExecutionId);
        if (execution?.state === "waiting_node") await f.original.publications.cancelSubmission(await f.original.current(), operation.requestId,
          { reason: "Synthetic browser cleanup before the original node claims the formal submission" });
      }
      await f.original.retireStore(group.scene.store.id); const retired = await f.original.accountRows(group.scene.store.id), node = await f.original.rows(group.scene.node.nodeId);
      if (retired.credential || retired.account?.credentialStatus !== "revoked" || node.node?.status !== "revoked") throw new Error("publication_submit_browser_retirement_not_confirmed");
    } catch (error) { errors.push(error); }
    group.closed = true; if (errors.length) throw new AggregateError(errors, "publication_submit_browser_group_close_failed");
    return { closed: true, originalAuthorizationRevoked: true, childrenExited: true };
  }
  async function close() {
    ready = false; const errors: unknown[] = []; let controlClosed = false, databaseClosed = false, roleRestored = false;
    const savedRoleDigest = submitFixtureDigest({ permissions: [...saved.permissions].sort(), dataScope: saved.dataScope }); let restoredRoleDigest: string | null = null;
    for (const group of groups.values()) if (!group.closed) try { await closeGroup(group); } catch (error) { errors.push(error); }
    try { if (control) { control.closeAllConnections(); await new Promise<void>((done, fail) => control!.close(error => error ? fail(error) : done())); } controlClosed = true; } catch (error) { errors.push(error); }
    try { await f.close(); } catch (error) { errors.push(error); }
    try {
      await restoreRole();
      restoredRoleDigest = await withTenant(database.db, ceiling, async tx => {
        await tx.update(roles).set({ permissions: saved.permissions, dataScope: saved.dataScope }).where(eq(roles.id, actor.roleId));
        const [actual] = await tx.select().from(roles).where(eq(roles.id, actor.roleId));
        return actual ? submitFixtureDigest({ permissions: [...actual.permissions].sort(), dataScope: actual.dataScope }) : null;
      });
      roleRestored = restoredRoleDigest === savedRoleDigest; if (!roleRestored) throw new Error("publication_submit_browser_role_restore_not_confirmed");
    } catch (error) { errors.push(error); }
    try { await database.client.end(); databaseClosed = true; } catch (error) { errors.push(error); }
    const childExits = f.original.evidence.childExits as Array<{ pid: number | null; exited: boolean; leaked: boolean; forced: boolean }>;
    if (childExits.some(row => !row.exited || row.leaked)) errors.push(new Error("publication_submit_browser_child_not_exited"));
    await writeFile(resolve(isolated.lane, "browser-api-close-" + isolated.nonce + ".json"), JSON.stringify({ nonce: isolated.nonce, pid: process.pid,
      roleRestored, savedRoleDigest, restoredRoleDigest, databaseClosed, controlClosed, apiClosed: f.original.evidence.apiClosed,
      providerClosed: f.original.evidence.providerClosed, bootstrapClosed: f.original.evidence.bootstrapClosed, childExits, cleanupFailureCount: errors.length }), { flag: "wx", mode: 0o600 });
    if (errors.length) throw new AggregateError(errors, "publication_submit_browser_close_failed");
  }
  try {
    await withTenant(database.db, ceiling, tx => tx.update(roles).set({ permissions: augmented, dataScope: "tenant" }).where(eq(roles.id, actor.roleId)));
    await f.initialize(); const key = randomBytes(32).toString("base64url");
    control = createServer(async (request, response) => {
      response.setHeader("content-type", "application/json"); const supplied = request.headers["x-fixture-control"];
      if (request.method !== "POST" || request.url !== "/" || typeof supplied !== "string" || supplied.length !== key.length || !timingSafeEqual(Buffer.from(supplied), Buffer.from(key))) {
        response.writeHead(404); response.end(); return;
      }
      try {
        const chunks: Buffer[] = []; let size = 0; for await (const chunk of request) { size += chunk.length; if (size > 16384) throw new Error("publication_submit_browser_control_input_limit"); chunks.push(Buffer.from(chunk)); }
        const input = Input.parse(JSON.parse(Buffer.concat(chunks).toString("utf8"))); let result: unknown;
        if (input.operation === "shutdown") {
          shuttingDown = true; ready = false; response.setHeader("connection", "close");
          response.once("close", () => { closing ??= close(); void closing.then(() => process.exit(0), () => process.exit(1)); });
          response.writeHead(202); response.end(JSON.stringify({ accepted: true, nonce: isolated.nonce, pid: process.pid })); return;
        }
        if (shuttingDown) throw new Error("publication_submit_browser_closing");
        if (input.operation === "seed") {
          if ([...groups.values()].some(group => !group.closed)) throw new Error("publication_submit_browser_group_active");
          const scene = await f.scene(), group: Group = { id: createEntityId(), scenario: input.scenario, scene, child: null, closed: false, withdrawn: false };
          groups.set(group.id, group); result = { groupId: group.id, scenario: group.scenario, actorId: actor.userId, tenantId: actor.tenantId, accountId: scene.store.id,
            nodeId: scene.node.nodeId, source: scene.source, previewId: scene.preview.request.id, initial: await snapshot(group) };
        } else {
          const group = groups.get(input.groupId); if (!group || group.closed) throw new Error("publication_submit_browser_group_not_owned");
          if (input.operation === "work") {
            const rows = await f.readOnlyRows(), operation = rows.operations.find(row => row.nodeExecutionId === input.executionId && row.createdBy === actor.userId && row.target.listingId === group.scene.source.listingId),
              execution = rows.executions.find(row => row.id === input.executionId && row.accountId === group.scene.store.id && row.nodeId === group.scene.node.nodeId);
            if (!operation || !execution || execution.state !== "waiting_node") throw new Error("publication_submit_browser_original_waiting_operation_required");
            group.child = await f.original.workNode(group.scene.node.keys); const terminal = await f.waitOperation(execution.id, group.child);
            if (terminal.state === "succeeded") {
              const deadline = Date.now() + 20_000; while (Date.now() < deadline && !(await f.journal(group.scene.node.keys)).completed) await new Promise<void>(done => setTimeout(done, 50));
              if (!(await f.journal(group.scene.node.keys)).completed) throw new Error("publication_submit_browser_original_local_receipt_missing");
            }
            await group.child.close(); result = { terminal, snapshot: await snapshot(group) };
          } else if (input.operation === "withdraw") {
            if (group.withdrawn) throw new Error("publication_submit_browser_already_withdrawn"); const before = await person();
            await withTenant(database.db, ceiling, tx => tx.update(roles).set({ permissions: withdrawn, dataScope: "tenant" }).where(eq(roles.id, actor.roleId)));
            group.withdrawn = true; result = { beforeAuthority: before.authoritySha256, afterAuthority: (await person()).authoritySha256, permission: Permission.StoreRead };
          } else if (input.operation === "snapshot") result = await snapshot(group);
          else result = await closeGroup(group);
        }
        response.writeHead(200); response.end(JSON.stringify(result));
      } catch { response.writeHead(409); response.end('{"code":"publication_submit_fixture_control_rejected"}'); }
    });
    await new Promise<void>((done, fail) => { control!.once("error", fail); control!.listen(0, "127.0.0.1", done); });
    const address = control.address(); if (!address || typeof address === "string") throw new Error("publication_submit_browser_control_address_invalid");
    await writeFile(resolve(isolated.lane, "browser-control-" + isolated.nonce + ".json"), JSON.stringify({ nonce: isolated.nonce, pid: process.pid,
      origin: `http://127.0.0.1:${address.port}/`, key }), { flag: "wx", mode: 0o600 }); ready = true;
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { closing ??= close(); void closing.then(() => process.exit(0), () => process.exit(1)); });
  } catch (error) { try { await close(); } catch (cleanup) { throw new AggregateError([error, cleanup], "publication_submit_browser_initialize_failed"); } throw error; }
}
if (process.argv.includes("--publication-node-submit-api")) await browserApi();
