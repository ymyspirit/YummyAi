import { beforeAll, afterAll, afterEach, describe, expect, it } from "vitest";
import { Permission } from "@yummyai/authz";
import { requireAgentNativeV4Environment } from "../../../../tools/testing/require-agent-native-v4-environment.mjs";

const environment = requireAgentNativeV4Environment();
const { connectDatabase, withTenant, orderFulfillmentCommandIntents } = await import("@yummyai/database");
const { eq } = await import("drizzle-orm");
const { agentNativeV4Fixture } = await import("./agent-native-v4.test-fixture.js");
const { nativeV3Scopes } = await import("./agent-native-v3.test-fixture.js");
const { AGENT_NATIVE_V4_VERSION: version, AgentNativeV4ViewSchema } = await import("@yummyai/contracts/ai/agent-native-v4");
const { AGENT_FULFILLMENT_COMMAND_VERSION: originalVersion } = await import("@yummyai/contracts/ai/agent-fulfillment-command");
const database = connectDatabase(environment.url), f = agentNativeV4Fixture(database);

describe.sequential("native v4 original final business fence after claim", () => {
  beforeAll(async () => { await f.initialize(); }, 240_000);
  afterEach(async () => { await f.settle(); });
  afterAll(async () => {
    const failures: unknown[] = [];
    try { await f.close(); } catch (error) { failures.push(error); }
    try { await database.client.end(); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, "native4_late_disposable_teardown_failed");
  });

  it.each(["stop", "ttl", "workflow", "pii", "membership"] as const)(
    "late_%s_after_original_claim_blocks_the_actual_owner_write_without_a_second_execution",
    async change => {
      const context = await f.current(), scenario = await f.scenario("delivery_feedback"), input = await f.request(scenario);
      const service = f.service(change === "ttl" ? 31 : undefined);
      if (change === "ttl") input.limits.deadlineSeconds = 30;
      const created = await service.start(context, input);
      await f.process(created.id);
      const view = AgentNativeV4ViewSchema.parse(await service.get(context, created.id)), item = view.items[0];
      expect(view.status).toBe("completed");
      if (!item) throw new Error("native4_late_original_proposal_missing");
      const receipt = await service.prepareItem(context, view.id, item.id, f.prepareInput(view, item, scenario));
      if (!receipt.fulfillmentIntentId) throw new Error("native4_late_original_intent_missing");
      const intentId = receipt.fulfillmentIntentId;
      const prepared = await f.fulfillmentCommands.get(context, intentId, { version: originalVersion, orderId: scenario.scene.order.id });
      const proof = f.confirmation(prepared), businessBefore = await f.business(), ownerCompleted = f.original.calls.ownerCompleted,
        ownerExecuteCalls = f.original.calls.execute;
      const gate = f.original.hold("beforeExecute");
      const pending = f.fulfillmentCommands.confirm(context, intentId, proof);
      const observed = pending.then(result => ({ result, rejected: false }), () => ({ result: null, rejected: true }));
      try {
        await f.bounded(gate.entered, "native4_actual_original_claim_gate_not_reached");
        const [claimed] = await withTenant(database.db, context, tx => tx.select({ status: orderFulfillmentCommandIntents.status })
          .from(orderFulfillmentCommandIntents).where(eq(orderFulfillmentCommandIntents.id, intentId)));
        expect(claimed?.status).toBe("executing");
        expect(await f.business()).toEqual(businessBefore);
        if (change === "stop") await service.stop(context, view.id, { version, requestId: view.requestId });
        else if (change === "ttl") await f.waitParentExpired(view.id);
        else if (change === "membership") await f.base.memberActive(f.base.a, false);
        else {
          const scopes = nativeV3Scopes();
          delete scopes[change === "workflow" ? Permission.WorkflowRun : Permission.OrderPiiRead];
          await f.base.scopes(f.base.a, scopes);
        }
        gate.release();
        const outcome = await observed;
        // An admitted original may return its truthful expired/rejected view
        // instead of throwing. Neither transport outcome is business success.
        if (outcome.result) {
          expect(outcome.result.canConfirm).toBe(false);
          expect(outcome.result.native.status === "succeeded").toBe(false);
          expect(outcome.result.native.receipt === null).toBe(true);
        }
        expect(f.original.calls.execute).toBe(ownerExecuteCalls + 1);
        expect(f.original.calls.ownerCompleted).toBe(ownerCompleted);
        // Restore only after the admitted execution has settled and rejected;
        // the digest reader must not rely on a disabled membership snapshot.
        if (change === "membership") await f.base.memberActive(f.base.a, true);
        if (change === "workflow" || change === "pii") await f.base.scopes(f.base.a, nativeV3Scopes());
        expect(await f.business()).toEqual(businessBefore);
      } finally {
        gate.release(); await observed;
        await f.base.memberActive(f.base.a, true);
        await f.base.scopes(f.base.a, nativeV3Scopes());
        // Revoked authority can leave the claimed original lease untouched.
        // Stop this exact synthetic parent, then let its original privacy read
        // expire the child and clear the lease before normal acknowledge.
        await service.stop(await f.current(), view.id, { version, requestId: view.requestId });
        await f.fulfillmentCommands.get(await f.current(), intentId, { version: originalVersion, orderId: scenario.scene.order.id });
      }
    });
});
