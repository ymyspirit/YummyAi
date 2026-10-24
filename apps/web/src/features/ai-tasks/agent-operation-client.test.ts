import { createHash, randomUUID, webcrypto } from "node:crypto";
import { createEntityId } from "@yummyai/contracts";
import { AGENT_COMMAND_VERSION, AgentCommandIntentSchema, canonicalAgentCommandRequest, canonicalAgentCommandOriginal, type AgentCommandView } from "@yummyai/contracts/ai/agent-command";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adoptAgentOperation, actOnAgentOperation, readAgentOperationRequest, readAgentOperationReceipt, agentOperationRequestChecksum,
  prepareAgentOperationIntent, saveAgentOperationIntent, updateAgentOperationIntent, readAgentOperationIntents, forgetAgentOperationIntent,
  AGENT_OPERATION_INTENT_PREFIX, agentOperationDenied } from "./agent-operation-client";

const stamp = "synthetic-current-authority", id = createEntityId(), ownerId = createEntityId(), requestId = randomUUID(), date = "2026-10-22T00:00:00.000Z";
const input = { version: AGENT_COMMAND_VERSION, requestId, reference: { domain: "procurement" as const, commandId: ownerId, accountId: null } };
const original = { domain: "procurement" as const, command: { kind: "requisition_create" as const, targetId: null, input: { code: "SYNTHETIC", reasonCode: "SYNTHETIC",
  lines: [{ lineKey: "L1", stockItemId: createEntityId(), destinationLocationId: createEntityId(), quantity: 2, unit: "each" as const }], idempotencyKey: randomUUID() } } };
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const view = (): AgentCommandView => ({ version: AGENT_COMMAND_VERSION, id, requestId, requestChecksum: hash(canonicalAgentCommandRequest("adopt", input)),
  contextAuthority: stamp, domain: "procurement", kind: "requisition_create", ownerCommandId: ownerId, createdAt: date, expiresAt: "2026-10-29T00:00:00.000Z",
  executeRequestedAt: null, cancelledAt: null, state: "prepared", privateAvailable: true, snapshot: { reference: input.reference, original,
    native: { domain: "procurement", view: { id: ownerId, kind: "requisition_create", targetId: null, targetLabel: "Synthetic original", targetDetail: null,
      status: "prepared", createdAt: date, expiresAt: "2026-10-29T00:00:00.000Z", completedAt: null, contextAuthority: stamp, acknowledged: false,
      canExecute: true, canCancel: true, original: original.command, result: null, blockReason: null } } },
  originalChecksum: hash(canonicalAgentCommandOriginal(original)), confirmationToken: "synthetic-fixed-token", confirmationExpiresAt: "2026-10-22T00:05:00.000Z",
  canConfirm: true, canCancel: true, errorCode: null });
const response = (value: unknown, status = 200, authority: string | null = stamp) => Response.json(value, { status,
  headers: authority === null ? {} : { "x-yummyai-context-authority": authority } });
class MemoryStorage implements Storage {
  readonly values = new Map<string, string>(); get length() { return this.values.size; }
  clear() { this.values.clear(); } key(index: number) { return Array.from(this.values.keys())[index] ?? null; }
  getItem(key: string) { return this.values.get(key) ?? null; } setItem(key: string, value: string) { this.values.set(key, value); } removeItem(key: string) { this.values.delete(key); }
}

