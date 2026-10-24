import { createServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectDatabase, migrateDatabase, marketplaceCredentials, withTenant } from "@yummyai/database";
import { SyncMarketplaceCapabilitiesInputSchema, type TenantContext } from "@yummyai/contracts";
import { HttpMarketplaceCapabilityGateway, MarketplaceConnectorError } from "@yummyai/marketplace-connectors";
import { eq } from "drizzle-orm";
import { createStorageFromEnvironment } from "@yummyai/storage";
import { requireMarketplaceAuthorityEnvironment } from "../../../../tools/testing/require-marketplace-authority-environment.mjs";
import { DrizzlePublicationExecutionRepository } from "../../../worker/src/processors/marketplace-publication.processor.js";
import { DrizzleListingSyncExecutionRepository } from "../../../worker/src/processors/marketplace-listing-sync.processor.js";
import { DrizzlePublicationBatchExecutionRepository } from "../../../worker/src/processors/marketplace-publication-batch.processor.js";
import { DrizzleShipmentWritebackExecutionRepository } from "../../../worker/src/processors/shipment-writeback.processor.js";
import { DrizzleChannelMutationReconciliationWriter } from "../../../worker/src/processors/channel-inventory-reconciliation.repository.js";
import { readMarketplaceCredentialFailureFence, revokeMarketplaceCredentialIfCurrent } from "../../../worker/src/processors/marketplace-credential-failure.js";
import { marketplaceAuthorityFixture } from "./marketplace-authority.test-fixture.js";
import { MarketplaceCapabilityService } from "./marketplace-capability.service.js";
import { AuditService } from "../audit/audit.service.js";

