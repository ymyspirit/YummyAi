import { createHash, randomUUID, webcrypto } from "node:crypto";
import { createEntityId } from "@yummyai/contracts";
import { AGENT_PLAN_VERSION, CreateAgentPlanSchema, defaultAgentPlanLimits, type AgentPlanItemView, type AgentPlanView } from "@yummyai/contracts/ai/agent-plan";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentPlan, readAgentPlanReceipt, readAgentPlanRun, prepareAgentPlanItem, readAgentPlanItemReceipt, stopAgentPlan, agentPlanReadDenied } from "./agent-plan-client";

const authority = "synthetic exact current personal authority", id = createEntityId(), requestId = randomUUID(), checksum = "a".repeat(64), date = "2026-10-22T00:00:00.000Z";
const input = () => CreateAgentPlanSchema.parse({ version: AGENT_PLAN_VERSION, requestId, modelId: createEntityId(), goal: "Synthetic unapproved plan", contextText: "Synthetic unverified facts",
  allowedReads: ["inventory.balances.page"], allowedCommands: [{ domain: "procurement", kind: "requisition_create" }], limits: defaultAgentPlanLimits(), maxCostUsd: 0.1,
  executionContract: { contractVersion: "native-harness-v1", executorKey: "erp.agent.plan", skill: { key: "erp.agent.plan", version: AGENT_PLAN_VERSION, checksum }, tools: [{ key: "agent.plan.decide", version: AGENT_PLAN_VERSION, checksum }], checksum } });
const run = (body = input()): AgentPlanView => ({ version: AGENT_PLAN_VERSION, id, requestId: body.requestId, requestChecksum: createHash("sha256").update(canonicalJson(body)).digest("hex"), contextAuthority: authority,
  revision: 1, status: "queued", goal: body.goal, contextText: body.contextText, modelLabel: "Synthetic priced model", allowedReads: body.allowedReads, allowedCommands: body.allowedCommands,
  executionContract: body.executionContract, limits: body.limits, cost: { capUsd: "0.100000", knownCostUsd: "0.000000", reservedUsd: "0.100000", coverage: "known", modelTurns: 0 },
  toolCalls: 0, observedRows: 0, stopRequestedAt: null, errorCode: null, createdAt: date, updatedAt: date, deadlineAt: "2026-10-22T00:10:00.000Z", expiresAt: "2026-10-23T00:00:00.000Z",
  privateAvailable: true, stepsComplete: true, steps: [], collections: [], result: null, items: [], verification: "pending", businessExecution: "separate_original_confirmation" });
const receipt = () => ({ version: AGENT_PLAN_VERSION, requestId, requestChecksum: checksum, disposition: "known", runId: id, status: "completed", privateAvailable: false, contextAuthority: authority });
const item: AgentPlanItemView = { id: createEntityId(), position: 0, proposalChecksum: checksum, originalChecksum: checksum, preparationRequestChecksum: checksum,
  preparationRequestedAt: null, agentCommandId: null, ownerCommandId: null, preparationState: "not_requested", canPrepare: true, blockReason: null };
const itemReceipt = () => ({ version: AGENT_PLAN_VERSION, runId: id, itemId: item.id, proposalChecksum: checksum, preparationRequestChecksum: checksum,
  disposition: "known", agentCommandId: createEntityId(), ownerCommandId: createEntityId(), contextAuthority: authority });
const response = (value: unknown, status = 200, stamp: string | null = authority) => new Response(JSON.stringify(value), { status,
  headers: { "content-type": "application/json", ...(stamp === null ? {} : { "x-yummyai-context-authority": stamp }) } });

