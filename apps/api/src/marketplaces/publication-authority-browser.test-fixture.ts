import "reflect-metadata";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { Permission } from "@yummyai/authz";
import { createEntityId, TenantContextSchema } from "@yummyai/contracts";
import { ErpSessionViewSchema, erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { PublicationPreviewRequestViewSchema } from "@yummyai/contracts/marketplace/publication-preview";
import { connectDatabase, roles, withTenant } from "@yummyai/database";
import { requirePublicationAuthorityEnvironment } from "../../../../tools/testing/publication-authority-environment.mjs";
import { publicationAuthoritySceneFixture } from "./publication-authority-scene.test-fixture.js";
import { nodeExecutionPermissions } from "./publication-node-preview.test-fixture.js";

const Id = z.uuidv7(), Scenario = z.enum(["listing_self", "store_self", "withdraw_store"]);
const Actor = z.object({ userId: Id, tenantId: Id, roleId: Id, membershipId: Id, subject: z.string().optional() }).passthrough();
const Input = z.discriminatedUnion("operation", [z.object({ operation: z.literal("seed"), scenario: Scenario }).strict(),
  z.object({ operation: z.literal("shutdown") }).strict(),
  z.object({ operation: z.enum(["change", "snapshot", "close"]), groupId: Id }).strict()]);
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function browserApi() {
  const isolated = requirePublicationAuthorityEnvironment(process.env, true), actor = Actor.parse(JSON.parse(process.env.ERP_FIXTURE_ACTORS!).operator),
    database = connectDatabase(isolated.url), ceiling = TenantContextSchema.parse({ tenantId: actor.tenantId, userId: actor.userId,
      permissions: [...nodeExecutionPermissions], dataScope: "tenant" });
  const saved = await withTenant(database.db, ceiling, async tx => (await tx.select().from(roles)
    .where(and(eq(roles.id, actor.roleId), eq(roles.tenantId, actor.tenantId))))[0]);
  if (!saved) { await database.client.end(); throw new Error("publication_authority_browser_role_missing"); }
  const augmented = [...new Set([...saved.permissions, ...nodeExecutionPermissions])];
  let ready = false, shutdownRequested = false, closing: Promise<void> | undefined, control: ReturnType<typeof createServer> | undefined;
  const f = publicationAuthoritySceneFixture(database, { actor: { ...actor, subject: actor.subject ?? "runner-owned-personal-operator" }, apiPort: 8130,
    readyPath: "/__publication_authority_fixture_ready", ready: () => ready });
  type Scene = Awaited<ReturnType<typeof f.scene>>;
  type Group = { scenario: z.infer<typeof Scenario>; scene: Scene; requestId: string; requestKey: string; requestChecksum: string;
    seedRestore?: () => Promise<void>; changeRestore?: () => Promise<void>; closed: boolean; changed: boolean };
  const groups = new Map<string, Group>();
  async function person() {
    const response = await f.original.http("/v1/identity/session"); if (response.status !== 200) throw new Error("publication_authority_browser_personal_session_failed");
    const session = ErpSessionViewSchema.parse(response.body);
    if (session.userId !== actor.userId || session.tenantId !== actor.tenantId) throw new Error("publication_authority_browser_personal_identity_mismatch");
    return { authoritySha256: createHash("sha256").update(erpSessionAuthority(session)).digest("hex"), permissions: session.permissions, permissionScopes: session.permissionScopes };
  }
  async function snapshot(group: Group) {
    const value = await f.diagnostics(group.scene, group.requestId);
    return { immutable: { request: value.request.sha256, intent: value.intent.sha256, events: value.events.map(row => ({ id: row.id, sha256: row.sha256 })),
      execution: hash(value.execution), steps: hash(value.steps), snapshots: value.snapshots.map(row => ({ id: row.id, sha256: row.sha256 })) },
      counts: f.original.provider.counts(), publicationCalls: f.original.provider.records.filter(row => row.node && row.kind === "amazon_listing_validation_preview").length,
      queuedPosts: 1, state: value.execution.state, person: await person() };
  }
  async function closeGroup(groupId: string) {
    const group = groups.get(groupId); if (!group || group.closed) throw new Error("publication_authority_browser_group_not_owned");
    const errors: unknown[] = [];
    for (const restore of [group.changeRestore, group.seedRestore]) if (restore) try { await restore(); } catch (error) { errors.push(error); }
    try { await f.original.stopChildren(); } catch (error) { errors.push(error); }
    try { await f.original.publications.cancelPreview(await f.current(), group.requestId, { reason: "Synthetic authority browser cleanup of never-dispatched original preview" }); } catch (error) { errors.push(error); }
    try { await f.original.retireStore(group.scene.store.id); } catch (error) { errors.push(error); }
    const retired = await f.original.accountRows(group.scene.store.id), node = await f.original.rows(group.scene.node.nodeId);
    const previewHttpCalls = f.original.provider.records.filter(row => row.node && row.kind === "amazon_listing_validation_preview").length;
    if (retired.account?.credentialStatus !== "revoked" || retired.credential || node.node?.status !== "revoked" || previewHttpCalls !== 0)
      errors.push(new Error("publication_authority_browser_original_cleanup_not_confirmed"));
    group.closed = true;
    if (errors.length) throw new AggregateError(errors, "publication_authority_browser_group_cleanup_failed");
    // stopChildren awaits each original CLI close, which verifies actual process exit.
    return { restored: true, originalAuthorizationRevoked: true, childrenExited: true, queuedPosts: 1, previewHttpCalls };
  }
  async function close() {
    ready = false; const errors: unknown[] = []; let roleRestored = false, restoredRoleDigest: string | null = null, databaseClosed = false, controlClosed = false;
    const savedRoleDigest = hash({ permissions: [...saved.permissions].sort(), dataScope: saved.dataScope });
    for (const [id, group] of groups) if (!group.closed) try { await closeGroup(id); } catch (error) { errors.push(error); }
    try { if (control) { control.closeAllConnections(); await new Promise<void>((done, fail) => control!.close(error => error ? fail(error) : done())); } controlClosed = true; } catch (error) { errors.push(error); }
    try { await f.close(); } catch (error) { errors.push(error); }
    try {
      restoredRoleDigest = await withTenant(database.db, ceiling, async tx => {
        const [current] = await tx.select().from(roles).where(eq(roles.id, actor.roleId)).for("update");
        const known = [saved.permissions, augmented, nodeExecutionPermissions].some(permissions => hash([...permissions].sort()) === hash([...(current?.permissions ?? [])].sort()));
        if (!current || !known || ![saved.dataScope, "tenant"].includes(current.dataScope)) throw new Error("publication_authority_browser_original_role_changed");
        await tx.update(roles).set({ permissions: saved.permissions, dataScope: saved.dataScope }).where(eq(roles.id, actor.roleId));
        const [restored] = await tx.select().from(roles).where(eq(roles.id, actor.roleId));
        const digest = restored ? hash({ permissions: [...restored.permissions].sort(), dataScope: restored.dataScope }) : null;
        if (digest !== savedRoleDigest) throw new Error("publication_authority_browser_role_restore_unconfirmed");
        return digest;
      });
      roleRestored = true;
    } catch (error) { errors.push(error); }
    try { await database.client.end(); databaseClosed = true; } catch (error) { errors.push(error); }
    const childExits: Array<{ command: "init" | "enroll" | "run" | "work"; pid: number | null; exited: boolean; forced: boolean; leaked: boolean; exitCode: number | null; stderrCode: string | null }> = [];
    for (const value of f.original.evidence.childExits) {
      const child = z.object({ command: z.enum(["init", "enroll", "run", "work"]),
      pid: z.number().int().positive().nullable(), exited: z.boolean(), forced: z.boolean(), leaked: z.boolean(), exitCode: z.number().int().nullable(),
        stderrCode: z.string().regex(/^store_node_[a-z_]+$/).nullable() }).safeParse(value);
      if (child.success) childExits.push(child.data); else errors.push(new Error("publication_authority_browser_child_evidence_invalid"));
    }
    if (childExits.some(child => !child.exited || child.leaked)) errors.push(new Error("publication_authority_browser_child_exit_unconfirmed"));
    await writeFile(resolve(isolated.lane, "browser-api-close-" + isolated.nonce + ".json"), JSON.stringify({ nonce: isolated.nonce, pid: process.pid,
      roleRestored, savedRoleDigest, restoredRoleDigest, databaseClosed, controlClosed,
      cleanupFailureCount: errors.length, apiClosed: f.original.evidence.apiClosed, bootstrapClosed: f.original.evidence.bootstrapClosed,
      providerClosed: f.original.evidence.providerClosed, childExits }), { flag: "wx", mode: 0o600 });
    if (errors.length) throw new AggregateError(errors, "publication_authority_browser_cleanup_failed");
  }
  try {
    await withTenant(database.db, ceiling, tx => tx.update(roles).set({ permissions: augmented, dataScope: "tenant" }).where(eq(roles.id, actor.roleId)));
    await f.initialize(); const key = randomBytes(32).toString("base64url");
    control = createServer(async (request, response) => {
      response.setHeader("content-type", "application/json"); const supplied = request.headers["x-fixture-control"];
      if (request.method !== "POST" || request.url !== "/" || typeof supplied !== "string" || supplied.length !== key.length || !timingSafeEqual(Buffer.from(supplied), Buffer.from(key))) { response.writeHead(404); response.end(); return; }
      try {
        const chunks: Buffer[] = []; let bytes = 0;
        for await (const chunk of request) { bytes += chunk.length; if (bytes > 8192) throw new Error("publication_authority_browser_control_too_large"); chunks.push(Buffer.from(chunk)); }
        const input = Input.parse(JSON.parse(Buffer.concat(chunks).toString("utf8"))); let result: unknown;
        if (input.operation === "shutdown") {
          shutdownRequested = true; ready = false;
          response.setHeader("connection", "close");
          response.once("close", () => { closing ??= close(); void closing.then(() => process.exit(0), () => process.exit(1)); });
          response.writeHead(202); response.end(JSON.stringify({ accepted: true, nonce: isolated.nonce, pid: process.pid })); return;
        }
        if (shutdownRequested) throw new Error("publication_authority_browser_shutdown_in_progress");
        if (input.operation === "seed") {
          if ([...groups.values()].some(group => !group.closed)) throw new Error("publication_authority_browser_group_active");
          const scene = await f.scene(), groupId = createEntityId();
          const scoped = input.scenario === "withdraw_store" ? undefined : await f.setPermissionScopes(scene.who,
            input.scenario === "listing_self" ? { [Permission.ListingRead]: "self", [Permission.StoreRead]: "tenant" } : { [Permission.StoreRead]: "self", [Permission.ListingRead]: "tenant" });
          const original = await f.original.previewInput(scene.source), created = await f.original.http("/v1/marketplace-publications/preview", original);
          if (created.status !== 201) throw new Error("publication_authority_browser_original_queue_failed");
          const view = PublicationPreviewRequestViewSchema.parse(created.body);
          const group: Group = { scenario: input.scenario, scene, requestId: view.request.id, requestKey: original.requestKey,
            requestChecksum: original.requestChecksum, seedRestore: scoped?.restore, closed: false, changed: false }; groups.set(groupId, group);
          result = { groupId, scenario: input.scenario, actorId: actor.userId, tenantId: actor.tenantId, requestId: group.requestId, requestKey: group.requestKey,
            requestChecksum: group.requestChecksum, source: { listingId: scene.source.listingId, versionId: scene.source.versionId, accountId: scene.store.id,
              variantSkuId: scene.source.variantSkuId, title: scene.source.title, storeName: scene.store.displayName }, initial: await snapshot(group) };
        } else {
          const group = groups.get(input.groupId); if (!group || group.closed) throw new Error("publication_authority_browser_group_not_owned");
          if (input.operation === "snapshot") result = await snapshot(group);
          else if (input.operation === "close") result = await closeGroup(input.groupId);
          else {
            if (group.changed) throw new Error("publication_authority_browser_change_repeated");
            const changed = group.scenario === "withdraw_store" ? await f.setPermissionScopes(group.scene.who, { [Permission.StoreRead]: null }) :
              await f.moveOwner(group.scene, group.scenario === "listing_self" ? "listing" : "store", f.original.peer);
            group.changeRestore = changed.restore; group.changed = true;
            result = { changed: true, sameAuthority: changed.beforeAuthority === changed.afterAuthority, state: await snapshot(group) };
          }
        }
        response.writeHead(200); response.end(JSON.stringify(result));
      } catch { response.writeHead(409); response.end('{"code":"publication_authority_browser_control_rejected"}'); }
    });
    await new Promise<void>((done, fail) => { control!.once("error", fail); control!.listen(0, "127.0.0.1", done); });
    const address = control.address(); if (!address || typeof address === "string") throw new Error("publication_authority_browser_control_address_invalid");
    await writeFile(resolve(isolated.lane, "browser-control-" + isolated.nonce + ".json"), JSON.stringify({ nonce: isolated.nonce, pid: process.pid, origin: "http://127.0.0.1:" + address.port, key }), { flag: "wx", mode: 0o600 }); ready = true;
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { closing ??= close(); void closing.then(() => process.exit(0), () => process.exit(1)); });
  } catch { await close().catch(() => {}); throw new Error("publication_authority_browser_startup_failed"); }
}
if (process.argv.includes("--publication-authority-api")) void browserApi().catch(() => { process.stderr.write("publication_authority_browser_startup_failed\n"); process.exitCode = 1; });