requireMarketplaceAuthorityEnvironment();
describe.sequential("original Worker credential boundaries", () => {
  const database = connectDatabase(), f = marketplaceAuthorityFixture(database);
  let amazonOrigin: string;
  const provider = createServer((request, response) => {
    const valid = request.method === "GET" && request.url === "/sellers/v1/marketplaceParticipations" &&
      typeof request.headers["x-amz-access-token"] === "string";
    response.writeHead(valid ? 200 : 401, { "content-type": "application/json" });
    response.end(JSON.stringify(valid ? { payload: [{ marketplace: { id: "ATVPDKIKX0DER" },
      participation: { isParticipating: true, hasSuspendedListings: false } }] } : { error: "synthetic-provider-denied" }));
  });
  const repositories = [new DrizzlePublicationExecutionRepository(database, f.vault, createStorageFromEnvironment()),
    new DrizzleListingSyncExecutionRepository(database, f.vault, new DrizzleChannelMutationReconciliationWriter()),
    new DrizzlePublicationBatchExecutionRepository(database, f.vault), new DrizzleShipmentWritebackExecutionRepository(database, f.vault)];
  beforeAll(async () => { await migrateDatabase(database); await f.initialize();
    await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
    const address = provider.address(); if (!address || typeof address === "string") throw new Error("Synthetic Amazon origin missing");
    amazonOrigin = "http://127.0.0.1:" + address.port;
  });
  afterAll(async () => { try { await f.close(); } finally {
    try { provider.closeAllConnections(); await new Promise<void>((resolve, reject) => provider.close(error => error ? reject(error) : resolve())); }
    finally { await database.client.end(); }
  } });
  async function amazon() {
    const account = await f.create("amazon"), context = await f.current(), credential = f.privateInput();
    await f.authorization.authorizeAmazonPrivate(context, account.id, credential);
    await activateAmazon(context, account.id);
    return { account, context, credential };
  }
  async function activateAmazon(context: TenantContext, accountId: string) {
    const request: typeof fetch = (raw, init) => {
      const url = new URL(raw instanceof Request ? raw.url : String(raw));
      return url.origin === "https://sellingpartnerapi-na.amazon.com"
        ? fetch(amazonOrigin + url.pathname + url.search, init) : f.provider.request(raw, init);
    };
    await new MarketplaceCapabilityService(database, f.vault, new HttpMarketplaceCapabilityGateway(request), f.authorization, new AuditService(database))
      .sync(context, accountId, SyncMarketplaceCapabilitiesInputSchema.parse({}));
  }
  async function rejectedCredential(repository: typeof repositories[number], context: TenantContext, accountId: string) {
    const error = await repository.withCredential(context, accountId, async () => {
      throw new MarketplaceConnectorError("amazon", "authorization", "Synthetic upstream rejected the originally captured credential");
    }).then(() => { throw new Error("Expected original provider failure"); }, error => error);
    const fence = readMarketplaceCredentialFailureFence(error); expect(fence).toBeDefined(); return fence!;
  }

  it("rejects all four unadapted Etsy execution paths without releasing a secret or retrying", async () => {
    const account = await f.create("etsy"); await f.oauth(account.id); await f.sync(account.id);
    const context = await f.current(); let secretCallbacks = 0;
    for (const repository of repositories)
      await expect(repository.withCredential(context, account.id, async () => { secretCallbacks++; }))
        .rejects.toMatchObject({ platform: "etsy", code: "validation", retryable: false });
    expect(secretCallbacks).toBe(0);
    expect((await f.rows(account.id)).accounts[0]?.status).toBe("active");
  });

  it("uses the original Amazon credential only while idle and rejects a central lease or unknown refresh", async () => {
    const { account, context, credential } = await amazon();
    for (const repository of repositories)
      await expect(repository.withCredential(context, account.id, async value => value.refreshToken)).resolves.toBe(credential.refreshToken);
    const lease = await f.authorization.claimCredentialUse(context, account.id); let secretCallbacks = 0;
    try {
      for (const repository of repositories)
        await expect(repository.withCredential(context, account.id, async () => { secretCallbacks++; }))
          .rejects.toMatchObject({ code: "conflict", retryable: false });
      await lease.beforeCredentialRefresh();
    } finally { await lease.release(); }
    for (const repository of repositories)
      await expect(repository.withCredential(context, account.id, async () => { secretCallbacks++; }))
        .rejects.toMatchObject({ code: "conflict", retryable: false });
    expect(secretCallbacks).toBe(0);
  });

  it("never lets a late upstream authorization failure revoke a replacement grant", async () => {
    const { account, context, credential } = await amazon();
    const fences = await Promise.all(repositories.map(repository => rejectedCredential(repository, context, account.id)));
    await f.authorization.authorizeAmazonPrivate(context, account.id, { ...credential, refreshToken: "SYNTHETIC-REPLACEMENT-REFRESH" });
    await activateAmazon(context, account.id);
    for (const fence of fences) await expect(withTenant(database.db, context, tx =>
      revokeMarketplaceCredentialIfCurrent(tx, context, account.id, fence, "SYNTHETIC_AUTHORIZATION"))).resolves.toBe(false);
    expect((await f.rows(account.id)).accounts[0]?.status).toBe("active");
    expect((await f.workspace.get(context, account.id)).lifecycle.capabilityCurrent).toBe(true);
  });

  it("requires the original credential version and an idle current generation before an audited provider revoke", async () => {
    const { account, context } = await amazon();
    const oldFence = await rejectedCredential(repositories[0]!, context, account.id);
    const revoke = (who: TenantContext, fence: typeof oldFence | undefined) => withTenant(database.db, who,
      tx => revokeMarketplaceCredentialIfCurrent(tx, who, account.id, fence, "SYNTHETIC_AUTHORIZATION"));
    await expect(revoke(context, undefined)).resolves.toBe(false);
    const lease = await f.authorization.claimCredentialUse(context, account.id);
    try { await expect(revoke(context, oldFence)).resolves.toBe(false); } finally { await lease.release(); }
    // Explicit competing-version fixture: never rewrite the original captured fence.
    await withTenant(database.db, context, tx => tx.update(marketplaceCredentials).set({ version: oldFence.credentialVersion + 1 })
      .where(eq(marketplaceCredentials.id, oldFence.credentialId)));
    await expect(revoke(context, oldFence)).resolves.toBe(false);
    const currentFence = await rejectedCredential(repositories[0]!, context, account.id);
    await expect(revoke(await f.current(f.foreign), currentFence)).resolves.toBe(false);
    await expect(revoke(context, currentFence)).resolves.toBe(true);
    const rows = await f.rows(account.id);
    expect(rows.accounts[0]).toMatchObject({ status: "revoked", credentialStatus: "revoked", capabilities: [] });
    expect(rows.accounts[0]?.authorizationGeneration).not.toBe(currentFence.authorizationGeneration);
    expect(rows.audits.filter(row => row.action === "marketplace_authorization.provider_revoke")).toHaveLength(1);
  });
});
