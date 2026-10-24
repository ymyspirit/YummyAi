import { createHash } from "node:crypto";
import { beforeAll, afterAll, afterEach, describe, expect, it } from "vitest";
import { Permission, erpPermissionContext } from "@yummyai/authz";
import { SyncMarketplaceCapabilitiesInputSchema } from "@yummyai/contracts";
import { erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { MarketplaceAuthorityWorkspaceSchema } from "@yummyai/contracts/marketplace/authority";
import { connectDatabase, migrateDatabase } from "@yummyai/database";
import { HttpMarketplaceCapabilityGateway } from "@yummyai/marketplace-connectors";
import { requireMarketplaceAuthorityEnvironment } from "../../../../tools/testing/require-marketplace-authority-environment.mjs";
import { marketplaceAuthorityFixture, marketplaceAuthorityPermissions } from "./marketplace-authority.test-fixture.js";
import { MarketplaceCapabilityService } from "./marketplace-capability.service.js";
import { AuditService } from "../audit/audit.service.js";

requireMarketplaceAuthorityEnvironment();
function outcome<T>(pending: Promise<T>) { return pending.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error })); }
describe.sequential("current marketplace authority lifecycle", () => {
  const database = connectDatabase(), f = marketplaceAuthorityFixture(database);
  beforeAll(async () => { await migrateDatabase(database); await f.initialize(); });
  afterEach(async () => { f.provider.controls.rotate = false; f.provider.controls.failRead = false; f.provider.controls.loseRefresh = false;
    for (const actor of [f.a, f.peer, f.foreign]) await f.rights(actor); });
  afterAll(async () => { const errors: unknown[] = []; for (const done of [() => f.close(), () => database.client.end()]) try { await done(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, "Authority integration cleanup failed"); });

  it("never resurrects an OAuth or private grant whose real owner revoke commits before the provider responds", async () => {
    for (const kind of ["oauth", "private"] as const) {
      const account = await f.create(kind === "oauth" ? "etsy" : "amazon"), context = await f.current();
      const input = kind === "oauth" ? f.provider.code((await f.authorization.startOAuth(context, account.id)).authorizationUrl) : null;
      const gate = f.provider.arm(kind), pending = outcome(kind === "oauth" ? f.authorization.completeOAuth(context, account.id, input!) : f.authorization.authorizeAmazonPrivate(context, account.id, f.privateInput()));
      try {
        await f.gateEntered(gate, pending); await f.authorization.revoke(await f.current(), account.id);
        const afterRevoke = await f.rows(account.id); expect(afterRevoke.credentials).toHaveLength(0); expect(afterRevoke.accounts[0]?.status).toBe("revoked");
        gate.release.resolve(); expect((await pending).ok).toBe(false);
        const actual = await f.rows(account.id); expect(actual.credentials).toHaveLength(0); expect(actual.accounts[0]?.status).toBe("revoked");
        expect(actual.accounts[0]?.authorizationGeneration).toBe(afterRevoke.accounts[0]?.authorizationGeneration);
        const calls = { ...f.provider.counts }; await f.accounts.get(await f.current(), account.id); await f.workspace.get(await f.current(), account.id); expect(f.provider.counts).toEqual(calls);
      } finally { gate.release.resolve(); await pending; }
    }
  });
  it("never adopts normal capabilities after revoke or rotated capabilities after explicit disable", async () => {
    for (const rotated of [false, true]) {
      const account = await f.create(); await f.oauth(account.id); f.provider.controls.rotate = rotated;
      const gate = f.provider.arm("read"), pending = outcome(f.sync(account.id));
      try {
        await f.gateEntered(gate, pending);
        if (rotated) await f.accounts.update(await f.current(), account.id, { enabled: false }); else await f.authorization.revoke(await f.current(), account.id);
        const fixed = await f.rows(account.id); gate.release.resolve(); expect((await pending).ok).toBe(false);
        const actual = await f.rows(account.id); expect(actual.accounts[0]?.status).toBe(rotated ? "disabled" : "revoked");
        expect(actual.capabilities.length).toBe(fixed.capabilities.length); expect(actual.credentials).toEqual(fixed.credentials);
      } finally { gate.release.resolve(); await pending; f.provider.controls.rotate = false; }
    }
  });
  it("rechecks the actual member and individual scope before adopting a late grant", async () => {
    const account = await f.create(), context = await f.current(), input = f.provider.code((await f.authorization.startOAuth(context, account.id)).authorizationUrl);
    const gate = f.provider.arm("oauth"), pending = outcome(f.authorization.completeOAuth(context, account.id, input));
    try { await f.gateEntered(gate, pending); await f.rights(f.a, [Permission.StoreRead, Permission.StoreManage]); gate.release.resolve(); expect((await pending).ok).toBe(false);
      expect((await f.rows(account.id)).credentials).toHaveLength(0);
    } finally { gate.release.resolve(); await pending; await f.rights(f.a); }
    await f.rights(f.peer, marketplaceAuthorityPermissions, "self");
    await expect(f.workspace.get(await f.current(f.peer), account.id)).rejects.toMatchObject({ name: "ForbiddenError" });
  });
  it("serializes real refresh across distinct service instances before either can reuse the old token", async () => {
    const account = await f.create(); await f.oauth(account.id); f.provider.controls.rotate = true;
    const before = { ...f.provider.counts }, gate = f.provider.arm("refresh"), pending = outcome(f.sync(account.id));
    try {
      await f.gateEntered(gate, pending);
      const independent = new MarketplaceCapabilityService(database, f.vault, new HttpMarketplaceCapabilityGateway(f.provider.request), f.authorization, new AuditService(database));
      await expect(independent.sync(await f.current(), account.id, SyncMarketplaceCapabilitiesInputSchema.parse({}))).rejects.toMatchObject({ response: { code: "marketplace_credential_refresh_unknown" } });
      expect(f.provider.counts.refresh - before.refresh).toBe(1);
      const workspace = await f.workspace.get(await f.current(), account.id); expect(workspace.lifecycle.refreshState).toBe("pending"); expect(workspace.access.sync).toBe(false);
      gate.release.resolve(); expect((await pending).ok).toBe(true);
      const after = await f.rows(account.id); expect(after.credentials[0]?.version).toBe(2); expect(after.accounts[0]?.credentialUseId === null).toBe(true);
      expect(after.capabilities).toHaveLength(1); expect(f.provider.counts.rejected).toBe(0);
    } finally { gate.release.resolve(); await pending; }
  });
  it("checkpoints the rotated credential before a later owner GET fails and uses that credential on recovery", async () => {
    const account = await f.create(); await f.oauth(account.id); f.provider.controls.rotate = true; f.provider.controls.failRead = true;
    const before = await f.rows(account.id); await expect(f.sync(account.id)).rejects.toBeDefined();
    const failed = await f.rows(account.id); expect(failed.credentials[0]?.version).toBe(2); expect(failed.accounts[0]?.credentialRefreshState).toBe("known");
    expect(failed.accounts[0]?.credentialUseId === null).toBe(true); expect(failed.capabilities).toHaveLength(0);
    expect(failed.credentials[0]?.encryptedEnvelope === before.credentials[0]?.encryptedEnvelope).toBe(false);
    f.provider.controls.failRead = false; await f.sync(account.id);
    expect((await f.rows(account.id)).credentials[0]?.version).toBe(3); expect(f.provider.counts.rejected).toBe(0);
  });
  it("keeps an unknown submitted refresh blocked across new instances and recovers only through explicit reauthorization", async () => {
    const account = await f.create(); await f.oauth(account.id); const before = await f.workspace.get(await f.current(), account.id);
    f.provider.controls.rotate = true; f.provider.controls.loseRefresh = true; await expect(f.sync(account.id)).rejects.toBeDefined();
    const unknown = await f.workspace.get(await f.current(), account.id); expect(unknown.lifecycle.refreshState).toBe("unknown"); expect(unknown.access.sync).toBe(false);
    const calls = { ...f.provider.counts }, fixed = await f.rows(account.id);
    await expect(f.sync(account.id)).rejects.toMatchObject({ response: { code: "marketplace_credential_refresh_unknown" } });
    await f.workspace.get(await f.current(), account.id); expect(f.provider.counts).toEqual(calls); expect(await f.rows(account.id)).toEqual(fixed);
    f.provider.controls.loseRefresh = false; await f.oauth(account.id);
    const renewed = await f.workspace.get(await f.current(), account.id); expect(renewed.lifecycle.authorizationGeneration === before.lifecycle.authorizationGeneration).toBe(false);
    expect(renewed.lifecycle.refreshState).toBe("known"); await f.sync(account.id);
  });
  it("keeps a genuinely crashed pending refresh non-reusable without relying on a process-local lock", async () => {
    const account = await f.create(); await f.oauth(account.id); f.provider.controls.rotate = true;
    const gate = f.provider.arm("refresh"), child = await f.crashableRefresh(account.id);
    try {
      await f.gateEntered(gate, child.result); expect((await f.rows(account.id)).accounts[0]?.credentialRefreshState).toBe("pending");
      await child.kill(); expect(child.evidence).toMatchObject({ exited: true, killed: true }); const calls = { ...f.provider.counts };
      await expect(f.sync(account.id)).rejects.toMatchObject({ response: { code: "marketplace_credential_refresh_unknown" } });
      const view = await f.workspace.get(await f.current(), account.id); expect(view.lifecycle.refreshState).toBe("pending"); expect(view.access.sync).toBe(false); expect(f.provider.counts).toEqual(calls);
    } finally { gate.release.resolve(); await child.close(); }
    await f.oauth(account.id); expect((await f.workspace.get(await f.current(), account.id)).lifecycle.refreshState).toBe("known");
  });
  it("returns one safe current authority DTO without network or mutation and isolates the foreign tenant", async () => {
    const account = await f.create(); await f.oauth(account.id); await f.sync(account.id);
    const before = await f.rows(account.id), calls = { ...f.provider.counts }, context = await f.current();
    const view = MarketplaceAuthorityWorkspaceSchema.parse(await f.workspace.get(context, account.id));
    expect(view.context).toEqual({ actorId: context.userId, tenantId: context.tenantId, authority: createHash("sha256").update(erpSessionAuthority(erpPermissionContext(context))).digest("hex") });
    expect(view.lifecycle.capabilityCurrent).toBe(true); expect(view.lifecycle.capabilityGeneration).toBe(view.lifecycle.authorizationGeneration);
    expect(/SYNTHETIC-AUTHORITY-CLIENT-SECRET|refreshToken|encryptedEnvelope|stateDigest|PkceVerifier/.test(JSON.stringify(view))).toBe(false);
    expect(await f.rows(account.id)).toEqual(before); expect(f.provider.counts).toEqual(calls);
    await expect(f.workspace.get(await f.current(f.foreign), account.id)).rejects.toMatchObject({ status: 404 });
    expect((await f.rows(account.id, f.foreign)).accounts).toEqual([]);
  });
});
