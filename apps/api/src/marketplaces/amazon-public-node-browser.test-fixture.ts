import "reflect-metadata";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { createEntityId, TenantContextSchema } from "@yummyai/contracts";
import { ErpSessionViewSchema, erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { connectDatabase, roles, withTenant } from "@yummyai/database";
import { requireAmazonPublicNodeEnvironment } from "../../../../tools/testing/amazon-public-node-environment.mjs";
import { publicationNodePreviewFixture, nodeExecutionPermissions, type ExecutionNodeKeys, type PreviewSource } from "./publication-node-preview.test-fixture.js";

const Id = z.uuidv7(), Actor = z.object({ userId: Id, tenantId: Id, roleId: Id, membershipId: Id, subject: z.string().optional() }).passthrough();
const Input = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("seed"), scenario: z.enum(["public_ui", "preview_recovery"]) }).strict(),
  z.object({ operation: z.literal("register"), groupId: Id, accountId: Id }).strict(),
  z.object({ operation: z.literal("oauth"), groupId: Id, authorizationUrl: z.string().url().max(16384) }).strict(),
  z.object({ operation: z.enum(["bind", "source", "work", "snapshot", "close"]), groupId: Id }).strict(),
  z.object({ operation: z.literal("shutdown") }).strict(),
]);
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function browserApi() {
  const isolated = requireAmazonPublicNodeEnvironment(process.env, true), actor = Actor.parse(JSON.parse(process.env.ERP_FIXTURE_ACTORS!).operator), database = connectDatabase(isolated.url),
    ceiling = TenantContextSchema.parse({ tenantId: actor.tenantId, userId: actor.userId, permissions: [...nodeExecutionPermissions], dataScope: "tenant" });
  const saved = await withTenant(database.db, ceiling, async tx => (await tx.select().from(roles).where(and(eq(roles.id, actor.roleId), eq(roles.tenantId, actor.tenantId))))[0]);
  if (!saved) { await database.client.end(); throw new Error("amazon_public_browser_role_missing"); }
  const augmented = [...new Set([...saved.permissions, ...nodeExecutionPermissions])];
  let ready = false, closing: Promise<void> | undefined, shuttingDown = false, control: ReturnType<typeof createServer> | undefined;
  const f = publicationNodePreviewFixture(database, { actor: { ...actor, subject: actor.subject ?? "runner-owned-personal-operator" }, amazonPublic: true,
    apiPort: 8130, readyPath: "/__amazon_public_node_fixture_ready", ready: () => ready });
  type Group = { id: string; scenario: "public_ui" | "preview_recovery"; keys: ExecutionNodeKeys; accountId: string | null; nodeId: string | null;
    source: PreviewSource | null; child: Awaited<ReturnType<typeof f.workNode>> | null; codeIssued: boolean; closed: boolean };
  const groups = new Map<string, Group>();
  async function person() {
    const response = await f.http("/v1/identity/session"); if (response.status !== 200) throw new Error("amazon_public_browser_session_failed");
    const value = ErpSessionViewSchema.parse(response.body);
    if (value.userId !== actor.userId || value.tenantId !== actor.tenantId) throw new Error("amazon_public_browser_person_mismatch");
    return { actorId: value.userId, tenantId: value.tenantId, authoritySha256: createHash("sha256").update(erpSessionAuthority(value)).digest("hex") };
  }
  async function snapshot(group: Group) {
    const original = group.accountId ? await f.accountRows(group.accountId) : null, rows = await f.previewRows(), requests = rows.requests.filter(row => row.accountId === group.accountId),
      requestIds = new Set(requests.map(row => row.id));
    const business = await withTenant(database.db, ceiling, async tx => (await tx.execute<{ paid: number; publications: number; listingSyncs: number }>(sql`select
      (select count(*)::int from ai_budget_ledger) paid,
      (select count(*)::int from marketplace_publication_requests where action<>'amazon_validation_preview') publications,
      (select count(*)::int from marketplace_listing_sync_requests) "listingSyncs"`))[0]!);
    return { person: await person(), business, counts: f.provider.counts(),
      codeExchanges: f.provider.records.filter(row => !row.node && row.kind === "amazon_oauth" && row.credentialAccepted).length,
      centralRefreshes: f.provider.records.filter(row => !row.node && row.kind === "amazon_lwa").length,
      nodeApplicationRefreshes: f.provider.records.filter(row => row.node && row.kind === "amazon_lwa" && row.application === "node" && row.credentialAccepted).length,
      account: original?.account ? { id: original.account.id, authorizationMode: original.account.authorizationMode, status: original.account.status,
        credentialStatus: original.account.credentialStatus, authorizationGeneration: original.account.authorizationGeneration } : null,
      snapshots: original?.snapshots.map(row => ({ id: row.id, version: row.version, sourceChecksum: row.sourceChecksum })) ?? [],
      requests: requests.map(row => ({ id: row.id, listingVersionId: row.listingVersionId, action: row.action, payloadChecksum: row.payloadChecksum })),
      intents: rows.intents.filter(row => requestIds.has(row.requestId)).map(row => ({ requestId: row.requestId, requestKey: row.requestKey, requestChecksum: row.requestChecksum, nodeExecutionId: row.nodeExecutionId })),
      events: rows.events.filter(row => requestIds.has(row.requestId)).map(row => ({ id: row.id, requestId: row.requestId, status: row.status, sequence: row.sequence })),
      originalRequestRowsSha256: digest(requests), child: group.child ? { states: group.child.evidence.states, exited: group.child.evidence.exited,
        stderrCode: group.child.evidence.stderrCode, leaked: group.child.evidence.leaked } : null };
  }
  async function closeGroup(group: Group) {
    if (group.closed) return { closed: true, originalAuthorizationRevoked: true, childrenExited: true };
    const errors: unknown[] = [];
    try { await group.child?.close(); await f.stopChildren(); } catch (error) { errors.push(error); }
    if (group.accountId) {
      try {
        const rows = await f.previewRows();
        for (const row of rows.requests.filter(value => value.accountId === group.accountId)) {
          const intent = rows.intents.find(value => value.requestId === row.id), execution = rows.executions.find(value => value.id === intent?.nodeExecutionId);
          if (execution?.state === "waiting_node") await f.publications.cancelPreview(await f.current(), row.id, { reason: "Synthetic browser cleanup of original undispatched preview" });
        }
        await f.retireStore(group.accountId);
        const retired = await f.accountRows(group.accountId);
        if (retired.credential || retired.account?.credentialStatus !== "revoked") throw new Error("amazon_public_browser_revoke_not_confirmed");
      } catch (error) { errors.push(error); }
    }
    group.closed = true; if (errors.length) throw new AggregateError(errors, "amazon_public_browser_group_close_failed");
    return { closed: true, originalAuthorizationRevoked: true, childrenExited: true };
  }
  async function close() {
    ready = false; const errors: unknown[] = []; let controlClosed = false, databaseClosed = false, roleRestored = false, restoredRoleDigest: string | null = null;
    const savedRoleDigest = digest({ permissions: [...saved.permissions].sort(), dataScope: saved.dataScope });
    for (const group of groups.values()) if (!group.closed) try { await closeGroup(group); } catch (error) { errors.push(error); }
    try { if (control) { control.closeAllConnections(); await new Promise<void>((done, reject) => control!.close(error => error ? reject(error) : done())); } controlClosed = true; } catch (error) { errors.push(error); }
    try { await f.close(); } catch (error) { errors.push(error); }
    try {
      restoredRoleDigest = await withTenant(database.db, ceiling, async tx => {
        const [current] = await tx.select().from(roles).where(eq(roles.id, actor.roleId)).for("update");
        if (!current || ![saved.permissions, augmented, nodeExecutionPermissions].some(value => digest([...value].sort()) === digest([...current.permissions].sort())) ||
          ![saved.dataScope, "tenant"].includes(current.dataScope)) throw new Error("amazon_public_browser_role_changed");
        await tx.update(roles).set({ permissions: saved.permissions, dataScope: saved.dataScope }).where(eq(roles.id, actor.roleId));
        const [actual] = await tx.select().from(roles).where(eq(roles.id, actor.roleId)), value = actual ? digest({ permissions: [...actual.permissions].sort(), dataScope: actual.dataScope }) : null;
        if (value !== savedRoleDigest) throw new Error("amazon_public_browser_role_restore_unconfirmed"); return value;
      }); roleRestored = true;
    } catch (error) { errors.push(error); }
    try { await database.client.end(); databaseClosed = true; } catch (error) { errors.push(error); }
    const childSchema = z.object({ command: z.enum(["init", "enroll", "run", "work"]), pid: z.int().positive().nullable(), exited: z.boolean(), forced: z.boolean(),
      leaked: z.boolean(), exitCode: z.int().nullable(), stderrCode: z.string().regex(/^store_node_[a-z_]+$/).nullable() });
    const childExits = f.evidence.childExits.flatMap(row => { const parsed = childSchema.safeParse(row); if (parsed.success) return [parsed.data];
      errors.push(new Error("amazon_public_browser_child_proof_invalid")); return []; });
    if (childExits.some(row => !row.exited || row.leaked)) errors.push(new Error("amazon_public_browser_child_not_exited"));
    await writeFile(resolve(isolated.lane, "browser-api-close-" + isolated.nonce + ".json"), JSON.stringify({ nonce: isolated.nonce, pid: process.pid,
      roleRestored, savedRoleDigest, restoredRoleDigest, databaseClosed, controlClosed, cleanupFailureCount: errors.length, apiClosed: f.evidence.apiClosed,
      providerClosed: f.evidence.providerClosed, bootstrapClosed: f.evidence.bootstrapClosed, childExits }), { flag: "wx", mode: 0o600 });
    if (errors.length) throw new AggregateError(errors, "amazon_public_browser_close_failed");
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
        const chunks: Buffer[] = []; let size = 0; for await (const chunk of request) { size += chunk.length; if (size > 32768) throw new Error("amazon_public_control_input_size"); chunks.push(Buffer.from(chunk)); }
        const input = Input.parse(JSON.parse(Buffer.concat(chunks).toString("utf8"))); let result: unknown;
        if (input.operation === "shutdown") {
          shuttingDown = true; ready = false; response.setHeader("connection", "close");
          response.once("close", () => { closing ??= close(); void closing.then(() => process.exit(0), () => process.exit(1)); });
          response.writeHead(202); response.end(JSON.stringify({ accepted: true, nonce: isolated.nonce, pid: process.pid })); return;
        }
        if (shuttingDown) throw new Error("amazon_public_control_closing");
        if (input.operation === "seed") {
          if ([...groups.values()].some(group => !group.closed)) throw new Error("amazon_public_control_group_active");
          const id = createEntityId(); let group: Group;
          if (input.scenario === "preview_recovery") {
            const seeded = await f.bootstrapStore(), source = await f.seedListing(seeded.store.id);
            group = { id, scenario: input.scenario, keys: seeded.node.keys, nodeId: seeded.node.nodeId, accountId: seeded.store.id, source, child: null, closed: false, codeIssued: true };
          } else group = { id, scenario: input.scenario, keys: await f.initNode(), nodeId: null, accountId: null, source: null, child: null, closed: false, codeIssued: false };
          groups.set(id, group); result = { groupId: id, scenario: group.scenario, actorId: actor.userId, tenantId: actor.tenantId, accountId: group.accountId,
            nodeId: group.nodeId, source: group.source, displayName: "Synthetic-public-UI-" + id, initial: await snapshot(group) };
        } else {
          const group = groups.get(input.groupId); if (!group || group.closed) throw new Error("amazon_public_control_group_unknown");
          if (input.operation === "close") result = await closeGroup(group);
          else if (input.operation === "snapshot") result = await snapshot(group);
          else if (input.operation === "register") {
            if (group.accountId) throw new Error("amazon_public_control_already_registered");
            const account = await f.registerStore(input.accountId);
            if (account.authorizationMode !== "amazon_public" || account.platform !== "amazon" || account.displayName !== "Synthetic-public-UI-" + group.id)
              throw new Error("amazon_public_control_selected_account_mismatch");
            group.accountId = account.id; result = { registered: true, accountId: account.id };
          } else if (input.operation === "oauth") {
            if (!group.accountId || group.codeIssued) throw new Error("amazon_public_control_oauth_repeated");
            result = f.provider.amazonCode(input.authorizationUrl, f.provider.sellerId + "-" + group.accountId); group.codeIssued = true;
          } else {
            if (!group.accountId) throw new Error("amazon_public_control_account_missing");
            if (input.operation === "bind") {
              if (group.nodeId) throw new Error("amazon_public_control_binding_repeated");
              const account = await f.accounts.get(await f.current(), group.accountId);
              if (!account.hasCredential || account.credentialStatus !== "valid" || account.status !== "pending_authorization") throw new Error("amazon_public_control_oauth_not_adopted");
              const bound = await f.bindNode(group.accountId, group.keys); group.nodeId = bound.nodeId; result = { nodeId: bound.nodeId, actualCli: true };
            } else if (input.operation === "source") {
              if (!group.source) group.source = await f.seedListing(group.accountId); result = group.source;
            } else {
              if (!group.nodeId) throw new Error("amazon_public_control_node_missing");
              if (group.child && !group.child.evidence.exited) throw new Error("amazon_public_control_work_active");
              group.child = await f.workNode(group.keys); result = { actualCli: true, pid: group.child.evidence.pid };
            }
          }
        }
        response.writeHead(200); response.end(JSON.stringify(result));
      } catch { response.writeHead(409); response.end('{"code":"amazon_public_browser_control_rejected"}'); }
    });
    await new Promise<void>((done, reject) => { control!.once("error", reject); control!.listen(0, "127.0.0.1", done); });
    const address = control.address(); if (!address || typeof address === "string") throw new Error("amazon_public_browser_control_address");
    await writeFile(resolve(isolated.lane, "browser-control-" + isolated.nonce + ".json"), JSON.stringify({ nonce: isolated.nonce, pid: process.pid,
      origin: "http://127.0.0.1:" + address.port, key }), { flag: "wx", mode: 0o600 }); ready = true;
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { closing ??= close(); void closing.then(() => process.exit(0), () => process.exit(1)); });
  } catch { await close().catch(() => {}); throw new Error("amazon_public_browser_startup_failed"); }
}
if (process.argv.includes("--amazon-public-node-api")) void browserApi().catch(() => { process.stderr.write("amazon_public_browser_startup_failed\n"); process.exitCode = 1; });
