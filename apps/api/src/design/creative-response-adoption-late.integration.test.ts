import { randomUUID } from "node:crypto";
import { CreativeResponseAdoptionCommandSchema } from "@yummyai/contracts/harness/creative-response-adoption";
import type { Storage } from "@yummyai/storage";
import { afterEach, describe, expect, it } from "vitest";
import { requireCreativeResponseAdoptionEnvironment } from "../../../../tools/testing/creative-response-adoption-environment.mjs";
import { createCreativeResponseAdoptionFixture } from "./creative-response-adoption.test-fixture.js";

requireCreativeResponseAdoptionEnvironment();
type Fixture = Awaited<ReturnType<typeof createCreativeResponseAdoptionFixture>>;
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

/** A deliberately expired clock pin is fault injection in this exact disposable
 * database. The owner transaction disables only the named state-transition
 * trigger, preserves every other constraint and re-enables it before commit.
 * All business observations and service calls still use yummyai_app + RLS. */
async function expireHeldLease(fixture: Fixture, pin: { id: string; requestId: string; leaseToken: string | null }) {
  const isolated = requireCreativeResponseAdoptionEnvironment();
  if (isolated.nonce !== fixture.isolated.nonce || isolated.name !== fixture.isolated.name || !pin.leaseToken)
    throw new Error("adoption_late_fixture_identity_invalid");
  await fixture.database.client.begin(async owner => {
    const [database] = await owner.unsafe("select current_database() as name");
    if (database?.name !== isolated.name) throw new Error("adoption_late_fixture_database_changed");
    const triggerQuery = "select tgenabled as enabled from pg_trigger where tgrelid='public.creative_response_adoptions'::regclass and tgname='creative_response_adoption_guard' and not tgisinternal";
    const [before] = await owner.unsafe(triggerQuery);
    if (before?.enabled !== "O") throw new Error("adoption_late_fixture_trigger_not_enabled");
    await owner.unsafe("alter table public.creative_response_adoptions disable trigger creative_response_adoption_guard");
    let primary: unknown;
    try {
      const changed = await owner.unsafe(`update public.creative_response_adoptions set lease_expires_at=clock_timestamp()-interval '1 second'
        where tenant_id=$1::uuid and requested_by=$2::uuid and id=$3::uuid and request_id=$4::uuid
        and lease_token=$5::uuid and status='processing' and lease_expires_at>clock_timestamp() returning id`,
      [fixture.identity.tenantId, fixture.identity.userId, pin.id, pin.requestId, pin.leaseToken]);
      if (changed.length !== 1 || changed[0]?.id !== pin.id) throw new Error("adoption_late_fixture_exact_lease_missing");
    } catch (cause) { primary = cause; }
    try { await owner.unsafe("alter table public.creative_response_adoptions enable trigger creative_response_adoption_guard"); }
    catch (cleanup) { throw new AggregateError(primary ? [primary, cleanup] : [cleanup], "adoption_late_fixture_trigger_restore_failed"); }
    if (primary) throw primary;
    const [after] = await owner.unsafe(triggerQuery);
    if (after?.enabled !== "O") throw new Error("adoption_late_fixture_trigger_restore_not_verified");
  });
}

describe("original response adoption with a provably live uploader after lease expiry", () => {
  let fixture: Fixture | undefined;
  afterEach(async () => { if (fixture) await fixture.close(); });

  it("does not reclaim or cancel an expired processing lease while its actual PUT is still in flight", async () => {
    const f = fixture = await createCreativeResponseAdoptionFixture();
    const seed = await f.seed(), context = await f.current(), before = await f.facts(seed), archive = await f.archive(seed);
    const workspace = await f.adoption.workspace(context, seed.executionId);
    const request = CreativeResponseAdoptionCommandSchema.parse({ requestId: randomUUID(), expectedBasis: workspace.basis, acknowledgeReviewRequired: true });
    const entered = deferred(), release = deferred(), effects = { reads: 0, puts: 0 }; let held = false;
    const heldStorage = new Proxy(f.storage, { get(target, key) {
      if (key === "putPrivate") return async (...args: Parameters<Storage["putPrivate"]>) => {
        effects.puts++;
        // The original remote write has not happened yet. Releasing this exact
        // pending caller will really create the object after the lease expiry.
        if (!held) { held = true; entered.resolve(); await release.promise; }
        return target.putPrivate(...args);
      };
      if (key === "readPrivate") return async (...args: Parameters<Storage["readPrivate"]>) => { effects.reads++; return target.readPrivate(...args); };
      const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
    } });
    const owner = f.service(heldStorage);
    const first = owner.adopt(context, seed.executionId, request).then(value => ({ value, error: undefined }), error => ({ value: undefined, error: error as unknown }));
    try {
      await entered.promise;
      const processing = await f.facts(seed), pin = processing.adoptions[0];
      expect(processing.role).toBe("yummyai_app"); expect(pin).toMatchObject({ status: "processing", attemptCount: 1, requestId: request.requestId });
      if (!pin) throw new Error("adoption_late_fixture_processing_missing");
      await expireHeldLease(f, pin);
      const observedEffects = { ...effects };
      expect(await f.adoption.lookup(context, seed.executionId, request.requestId))
        .toMatchObject({ id: pin.id, command: request, status: "processing", leaseActive: false, canRetry: false, canCancel: false, attempts: 1 });
      await expect(owner.adopt(context, seed.executionId, request)).rejects.toMatchObject({ status: 409, code: "CREATIVE_ADOPTION_LEASE_LOST" });
      await expect(f.adoption.cancel(context, seed.executionId, pin.id, { requestId: request.requestId }))
        .rejects.toMatchObject({ status: 409, code: "CREATIVE_ADOPTION_BLOCKED" });
      expect(effects).toEqual(observedEffects); expect(effects.puts).toBe(1);
      release.resolve();
      expect((await first).error).toMatchObject({ status: 409, code: "CREATIVE_ADOPTION_LEASE_LOST" });
      const released = await f.adoption.lookup(context, seed.executionId, request.requestId);
      expect(released).toMatchObject({ id: pin.id, command: request, status: "prepared", attempts: 1, leaseActive: false,
        canRetry: true, canCancel: true, receipt: null, errorCode: "CREATIVE_ADOPTION_LEASE_LOST" });
      const failed = await f.facts(seed);
      expect(failed.execution).toEqual(before.execution); expect(failed.budget).toEqual(before.budget);
      expect(failed.assets).toEqual(before.assets); expect(failed.candidates).toEqual(before.candidates); expect(await f.archive(seed)).toEqual(archive);
      const adopted = await owner.adopt(context, seed.executionId, request);
      expect(adopted).toMatchObject({ id: pin.id, command: request, status: "committed", attempts: 2 });
      const final = await f.facts(seed);
      expect(final.adoptions).toHaveLength(1); expect(final.execution).toEqual(before.execution); expect(final.budget).toEqual(before.budget);
      expect(final.counts.originalDispatches).toBe(before.counts.originalDispatches); expect(final.counts.forbiddenDispatches).toBe(0);
      expect(final.candidates).toHaveLength(1); expect(final.candidates[0]).toMatchObject({ id: seed.candidateId, status: "generated" });
    } finally { release.resolve(); await first; }
  });
});
