import "reflect-metadata";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";
import { Permission } from "@yummyai/authz";
import { createEntityId, TenantContextSchema } from "@yummyai/contracts";
import { StoreNodeEnrollmentBundleSchema } from "@yummyai/contracts/marketplace/store-node";
import { connectDatabase, withTenant, roles, type DatabaseConnection } from "@yummyai/database";
import { requireStoreNodeExecutionEnvironment } from "../../../../tools/testing/require-store-node-execution-environment.mjs";
import { lane, nodeExecutionPermissions, nodeExecutionSha, storeNodeExecutionFixture, type ExecutionNodeKeys } from "./store-node-execution.test-fixture.js";

const Id = z.uuidv7(), Actor = z.object({ userId: Id, tenantId: Id, roleId: Id, membershipId: Id, subject: z.string().optional() }).passthrough();
const Input = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("seed") }).strict(), z.object({ operation: z.literal("init"), groupId: Id }).strict(),
  z.object({ operation: z.literal("enroll"), groupId: Id, keyId: Id, bundle: StoreNodeEnrollmentBundleSchema }).strict(),
  z.object({ operation: z.enum(["run", "work", "stop"]), groupId: Id, keyId: Id }).strict(),
  z.object({ operation: z.literal("rights"), groupId: Id, enabled: z.boolean() }).strict(),
  z.object({ operation: z.enum(["snapshot", "close"]), groupId: Id }).strict(),
]);
/** Separate original AppModule entry, with real OIDC and TLS configured before bootstrap. */
async function browserApi() {
  const target = requireStoreNodeExecutionEnvironment(process.env, "current", true), actor = Actor.parse(JSON.parse(process.env.ERP_FIXTURE_ACTORS!).operator);
  const database = connectDatabase(target.url), ceiling = TenantContextSchema.parse({ tenantId: actor.tenantId, userId: actor.userId, permissions: nodeExecutionPermissions, dataScope: "tenant" });
  const original = await withTenant(database.db, ceiling, async tx => (await tx.select().from(roles).where(and(eq(roles.id, actor.roleId), eq(roles.tenantId, actor.tenantId))))[0]);
  if (!original) { await database.client.end(); throw new Error("store_node_execution_browser_role_missing"); }
  const permissions = [...new Set([...original.permissions, ...nodeExecutionPermissions])];
  const rights = (enabled: boolean) => withTenant(database.db, ceiling, tx => tx.update(roles).set({ permissions: enabled ? permissions : permissions.filter(bit => bit !== Permission.StoreManage), dataScope: original.dataScope }).where(eq(roles.id, original.id)));
  let ready = false, control: ReturnType<typeof createServer> | undefined, closed = false;
  const f = storeNodeExecutionFixture(database, { actor: { userId: actor.userId, tenantId: actor.tenantId, roleId: actor.roleId, membershipId: actor.membershipId,
    subject: actor.subject ?? "runner-owned-real-personal-operator" }, apiPort: 8130, readyPath: "/__store_node_execution_fixture_ready", ready: () => ready });
  type Child = Awaited<ReturnType<typeof f.runNode>>;
  type Group = { ids: string[]; keys: Map<string, ExecutionNodeKeys & { nodeId?: string; process?: Child }>; children: Child[]; closed: boolean };
  const groups = new Map<string, Group>();
  const closeGroup = async (id: string) => { const group = groups.get(id); if (!group || group.closed) throw new Error("store_node_execution_browser_group_unavailable");
    const errors: unknown[] = []; await rights(true);
    for (const child of group.children) try { await child.close(); } catch (error) { errors.push(error); }
    for (const accountId of group.ids) try { await f.retireStore(accountId); } catch (error) { errors.push(error); }
    group.closed = true; if (errors.length) throw new AggregateError(errors, "store_node_execution_browser_group_cleanup_failed");
    return { accountIds: group.ids, childrenExited: group.children.every(child => child.evidence.exited), noSecretOutput: group.children.every(child => !child.evidence.leaked), originalAuthorizationsRevoked: true };
  };
  const close = async () => { if (closed) return; closed = true; ready = false; const failures: unknown[] = [];
    for (const [id, group] of groups) if (!group.closed) try { await closeGroup(id); } catch (error) { failures.push(error); }
    if (control) try { control.closeAllConnections(); await new Promise<void>(done => control!.close(() => done())); } catch (error) { failures.push(error); }
    try { await f.close(); } catch (error) { failures.push(error); }
    try { await withTenant(database.db, ceiling, tx => tx.update(roles).set({ permissions: original.permissions, dataScope: original.dataScope }).where(eq(roles.id, original.id))); } catch (error) { failures.push(error); }
    try { await database.client.end(); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, "store_node_execution_browser_api_cleanup_failed");
  };
  try {
    await rights(true); await f.initialize(); const key = randomBytes(32).toString("base64url");
    control = createServer(async (request, response) => {
      response.setHeader("content-type", "application/json"); const candidate = request.headers["x-fixture-control"];
      if (request.method !== "POST" || request.url !== "/" || typeof candidate !== "string" || candidate.length !== key.length || !timingSafeEqual(Buffer.from(candidate), Buffer.from(key))) { response.writeHead(404); response.end(); return; }
      try { const chunks: Buffer[] = []; let size = 0; for await (const chunk of request) { size += chunk.length; if (size > 65536) throw new Error("bounded"); chunks.push(Buffer.from(chunk)); }
        const input = Input.parse(JSON.parse(Buffer.concat(chunks).toString("utf8"))); let result: unknown;
        if (input.operation === "seed") { const groupId = createEntityId(), group: Group = { ids: [], keys: new Map(), children: [], closed: false }; groups.set(groupId, group);
          for (const platform of ["etsy", "amazon"] as const) group.ids.push((await f.createStore(f.a, platform)).id);
          result = { groupId, ids: group.ids, actorId: actor.userId, tenantId: actor.tenantId };
        } else { const group = groups.get(input.groupId); if (!group || group.closed) throw new Error("owned_group_required");
          if (input.operation === "init") { const keys = await f.initNode(); group.keys.set(keys.id, keys); result = { keyId: keys.id, publicKeyPem: keys.publicKeyPem }; }
          else if (input.operation === "enroll") { const keys = group.keys.get(input.keyId); if (!keys || !group.ids.includes(input.bundle.accountId)) throw new Error("owned_key_required");
            result = await f.enrollBundle(keys, input.bundle); keys.nodeId = input.bundle.nodeId;
          } else if (input.operation === "run" || input.operation === "work" || input.operation === "stop") { const keys = group.keys.get(input.keyId); if (!keys?.nodeId) throw new Error("owned_enrolled_key_required");
            if (input.operation === "work") {
              const current = await f.rows(keys.nodeId);
              if (!keys.process || !current.node || !group.ids.includes(current.node.accountId) || current.binding?.nodeId !== keys.nodeId || current.binding.state !== "active") throw new Error("owned_active_heartbeat_required");
              await f.waitSavedHeartbeat(keys, keys.process, { accountId: current.node.accountId, nodeId: keys.nodeId, bindingRevision: current.binding.revision });
            }
            await keys.process?.close(); if (input.operation === "stop") result = { exited: keys.process?.evidence.exited ?? true };
            else { keys.process = input.operation === "run" ? await f.runNode(keys) : await f.workNode(keys); group.children.push(keys.process); result = { nodeId: keys.nodeId, started: true }; }
          } else if (input.operation === "rights") { await rights(input.enabled); result = { updated: true }; }
          else if (input.operation === "close") result = await closeGroup(input.groupId);
          else { const originals = await Promise.all(group.ids.map(accountId => f.accountRows(accountId)));
            const business = await withTenant(database.db, ceiling, async tx => (await tx.execute<{ paid: number; publications: number; listingSyncs: number }>(sql`select
              (select count(*)::int from ai_budget_ledger) paid,(select count(*)::int from marketplace_publication_requests) publications,(select count(*)::int from marketplace_listing_sync_requests) "listingSyncs"`))[0]);
            result = { business, accounts: originals.map((row, index) => ({ id: group.ids[index], status: row.account?.status ?? "missing", credentialVersion: row.credential?.version ?? 0,
              refreshState: row.account?.credentialRefreshState ?? "missing", snapshots: row.snapshots.map(snapshot => ({ id: snapshot.id, version: snapshot.version, sourceChecksum: snapshot.sourceChecksum })),
              originalRowsSha: nodeExecutionSha(JSON.stringify(row)) })), counts: f.provider.counts(), children: group.children.map(child => child.evidence) };
          }
        }
        response.writeHead(200); response.end(JSON.stringify(result));
      } catch { response.writeHead(409); response.end('{"code":"store_node_execution_browser_control_rejected"}'); }
    });
    await new Promise<void>((done, fail) => { control!.once("error", fail); control!.listen(0, "127.0.0.1", done); });
    const address = control.address(); if (!address || typeof address === "string") throw new Error("store_node_execution_browser_control_address_invalid");
    await writeFile(resolve(lane, "browser-control-" + target.nonce + ".json"), JSON.stringify({ nonce: target.nonce, pid: process.pid, origin: "http://127.0.0.1:" + address.port, key }), { flag: "wx", mode: 0o600 }); ready = true;
    let closing: Promise<void> | undefined;
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { closing ??= close(); void closing.then(() => process.exit(0), () => process.exit(1)); });
  } catch { await close().catch(() => {}); throw new Error("store_node_execution_browser_startup_failed"); }
}
if (process.argv.includes("--store-node-execution-api")) void browserApi().catch(() => { process.stderr.write("store_node_execution_browser_startup_failed\n"); process.exitCode = 1; });
export type StoreNodeExecutionBrowserDatabase = DatabaseConnection;
