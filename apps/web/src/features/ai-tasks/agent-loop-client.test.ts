import { createHash, randomUUID, webcrypto } from "node:crypto";
import { createEntityId } from "@yummyai/contracts";
import { AGENT_LOOP_VERSION, CreateAgentLoopSchema, defaultAgentLoopLimits, type AgentLoopReceipt } from "@yummyai/contracts/ai/agent-loop";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readAgentLoopReceipt, readAgentLoopRun, createAgentLoop, stopAgentLoop, agentLoopReadDenied } from "./agent-loop-client";

const authority = "synthetic exact current authority", id = createEntityId(), requestId = randomUUID(), checksum = "a".repeat(64);
const receipt = (): AgentLoopReceipt => ({ version: AGENT_LOOP_VERSION, requestId, requestChecksum: checksum, disposition: "known", runId: id,
  status: "stopping", privateAvailable: false, contextAuthority: authority });
const response = (raw: unknown, status = 200, stamp: string | null = authority) => new Response(JSON.stringify(raw), { status,
  headers: { "content-type": "application/json", ...(stamp === null ? {} : { "x-yummyai-context-authority": stamp }) } });
const input = () => CreateAgentLoopSchema.parse({ version: AGENT_LOOP_VERSION, requestId, modelId: createEntityId(), goal: "Synthetic bounded question",
  allowedTools: ["inventory.balances.page"], limits: defaultAgentLoopLimits(), maxCostUsd: 0.1,
  executionContract: { contractVersion: "native-harness-v1", executorKey: "erp.agent.loop",
    skill: { key: "erp.agent.loop", version: AGENT_LOOP_VERSION, checksum }, tools: [{ key: "agent.loop.decide", version: AGENT_LOOP_VERSION, checksum }], checksum } });
const run = (body = input()) => ({ version: AGENT_LOOP_VERSION, id, requestId: body.requestId,
  requestChecksum: createHash("sha256").update(canonicalJson(body)).digest("hex"), contextAuthority: authority, revision: 1, status: "queued",
  goal: body.goal, modelLabel: "Synthetic priced model", allowedTools: body.allowedTools, executionContract: body.executionContract,
  limits: body.limits, cost: { capUsd: "0.100000", knownCostUsd: "0.000000", reservedUsd: "0.100000", coverage: "known", modelTurns: 0 },
  toolCalls: 0, observedRows: 0, stopRequestedAt: null, errorCode: null, createdAt: "2026-10-22T00:00:00.000Z", updatedAt: "2026-10-22T00:00:00.000Z",
  deadlineAt: "2026-10-22T00:10:00.000Z", expiresAt: "2026-10-23T00:00:00.000Z", privateAvailable: true,
  stepsComplete: true, steps: [], collections: [], result: null, verification: "pending" });

describe("Agent loop exact personal transport", () => {
  beforeEach(() => { vi.stubGlobal("crypto", webcrypto); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("recovers exclusively through GET with the original proof and rejects a mismatched ID, stamp, schema or successful HTTP status", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(receipt())); vi.stubGlobal("fetch", fetcher);
    expect(await readAgentLoopReceipt({ requestId, requestChecksum: checksum }, authority)).toEqual(receipt());
    expect(fetcher.mock.calls[0]![0]).toBe("/api/agent-loops/receipts?" + new URLSearchParams({ requestId, requestChecksum: checksum }));
    expect(fetcher.mock.calls[0]![1]).toMatchObject({ method: "GET", cache: "no-store", headers: { "x-yummyai-context-authority": authority } });
    for (const invalid of [response({ ...receipt(), requestId: randomUUID() }), response({ ...receipt(), requestChecksum: "f".repeat(64) }),
      response(receipt(), 201), response(receipt(), 200, null), response({ ...receipt(), contextAuthority: "another authority" }), response({ ...receipt(), privateBody: "private" })]) {
      fetcher.mockResolvedValueOnce(invalid); await expect(readAgentLoopReceipt({ requestId, requestChecksum: checksum }, authority)).rejects.toHaveProperty("status");
    }
    fetcher.mockResolvedValueOnce(response({ ...run(), id: createEntityId() })); await expect(readAgentLoopRun(id, authority)).rejects.toMatchObject({ status: 502 });
    expect(fetcher.mock.calls.every(([, options]) => options?.method === "GET")).toBe(true);
  });

  it("binds the actual 201 to canonical submitted bytes and never automatically repeats a lost create or changes its request ID", async () => {
    const body = input(), fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(run(body), 201)); vi.stubGlobal("fetch", fetcher);
    expect((await createAgentLoop(body, authority)).requestChecksum).toBe(run(body).requestChecksum);
    expect(fetcher.mock.calls[0]![1]).toMatchObject({ method: "POST", body: JSON.stringify(body) });
    fetcher.mockRejectedValueOnce(new TypeError("synthetic lost response"));
    await expect(createAgentLoop(body, authority)).rejects.toMatchObject({ status: 0 }); expect(fetcher).toHaveBeenCalledTimes(2);
    fetcher.mockResolvedValueOnce(response({ ...run(body), requestChecksum: "b".repeat(64) }, 201));
    await expect(createAgentLoop(body, authority)).rejects.toMatchObject({ status: 502 }); expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("stops through only the original ID and request proof after domain read loss and masks raw failures without pretending an unknown write stopped", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(receipt())); vi.stubGlobal("fetch", fetcher);
    expect(await stopAgentLoop(id, { version: AGENT_LOOP_VERSION, requestId }, authority)).toEqual(receipt());
    expect(fetcher.mock.calls[0]![1]).toMatchObject({ method: "POST", body: JSON.stringify({ version: AGENT_LOOP_VERSION, requestId }) });
    fetcher.mockResolvedValueOnce(response({ ...receipt(), runId: createEntityId() }));
    await expect(stopAgentLoop(id, { version: AGENT_LOOP_VERSION, requestId }, authority)).rejects.toMatchObject({ status: 502 });
    fetcher.mockResolvedValueOnce(response({ code: "authority_changed", message: "synthetic private upstream error" }, 409));
    const error = await readAgentLoopRun(id, authority).catch(value => value);
    expect(agentLoopReadDenied(error)).toBe(true); expect(String(error)).not.toContain("synthetic private upstream error");
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});