describe("Agent operation original proof and browser recovery", () => {
  beforeEach(() => { vi.stubGlobal("crypto", webcrypto); vi.stubGlobal("window", new EventTarget()); vi.stubGlobal("sessionStorage", new MemoryStorage()); });
  afterEach(() => { vi.unstubAllGlobals(); });
  it("uses only GET for original proof recovery and rejects substituted IDs stamps or malformed receipts without retrying", async () => {
    const query = { requestId, requestChecksum: view().requestChecksum }, receipt = { version: AGENT_COMMAND_VERSION, ...query,
      disposition: "known", id, ownerCommandId: ownerId, privateAvailable: false, contextAuthority: stamp };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(receipt)); vi.stubGlobal("fetch", fetcher);
    expect(await readAgentOperationReceipt(query, stamp)).toEqual(receipt);
    for (const invalid of [response({ ...receipt, requestId: randomUUID() }), response(receipt, 201), response(receipt, 200, null),
      response({ ...receipt, contextAuthority: "other" }), response({ ...receipt, original })]) {
      fetcher.mockResolvedValueOnce(invalid); await expect(readAgentOperationReceipt(query, stamp)).rejects.toHaveProperty("status");
    }
    fetcher.mockResolvedValueOnce(response({ ...view(), id: createEntityId() })); await expect(readAgentOperationRequest(id, stamp)).rejects.toMatchObject({ status: 502 });
    expect(fetcher.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
  });
  it("binds201 adoption to the complete original reference and never resends after response loss", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(view(), 201)); vi.stubGlobal("fetch", fetcher);
    expect(await agentOperationRequestChecksum("adopt", input)).toBe(view().requestChecksum);
    expect((await adoptAgentOperation(input, stamp)).ownerCommandId).toBe(ownerId);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: "POST", body: JSON.stringify(input) });
    fetcher.mockRejectedValueOnce(new TypeError("synthetic response lost")); await expect(adoptAgentOperation(input, stamp)).rejects.toMatchObject({ status: 0 });
    expect(fetcher).toHaveBeenCalledTimes(2);
    fetcher.mockResolvedValueOnce(response({ ...view(), requestChecksum: "a".repeat(64) }, 201)); await expect(adoptAgentOperation(input, stamp)).rejects.toMatchObject({ status: 502 });
  });
  it("sends only a specific original confirmation and refuses a different returned command or unknown stop outcome", async () => {
    const value = view(), fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(value)); vi.stubGlobal("fetch", fetcher);
    await actOnAgentOperation(value, "confirm", stamp);
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({ version: AGENT_COMMAND_VERSION, requestId, ownerCommandId: ownerId,
      originalChecksum: value.originalChecksum, confirmationToken: value.confirmationToken, decision: "execute_original" });
    fetcher.mockResolvedValueOnce(response({ ...value, requestId: randomUUID() })); await expect(actOnAgentOperation(value, "cancel", stamp)).rejects.toMatchObject({ status: 502 });
    fetcher.mockResolvedValueOnce(response({ code: "authority_changed", message: "synthetic private error" }, 409));
    const error = await readAgentOperationRequest(id, stamp).catch(value => value); expect(agentOperationDenied(error)).toBe(true); expect(String(error)).not.toContain("synthetic private error");
  });
  it("stores only seven proof scalars before handoff and blocks unknown or cleared markers from being silently replaced or revived", async () => {
    const prepared = await prepareAgentOperationIntent(input, "person-A"), marker = saveAgentOperationIntent(prepared.intent);
    expect(Object.keys(marker)).toHaveLength(7); expect(AgentCommandIntentSchema.safeParse(marker).success).toBe(true);
    const stored = sessionStorage.getItem(AGENT_OPERATION_INTENT_PREFIX + marker.ownerScope + ":" + marker.requestId)!;
    expect(stored).not.toContain("synthetic-fixed-token"); expect(stored).not.toContain("idempotencyKey");
    updateAgentOperationIntent({ ...marker, state: "unknown" });
    await expect(prepareAgentOperationIntent({ ...input, requestId: randomUUID() }, "person-A")).rejects.toMatchObject({ status: 409 });
    expect(readAgentOperationIntents(hash("person-B"))).toEqual([]);
    forgetAgentOperationIntent(marker);
    expect(() => updateAgentOperationIntent({ ...marker, state: "known", id })).toThrow(); expect(readAgentOperationIntents(marker.ownerScope)).toEqual([]);
    const write = vi.spyOn(sessionStorage, "setItem").mockImplementation(() => {});
    expect(() => saveAgentOperationIntent(marker)).toThrow(); write.mockRestore();
  });
});