describe("exact personal planning and explicit item-preparation transport", () => {
  beforeEach(() => { vi.stubGlobal("crypto", webcrypto); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("binds the actual planning201 to canonical submitted fields and never retries a lost model admission", async () => {
    const body = input(), fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(run(body), 201)); vi.stubGlobal("fetch", fetcher);
    expect(await createAgentPlan(body, authority)).toEqual(run(body)); expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: "POST", body: JSON.stringify(body) });
    for (const changed of [{ ...run(body), requestChecksum: "b".repeat(64) }, { ...run(body), allowedCommands: [{ domain: "finance", kind: "bill_record" }] },
      { ...run(body), privateAvailable: false }]) {
      fetcher.mockResolvedValueOnce(response(changed, 201)); await expect(createAgentPlan(body, authority)).rejects.toHaveProperty("status", 502);
    }
    fetcher.mockRejectedValueOnce(new TypeError("synthetic lost201")); await expect(createAgentPlan(body, authority)).rejects.toHaveProperty("status", 0);
    expect(fetcher).toHaveBeenCalledTimes(5);
  });

  it("recovers planning exclusively through exact GET proof and rejects changed run IDs authority or non200 success", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(receipt())); vi.stubGlobal("fetch", fetcher);
    expect(await readAgentPlanReceipt({ requestId, requestChecksum: checksum }, authority)).toEqual(receipt());
    for (const changed of [response({ ...receipt(), requestId: randomUUID() }), response(receipt(), 201), response(receipt(), 200, null), response({ ...receipt(), contextAuthority: "another actor" })]) {
      fetcher.mockResolvedValueOnce(changed); await expect(readAgentPlanReceipt({ requestId, requestChecksum: checksum }, authority)).rejects.toHaveProperty("status");
    }
    fetcher.mockResolvedValueOnce(response({ ...run(), id: createEntityId() })); await expect(readAgentPlanRun(id, authority)).rejects.toHaveProperty("status", 502);
    expect(fetcher.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
  });

  it("prepares only the selected immutable item and recovers unknown preparation by GET without preparing or executing another command", async () => {
    const expected = itemReceipt(), fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response(expected, 201)).mockResolvedValueOnce(response(expected)); vi.stubGlobal("fetch", fetcher);
    const parent = { id, requestId };
    expect(await prepareAgentPlanItem(parent, item, authority)).toEqual(expected);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: "POST", body: JSON.stringify({ version: AGENT_PLAN_VERSION, requestId, proposalChecksum: checksum }) });
    expect(await readAgentPlanItemReceipt(parent, item, authority)).toEqual(expected); expect(fetcher.mock.calls[1]?.[1]?.method).toBe("GET");
    for (const changed of [{ ...expected, itemId: createEntityId() }, { ...expected, runId: createEntityId() }, { ...expected, proposalChecksum: "f".repeat(64) }, { ...expected, preparationRequestChecksum: "f".repeat(64) }]) {
      fetcher.mockResolvedValueOnce(response(changed)); await expect(readAgentPlanItemReceipt(parent, item, authority)).rejects.toHaveProperty("status", 502);
    }
    fetcher.mockRejectedValueOnce(new TypeError("synthetic lost prepare201")); await expect(prepareAgentPlanItem(parent, item, authority)).rejects.toHaveProperty("status", 0);
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(2);
    expect(fetcher.mock.calls.some(([url]) => String(url).includes("/confirm") || String(url).includes("/execute"))).toBe(false);
  });

  it("stops only the original planning request and masks raw errors without claiming to cancel prepared or already executed business facts", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(receipt())); vi.stubGlobal("fetch", fetcher);
    expect(await stopAgentPlan(id, { version: AGENT_PLAN_VERSION, requestId }, authority)).toEqual(receipt());
    fetcher.mockResolvedValueOnce(response({ code: "authority_changed", message: "synthetic private upstream" }, 409));
    const error = await readAgentPlanRun(id, authority).catch(value => value); expect(agentPlanReadDenied(error)).toBe(true); expect(String(error)).not.toContain("synthetic private upstream");
    fetcher.mockResolvedValueOnce(response({ ...receipt(), runId: createEntityId() }));
    await expect(stopAgentPlan(id, { version: AGENT_PLAN_VERSION, requestId }, authority)).rejects.toHaveProperty("status", 502);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});
