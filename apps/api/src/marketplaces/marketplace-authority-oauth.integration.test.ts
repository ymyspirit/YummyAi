import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectDatabase, migrateDatabase } from "@yummyai/database";
import { requireMarketplaceAuthorityEnvironment } from "../../../../tools/testing/require-marketplace-authority-environment.mjs";
import { marketplaceAuthorityFixture } from "./marketplace-authority.test-fixture.js";

requireMarketplaceAuthorityEnvironment();
const digest = (url: string) => createHash("sha256").update(new URL(url).searchParams.get("state")!).digest("base64url");
describe.sequential("OAuth URL and original session proof", () => {
  const database = connectDatabase(), f = marketplaceAuthorityFixture(database);
  beforeAll(async () => { await migrateDatabase(database); await f.initialize(); });
  afterAll(async () => { try { await f.close(); } finally { await database.client.end(); } });

  it("binds the pending proof to its actor and rejects a URL superseded by another actor", async () => {
    const account = await f.create(), a = await f.current(), b = await f.current(f.peer);
    const first = await f.authorization.startOAuth(a, account.id);
    expect((await f.workspace.get(a, account.id)).lifecycle.pendingOAuthStateDigest).toBe(digest(first.authorizationUrl));
    expect((await f.workspace.get(b, account.id)).lifecycle.pendingOAuthStateDigest).toBeNull();
    const second = await f.authorization.startOAuth(b, account.id);
    expect((await f.workspace.get(a, account.id)).lifecycle.pendingOAuthStateDigest).toBeNull();
    expect((await f.workspace.get(b, account.id)).lifecycle.pendingOAuthStateDigest).toBe(digest(second.authorizationUrl));
    await expect(f.authorization.completeOAuth(a, account.id, f.provider.code(first.authorizationUrl))).rejects.toMatchObject({ status: 400 });
    expect(f.provider.counts.oauth).toBe(0);
  });

  it("does not attach a late same-actor URL to a newer generation or keep proof after revoke", async () => {
    const account = await f.create(), context = await f.current();
    const first = await f.authorization.startOAuth(context, account.id), firstView = await f.workspace.get(context, account.id);
    const second = await f.authorization.startOAuth(context, account.id), secondView = await f.workspace.get(context, account.id);
    expect(secondView.lifecycle.authorizationGeneration).not.toBe(firstView.lifecycle.authorizationGeneration);
    expect(secondView.lifecycle.pendingOAuthStateDigest).not.toBe(digest(first.authorizationUrl));
    expect(secondView.lifecycle.pendingOAuthStateDigest).toBe(digest(second.authorizationUrl));
    await f.authorization.revoke(context, account.id);
    const revoked = await f.workspace.get(context, account.id);
    expect(revoked.lifecycle.pendingOAuthStateDigest).toBeNull();
    expect(revoked.account.status).toBe("revoked");
    await expect(f.authorization.completeOAuth(context, account.id, f.provider.code(second.authorizationUrl))).rejects.toMatchObject({ status: 400 });
    expect(f.provider.counts.oauth).toBe(0);
  });
});
