import { createHash } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { erpPermissionContext, permissionScope, type PermissionValue } from "@yummyai/authz";
import { createEntityId, TenantContextSchema, type TenantContext } from "@yummyai/contracts";
import { erpSessionAuthority } from "@yummyai/contracts/auth/session";
import {
  listings, loadCurrentMembershipContext, marketplaceAccounts, marketplaceCapabilitySnapshots,
  marketplaceCredentials, marketplacePublicationEvents, marketplacePublicationIntents,
  marketplacePublicationRequests, marketplaceStoreNodeBindings, marketplaceStoreNodeExecutions,
  marketplaceStoreNodeExecutionSteps, marketplaceStoreNodes, memberships, membershipRoles, roles,
  withTenant, type DatabaseConnection,
} from "@yummyai/database";
import { requirePublicationAuthorityEnvironment } from "../../../../tools/testing/publication-authority-environment.mjs";
import {
  nodeExecutionPermissions, publicationNodePreviewFixture, type ExecutionActor, type PreviewSource,
} from "./publication-node-preview.test-fixture.js";

type OriginalFixture = ReturnType<typeof publicationNodePreviewFixture>;
export type PublicationAuthoritySceneOptions = NonNullable<Parameters<typeof publicationNodePreviewFixture>[1]>;
export type PublicationAuthorityScene = Awaited<ReturnType<OriginalFixture["bootstrapStore"]>> & {
  who: ExecutionActor;
  source: PreviewSource;
};
export type PublicationAuthorityScopeOverrides = Readonly<Partial<Record<PermissionValue, "self" | "tenant" | null>>>;
type Restore = () => Promise<void>;

const authorityOf = (context: TenantContext) => erpSessionAuthority(erpPermissionContext(context));
const fail = (suffix: string): never => { throw new Error("publication_authority_fixture_" + suffix); };
const iso = (value: Date | null) => value?.toISOString() ?? null;
function canonical(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value !== null && typeof value === "object") {
    return "{" + Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => JSON.stringify(key) + ":" + canonical(item)).join(",") + "}";
  }
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  const result = JSON.stringify(value);
  return result === undefined ? fail("diagnostic_value_invalid") : result;
}
const checksum = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
const safeCode = (code: string | null) => code !== null && /^(?:(?:store_node_|marketplace_|publication_)[a-z_]{1,100}|[A-Z][A-Z_]{1,100})$/.test(code) ? code : null;

/** Scene metadata belongs only to the disposable authority family. Original business owners,
 * CLI, mTLS, provider gates and recovery remain the original preview fixture's implementation. */
