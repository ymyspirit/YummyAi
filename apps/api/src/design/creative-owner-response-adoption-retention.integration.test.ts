import { creativeExecutions, withTenant } from "@yummyai/database";
import { inArray, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { requireCreativeOwnerResponseAdoptionEnvironment } from "../../../../tools/testing/creative-owner-response-adoption-environment.mjs";
import { createCreativeOwnerResponseAdoptionFixture, ownerFixtureSha } from "./creative-owner-response-adoption.test-fixture.js";

requireCreativeOwnerResponseAdoptionEnvironment();
type Fixture = Awaited<ReturnType<typeof createCreativeOwnerResponseAdoptionFixture>>;
describe("immutable owner adoption after actual private archive retention", () => {
  let f: Fixture;
  beforeEach(async () => { f = await createCreativeOwnerResponseAdoptionFixture(); });
  afterEach(async () => { if (f) await f.close(); });
  it("preserves an adopted native template and explicit reviewer handoff after real short-history expiry and purge", async () => {
    const kept = await f.shortLivedTemplateHistory(), uncommitted = await f.shortLivedTemplateHistory(), actor = await f.current();
    const command = await f.command(kept), staleCommand = await f.command(uncommitted), original = await f.original(kept);
    const adopted = await f.adopt(kept, command), before = await f.facts(kept);
    expect(adopted.status).toBe("committed"); expect(before.assets.every(row => row.rightsStatus === "unverified")).toBe(true);
    const deadline = performance.now() + 20_000;
    for (;;) {
      const expired = await withTenant(f.database.db, actor, tx => tx.select({ id: creativeExecutions.id,
        expired: sql<boolean>`${creativeExecutions.responseExpiresAt}<=clock_timestamp()` }).from(creativeExecutions)
        .where(inArray(creativeExecutions.id, [kept.executionId, uncommitted.executionId])));
      if (expired.length === 2 && expired.every(row => row.expired)) break;
      if (performance.now() > deadline) throw new Error("owner_fixture_short_history_did_not_expire");
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    await f.recovery.purgeExpired(actor, ["template_compile"]);
    const after = await f.original(kept), beforeExecution = original.executions[0]!, afterExecution = after.executions[0]!;
    expect(afterExecution.responsePurgedAt).toBeInstanceOf(Date);
    expect({ ...afterExecution, updatedAt: null, responsePurgedAt: null }).toEqual({ ...beforeExecution, updatedAt: null, responsePurgedAt: null });
    expect(after.ledger).toEqual(original.ledger); expect(after.calls).toEqual(original.calls);
    expect((await f.execution(uncommitted.operation)).responsePurgedAt).toBeInstanceOf(Date);
    expect(await f.service(kept).lookup(actor, kept.executionId, command.requestId)).toEqual(adopted);
    const workspace = await f.service(kept).workspace(actor, kept.executionId);
    expect(workspace.source.archiveState).toBe("purged"); expect(workspace.canInspectOriginal).toBe(false); expect(workspace.requests[0]?.receipt).toEqual(adopted.receipt);
    expect((await f.service(uncommitted).workspace(actor, uncommitted.executionId)).canAdopt).toBe(false);
    await expect(f.adopt(uncommitted, staleCommand)).rejects.toThrow();
    await expect(f.service(kept).preview(actor, kept.executionId, command.expectedBasis)).rejects.toThrow();
    for (const file of before.assets) {
      const bytes = await f.storage.readPrivate(actor, { ...file, assetDomain: "authorized" }, { requiredDomain: "authorized" });
      expect(ownerFixtureSha(bytes)).toBe(file.checksumSha256);
    }
    const peer = await f.paid.actor(actor.tenantId, "tenant"), reviewer = await f.paid.grant(peer.context, f.permissions, "tenant");
    const inspection = await f.mockups.getInspection(reviewer, kept.inspectionId!);
    await f.mockups.confirmInspection(reviewer, kept.inspectionId!, inspection.reviewFingerprint);
    const reviewed = await f.facts(kept);
    expect(reviewed.inspections[0]?.confirmedBy).toBe(peer.userId); expect(reviewed.assets.every(row => row.rightsStatus === "approved")).toBe(true);
    expect(reviewed.adoptions[0]?.receipt).toEqual(adopted.receipt);
    expect((await f.original(kept)).ledger).toEqual(original.ledger);
  });
});
