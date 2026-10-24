import { describe, expect, it } from "vitest";
import { StoreNodePki } from "./store-node-pki.js";
import { StoreNodeRuntimeGateway } from "./store-node-runtime-gateway.js";

describe("store node mTLS listener opt-in", () => {
  it("does not create a listener or call a business owner when runtime is disabled", async () => {
    const gateway = new StoreNodeRuntimeGateway(await StoreNodePki.fromEnvironment({}), { runtimeHeartbeat: async () => { throw new Error("must_not_call"); } });
    await gateway.onApplicationBootstrap(); expect(gateway.address()).toBeNull();
    await gateway.onApplicationShutdown(); expect(gateway.address()).toBeNull();
  });
});