export function publicationAuthoritySceneFixture(database: DatabaseConnection, options: PublicationAuthoritySceneOptions = {}) {
  const isolated = requirePublicationAuthorityEnvironment();
  const original = publicationNodePreviewFixture(database, options);
  const scenes = new Map<PublicationAuthorityScene, { who: ExecutionActor; listingId: string; accountId: string; nodeId: string }>();
  const restorers = new Set<Restore>(), activeScopes = new Set<string>(), activeOwners = new Set<string>();
  const releases = new Set<() => void>();
  let initialized = false, closing = false, closed = false, closePromise: Promise<void> | undefined;

  function ready() { if (!initialized || closing || closed) fail("not_open"); }
  function actor(raw: ExecutionActor): ExecutionActor {
    const found = [original.a, original.peer, original.foreign].find(value => value && value.userId === raw.userId &&
      value.tenantId === raw.tenantId && value.membershipId === raw.membershipId && value.roleId === raw.roleId);
    return found ?? fail("actor_not_owned");
  }
  function owned(scene: PublicationAuthorityScene) {
    const value = scenes.get(scene);
    if (!value || scene.who !== value.who || scene.source.listingId !== value.listingId ||
      scene.store.id !== value.accountId || scene.source.accountId !== value.accountId || scene.node.nodeId !== value.nodeId)
      return fail("scene_not_owned");
    return value;
  }
  function rememberRestore(action: Restore): Restore {
    let finished = false, running: Promise<void> | undefined;
    const restore: Restore = () => {
      if (finished) return Promise.resolve();
      running ??= action().then(() => { finished = true; restorers.delete(restore); }).finally(() => { running = undefined; });
      return running;
    };
    restorers.add(restore);
    return restore;
  }
  async function initialize() {
    if (initialized || closing || closed) fail("initialize_repeated");
    requirePublicationAuthorityEnvironment();
    await original.initialize();
    initialized = true;
  }
  async function current(who: ExecutionActor = original.a) { ready(); return original.current(actor(who)); }
  async function authority(who: ExecutionActor = original.a) { return authorityOf(await current(who)); }
  async function scene(who: ExecutionActor = original.a): Promise<PublicationAuthorityScene> {
    ready(); who = actor(who);
    const bootstrap = await original.bootstrapStore(who), source = await original.seedListing(bootstrap.store.id, who);
    const result = { ...bootstrap, who, source };
    scenes.set(result, { who, listingId: source.listingId, accountId: bootstrap.store.id, nodeId: bootstrap.node.nodeId });
    return result;
  }

  /** Splits controlled permissions out of the broad original role so max-scope role union
   * cannot conceal a self grant. Unmentioned permissions retain their actual original scope. */
  async function setPermissionScopes(rawActor: ExecutionActor, overrides: PublicationAuthorityScopeOverrides) {
    ready(); const who = actor(rawActor), entries = Object.entries(overrides) as [PermissionValue, "self" | "tenant" | null][];
    if (!entries.length || entries.some(([bit, scope]) => !nodeExecutionPermissions.some(value => value === bit) ||
      (scope !== null && scope !== "self" && scope !== "tenant"))) fail("permission_patch_invalid");
    if (activeScopes.has(who.membershipId)) fail("permission_patch_active");
    activeScopes.add(who.membershipId);
    try {
      const saved = await withTenant(database.db, who.ceiling, async tx => {
        const linked = await tx.select({ roleId: membershipRoles.roleId }).from(membershipRoles)
          .where(eq(membershipRoles.membershipId, who.membershipId)).for("update");
        if (linked.length !== 1 || linked[0]?.roleId !== who.roleId) fail("original_role_changed");
        const [role] = await tx.select().from(roles).where(eq(roles.id, who.roleId)).for("update");
        if (!role) return fail("original_role_missing");
        const before = TenantContextSchema.parse(await loadCurrentMembershipContext(tx, who, { lock: true }));
        const bits = new Set(entries.map(([bit]) => bit)), permissions = role.permissions.filter(bit => !bits.has(bit as PermissionValue));
        await tx.update(roles).set({ permissions }).where(eq(roles.id, who.roleId));
        const additions: Array<{ id: string; permission: PermissionValue; scope: "self" | "tenant" }> = [];
        for (const [permission, scope] of entries) if (scope !== null) {
          const id = createEntityId();
          await tx.insert(roles).values({ id, tenantId: who.tenantId, name: "Synthetic publication authority " + id, permissions: [permission], dataScope: scope });
          await tx.insert(membershipRoles).values({ tenantId: who.tenantId, membershipId: who.membershipId, roleId: id });
          additions.push({ id, permission, scope });
        }
        const after = TenantContextSchema.parse(await loadCurrentMembershipContext(tx, who, { lock: true }));
        for (const bit of nodeExecutionPermissions) {
          const selected = entries.find(([permission]) => permission === bit);
          if (selected) {
            if (selected[1] === null ? after.permissions.includes(bit) : !after.permissions.includes(bit) || permissionScope(after, bit) !== selected[1])
              fail("permission_patch_not_effective");
          } else if (before.permissions.includes(bit) !== after.permissions.includes(bit) ||
            (before.permissions.includes(bit) && permissionScope(before, bit) !== permissionScope(after, bit))) fail("unselected_permission_changed");
        }
        return { before, after, role, permissions, additions };
      });
      const restore = rememberRestore(async () => {
        await withTenant(database.db, who.ceiling, async tx => {
          const [role] = await tx.select().from(roles).where(eq(roles.id, who.roleId)).for("update");
          if (!role || checksum(role.permissions) !== checksum(saved.permissions) || role.dataScope !== saved.role.dataScope)
            fail("permission_restore_conflict");
          const linked = await tx.select({ roleId: membershipRoles.roleId }).from(membershipRoles)
            .where(eq(membershipRoles.membershipId, who.membershipId)).for("update");
          if (checksum(linked.map(row => row.roleId).sort()) !== checksum([who.roleId, ...saved.additions.map(row => row.id)].sort()))
            fail("permission_restore_links_changed");
          for (const addition of saved.additions) {
            const [added] = await tx.select().from(roles).where(eq(roles.id, addition.id)).for("update");
            const users = await tx.select({ membershipId: membershipRoles.membershipId }).from(membershipRoles)
              .where(eq(membershipRoles.roleId, addition.id));
            if (!added || checksum(added.permissions) !== checksum([addition.permission]) || added.dataScope !== addition.scope ||
              users.length !== 1 || users[0]?.membershipId !== who.membershipId) fail("permission_restore_role_changed");
            await tx.delete(membershipRoles).where(and(eq(membershipRoles.membershipId, who.membershipId), eq(membershipRoles.roleId, addition.id)));
            await tx.delete(roles).where(eq(roles.id, addition.id));
          }
          await tx.update(roles).set({ permissions: saved.role.permissions, dataScope: saved.role.dataScope }).where(eq(roles.id, who.roleId));
          const restored = TenantContextSchema.parse(await loadCurrentMembershipContext(tx, who, { lock: true }));
          if (authorityOf(restored) !== authorityOf(saved.before)) fail("permission_restore_authority_changed");
        });
        activeScopes.delete(who.membershipId);
      });
      return { before: saved.before, after: saved.after, beforeAuthority: authorityOf(saved.before), afterAuthority: authorityOf(saved.after), restore };
    } catch (error) { activeScopes.delete(who.membershipId); throw error; }
  }

  /** Changes only this scene's true owner. Listing/store have no trusted team field.
   * The actor's membership, roles, original intent and credential generation stay intact. */
  async function moveOwner(value: PublicationAuthorityScene, kind: "listing" | "store", next: ExecutionActor) {
    ready(); const pin = owned(value), nextOwner = actor(next);
    if (nextOwner.tenantId !== pin.who.tenantId || nextOwner.userId === pin.who.userId) fail("owner_target_invalid");
    const objectKey = kind + ":" + (kind === "listing" ? pin.listingId : pin.accountId);
    if (activeOwners.has(objectKey)) fail("owner_patch_active");
    activeOwners.add(objectKey);
    const table = kind === "listing" ? listings : marketplaceAccounts, id = kind === "listing" ? pin.listingId : pin.accountId;
    try {
      const saved = await withTenant(database.db, pin.who.ceiling, async tx => {
        const [membership] = await tx.select({ id: memberships.id }).from(memberships).where(and(eq(memberships.id, nextOwner.membershipId),
          eq(memberships.userId, nextOwner.userId), eq(memberships.status, "active"))).for("share");
        if (!membership) fail("owner_membership_inactive");
        const before = TenantContextSchema.parse(await loadCurrentMembershipContext(tx, pin.who, { lock: true }));
        const [row] = await tx.select({ createdBy: table.createdBy }).from(table).where(eq(table.id, id)).for("update");
        if (row?.createdBy !== pin.who.userId) fail("owner_patch_conflict");
        const changed = await tx.update(table).set({ createdBy: nextOwner.userId })
          .where(and(eq(table.id, id), eq(table.createdBy, pin.who.userId))).returning({ id: table.id });
        if (changed.length !== 1) fail("owner_patch_conflict");
        const after = TenantContextSchema.parse(await loadCurrentMembershipContext(tx, pin.who, { lock: true }));
        if (authorityOf(before) !== authorityOf(after)) fail("owner_patch_changed_authority");
        return { beforeAuthority: authorityOf(before), afterAuthority: authorityOf(after) };
      });
      const restore = rememberRestore(async () => {
        await withTenant(database.db, pin.who.ceiling, async tx => {
          const restored = await tx.update(table).set({ createdBy: pin.who.userId })
            .where(and(eq(table.id, id), eq(table.createdBy, nextOwner.userId))).returning({ id: table.id });
          if (restored.length !== 1) fail("owner_restore_conflict");
        });
        activeOwners.delete(objectKey);
      });
      return { ...saved, originalCreatedBy: pin.who.userId, newCreatedBy: nextOwner.userId, restore };
    } catch (error) { activeOwners.delete(objectKey); throw error; }
  }

  function arm(kind: "amazon_lwa" | "amazon_listing_validation_preview") {
    ready(); const gate = original.provider.arm(kind);
    releases.add(() => gate.release.release());
    return gate;
  }

  async function head(path: string, who: ExecutionActor = original.a) {
    ready(); who = actor(who);
    const url = new URL(path, "http://synthetic-fixture.invalid"), keys = [...url.searchParams.keys()];
    const id = "[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
    const workspace = url.pathname === "/v1/marketplace-publications/preview/workspace";
    const exactObject = new RegExp(`^/v1/(?:marketplace-publications/preview|listings)/${id}$`).test(url.pathname);
    if (!path.startsWith("/") || url.origin !== "http://synthetic-fixture.invalid" || url.hash ||
      (!workspace && !exactObject) || url.search.length > 8192 || (!workspace && keys.length) ||
      (workspace && keys.some(key => !["listingId", "listingVersionId", "accountIds"].includes(key)))) fail("head_path_invalid");
    const response = await fetch(original.origin + url.pathname + url.search, { method: "HEAD", redirect: "error", cache: "no-store",
      headers: { authorization: "Bearer " + await original.token(who) }, signal: AbortSignal.timeout(15_000) });
    return { status: response.status, cacheControl: response.headers.get("cache-control"), bodyBytes: (await response.arrayBuffer()).byteLength };
  }

  /** Safe inspection after original HTTP owners reject a withdrawn actor. These exact scene
   * IDs are inspected through the nonowner RLS role in a single read-only snapshot. Private
   * fields contribute to row hashes in memory and are never returned or logged. */
  async function diagnostics(value: PublicationAuthorityScene, requestId: string) {
    ready(); const pin = owned(value);
    return withTenant(database.db, pin.who.ceiling, async tx => {
      const [request] = await tx.select().from(marketplacePublicationRequests).where(and(eq(marketplacePublicationRequests.id, requestId),
        eq(marketplacePublicationRequests.accountId, pin.accountId), eq(marketplacePublicationRequests.listingId, pin.listingId),
        eq(marketplacePublicationRequests.createdBy, pin.who.userId)));
      if (!request) return fail("diagnostic_request_not_owned");
      const [intent] = await tx.select().from(marketplacePublicationIntents).where(and(eq(marketplacePublicationIntents.requestId, requestId),
        eq(marketplacePublicationIntents.createdBy, pin.who.userId)));
      if (!intent || intent.route !== "node_preview" || !intent.nodeExecutionId ||
        intent.target?.accountId !== pin.accountId || intent.target.listingId !== pin.listingId) fail("diagnostic_intent_not_owned");
      const executionId = intent.nodeExecutionId ?? fail("diagnostic_execution_missing");
      const events = await tx.select().from(marketplacePublicationEvents).where(eq(marketplacePublicationEvents.requestId, requestId))
        .orderBy(asc(marketplacePublicationEvents.sequence), asc(marketplacePublicationEvents.id));
      const [execution] = await tx.select({
        id: marketplaceStoreNodeExecutions.id, accountId: marketplaceStoreNodeExecutions.accountId, nodeId: marketplaceStoreNodeExecutions.nodeId,
        certificateGeneration: marketplaceStoreNodeExecutions.certificateGeneration, authorizationGeneration: marketplaceStoreNodeExecutions.authorizationGeneration,
        bindingRevision: marketplaceStoreNodeExecutions.bindingRevision, requestId: marketplaceStoreNodeExecutions.requestId,
        requestChecksum: marketplaceStoreNodeExecutions.requestChecksum, operation: marketplaceStoreNodeExecutions.operation,
        createdBy: marketplaceStoreNodeExecutions.createdBy, membershipId: marketplaceStoreNodeExecutions.membershipId,
        input: marketplaceStoreNodeExecutions.input, authorityCeiling: marketplaceStoreNodeExecutions.authorityCeiling,
        state: marketplaceStoreNodeExecutions.state, phase: marketplaceStoreNodeExecutions.phase, errorCode: marketplaceStoreNodeExecutions.errorCode,
        claimId: marketplaceStoreNodeExecutions.claimId, sessionId: marketplaceStoreNodeExecutions.sessionId,
        credentialUseId: marketplaceStoreNodeExecutions.credentialUseId, credentialId: marketplaceStoreNodeExecutions.credentialId,
        originalCredentialVersion: marketplaceStoreNodeExecutions.originalCredentialVersion, credentialVersion: marketplaceStoreNodeExecutions.credentialVersion,
        checkpointChecksum: marketplaceStoreNodeExecutions.checkpointChecksum, completionChecksum: marketplaceStoreNodeExecutions.completionChecksum,
        snapshotId: marketplaceStoreNodeExecutions.snapshotId, expiresAt: marketplaceStoreNodeExecutions.expiresAt,
        runExpiresAt: marketplaceStoreNodeExecutions.runExpiresAt, leaseExpiresAt: marketplaceStoreNodeExecutions.leaseExpiresAt,
        startedAt: marketplaceStoreNodeExecutions.startedAt, completedAt: marketplaceStoreNodeExecutions.completedAt,
        createdAt: marketplaceStoreNodeExecutions.createdAt, updatedAt: marketplaceStoreNodeExecutions.updatedAt,
      }).from(marketplaceStoreNodeExecutions).where(and(eq(marketplaceStoreNodeExecutions.id, executionId),
        eq(marketplaceStoreNodeExecutions.accountId, pin.accountId), eq(marketplaceStoreNodeExecutions.nodeId, pin.nodeId)));
      if (!execution) fail("diagnostic_execution_not_owned");
      const { input, authorityCeiling, ...executionMetadata } = execution;
      const steps = await tx.select().from(marketplaceStoreNodeExecutionSteps).where(eq(marketplaceStoreNodeExecutionSteps.executionId, execution.id))
        .orderBy(asc(marketplaceStoreNodeExecutionSteps.ordinal), asc(marketplaceStoreNodeExecutionSteps.id));
      const [account] = await tx.select({ id: marketplaceAccounts.id, createdBy: marketplaceAccounts.createdBy, status: marketplaceAccounts.status,
        authorizationGeneration: marketplaceAccounts.authorizationGeneration, credentialStatus: marketplaceAccounts.credentialStatus,
        credentialRefreshState: marketplaceAccounts.credentialRefreshState, credentialUseId: marketplaceAccounts.credentialUseId,
        credentialUseStartedAt: marketplaceAccounts.credentialUseStartedAt, capabilityExpiresAt: marketplaceAccounts.capabilityExpiresAt,
      }).from(marketplaceAccounts).where(eq(marketplaceAccounts.id, pin.accountId));
      const credentials = await tx.select({ id: marketplaceCredentials.id, kind: marketplaceCredentials.kind, version: marketplaceCredentials.version,
        expiresAt: marketplaceCredentials.expiresAt, rotatedAt: marketplaceCredentials.rotatedAt, updatedAt: marketplaceCredentials.updatedAt,
      }).from(marketplaceCredentials).where(eq(marketplaceCredentials.accountId, pin.accountId)).orderBy(asc(marketplaceCredentials.id));
      const snapshots = await tx.select().from(marketplaceCapabilitySnapshots)
        .where(eq(marketplaceCapabilitySnapshots.accountId, pin.accountId)).orderBy(asc(marketplaceCapabilitySnapshots.version));
      const [node] = await tx.select({ id: marketplaceStoreNodes.id, status: marketplaceStoreNodes.status, lastSequence: marketplaceStoreNodes.lastSequence,
        certificateGeneration: marketplaceStoreNodes.certificateGeneration, authorizationGeneration: marketplaceStoreNodes.authorizationGeneration,
        sessionId: marketplaceStoreNodes.sessionId, sessionExpiresAt: marketplaceStoreNodes.sessionExpiresAt, lastSeenAt: marketplaceStoreNodes.lastSeenAt,
      }).from(marketplaceStoreNodes).where(eq(marketplaceStoreNodes.id, pin.nodeId));
      const [binding] = await tx.select({ id: marketplaceStoreNodeBindings.id, revision: marketplaceStoreNodeBindings.revision,
        state: marketplaceStoreNodeBindings.state, nodeId: marketplaceStoreNodeBindings.nodeId, leaseExpiresAt: marketplaceStoreNodeBindings.leaseExpiresAt,
      }).from(marketplaceStoreNodeBindings).where(eq(marketplaceStoreNodeBindings.accountId, pin.accountId));
      return {
        algorithm: "fixture-canonical-json-sha256-v1" as const,
        request: { id: request.id, accountId: request.accountId, listingId: request.listingId, listingVersionId: request.listingVersionId,
          capabilitySnapshotId: request.capabilitySnapshotId, platform: request.platform, marketplaceId: request.marketplaceId, action: request.action,
          createdBy: request.createdBy, idempotencyKey: request.idempotencyKey, payloadChecksum: request.payloadChecksum,
          scheduledFor: iso(request.scheduledFor), createdAt: iso(request.createdAt), sha256: checksum(request) },
        intent: { id: intent.id, requestId: intent.requestId, createdBy: intent.createdBy, membershipId: intent.membershipId,
          route: intent.route, authorizationGeneration: intent.authorizationGeneration, requestKey: intent.requestKey,
          requestChecksum: intent.requestChecksum, nodeExecutionId: intent.nodeExecutionId,
          authorityCeilingChecksum: checksum(intent.authorityCeiling), targetChecksum: checksum(intent.target),
          createdAt: iso(intent.createdAt), sha256: checksum(intent) },
        events: events.map(row => ({ id: row.id, sequence: row.sequence, status: row.status, code: safeCode(row.code),
          retryable: row.retryable, actorUserId: row.actorUserId, occurredAt: iso(row.occurredAt), sha256: checksum(row) })),
        execution: { ...executionMetadata, errorCode: safeCode(execution.errorCode), inputChecksum: checksum(input), authorityCeilingChecksum: checksum(authorityCeiling) },
        steps, account: account ?? null, credentials, snapshots: snapshots.map(row => ({ id: row.id, version: row.version,
          authorizationGeneration: row.authorizationGeneration, sourceChecksum: row.sourceChecksum, syncedAt: iso(row.syncedAt),
          expiresAt: iso(row.expiresAt), sha256: checksum(row) })), capabilityCount: snapshots.length, node: node ?? null, binding: binding ?? null,
      };
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
  }

  function close(): Promise<void> {
    closePromise ??= (async () => {
      if (closed) return; closing = true;
      const failures: Error[] = [];
      for (const release of releases) release();
      try { await original.stopChildren(); } catch { failures.push(new Error("publication_authority_fixture_child_cleanup_failed")); }
      for (const restore of [...restorers].reverse()) try { await restore(); }
        catch { failures.push(new Error("publication_authority_fixture_restore_failed")); }
      try { await original.close(); } catch { failures.push(new Error("publication_authority_fixture_original_cleanup_failed")); }
      closed = true;
      if (failures.length) throw new AggregateError(failures, "publication_authority_fixture_cleanup_failed");
    })();
    return closePromise;
  }
  return { original, isolated, initialize, current, authority, scene, setPermissionScopes, moveOwner, arm, head, diagnostics, close };
}
