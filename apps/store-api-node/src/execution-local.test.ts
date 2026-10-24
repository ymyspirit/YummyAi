import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { openStoreNodeJournal, openStoreNodeState, sealStoreNodeJournal, sealStoreNodeState } from "./identity.js";
import { cacheStoreNodeResponse, replayStoreNodeResponse } from "./execution-journal.js";

const passphrase = "synthetic-node-execution-local-passphrase";
describe("store node execution local boundary", () => {
  it("authenticates the execution journal in a separate domain from the original heartbeat state", async () => {
    const spki = createHash("sha256").update("synthetic-execution-spki").digest("hex");
    const original = { version: 1, marker: "synthetic-secret-refresh-response", rows: [{ state: "submitted", ordinal: 1 }] };
    const journal = await sealStoreNodeJournal(original, passphrase, spki), heartbeat = await sealStoreNodeState(original, passphrase, spki);
    try {
      expect(journal.toString()).not.toContain(original.marker);
      expect(await openStoreNodeJournal(journal, passphrase, spki)).toEqual(original);
      await expect(openStoreNodeState(journal, passphrase, spki)).rejects.toThrow("store_node_identity_invalid");
      await expect(openStoreNodeJournal(heartbeat, passphrase, spki)).rejects.toThrow("store_node_identity_invalid");
      await expect(openStoreNodeJournal(journal, passphrase, "0".repeat(64))).rejects.toThrow("store_node_identity_invalid");
    } finally { journal.fill(0); heartbeat.fill(0); }
  });
  it("preserves native Amazon quota across the shared received-response cache without changing legacy response fields", async () => {
    const response = new Response(JSON.stringify({ status: "ACCEPTED" }), { headers: { "content-type": "application/json", "x-amzn-ratelimit-limit": "5.5" } });
    const cached = await cacheStoreNodeResponse(response), restored = replayStoreNodeResponse(cached);
    expect(restored.headers.get("x-amzn-ratelimit-limit")).toBe("5.5"); expect(await restored.json()).toEqual({ status: "ACCEPTED" });
    const legacy = await cacheStoreNodeResponse(new Response("{}"));
    expect(legacy).not.toHaveProperty("amazonRateLimit"); expect(replayStoreNodeResponse(legacy).headers.has("x-amzn-ratelimit-limit")).toBe(false);
  });
});
