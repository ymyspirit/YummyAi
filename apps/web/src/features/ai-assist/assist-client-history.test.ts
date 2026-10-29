import { createEntityId } from "@yummyai/contracts";
import { AssistViewSchema, CreateAssistSchema, type AssistHistoryEntry, type AssistView } from "@yummyai/contracts/ai/assist";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assistApi } from "./assist-client";
import { assistEntryVerification } from "./assist-entry-recovery";

const fetchMock = vi.fn<typeof fetch>();
const authority = "synthetic-history-owner";
const request = CreateAssistSchema.options[0].parse({ kind: "knowledge_answer", requestId: createEntityId(), scopeId: createEntityId(),
  modelId: createEntityId(), search: { query: "Synthetic original question", topic: "all", platform: "all", market: "ALL", spuIds: [] } });
const historyPath = "runs?kind=knowledge_answer&scope=" + encodeURIComponent("knowledge:" + request.scopeId);
const original = AssistViewSchema.parse({ id: createEntityId(), kind: "knowledge_answer", scope: "knowledge:" + request.scopeId,
  status: "completed", createdAt: "2026-10-29T00:00:00.000Z", completedAt: "2026-10-29T00:00:01.000Z",
  modelLabel: "Synthetic history model", model: "synthetic-model", promptVersion: "synthetic-v1", inputFingerprint: "a".repeat(64),
  stale: false, maxTaskCostUsd: 1, request, inputTokens: 100, outputTokens: 60, costUsd: null, error: null,
  tokenUsage: { version: "model-token-usage-v1", inputTokens: 100, outputTokens: 60, cachedInputTokens: 20, totalTokens: 160, totalTokensBasis: "provider" },
  usageSummary: { scope: "assist_scope", state: "complete", callCount: 1, reportedCalls: 1, unknownCalls: 0,
    inputTokens: 100, outputTokens: 60, cachedInputTokens: 20, totalTokens: 160 },
  diagnostics: [], sources: [], knowledge: [], checks: [], images: [],
  result: { summary: "Synthetic original answer", findings: [], directions: [], matches: [], missingInformation: [] } });
// The public list transport carries metadata and server usage, never the answer body.
const historyRow: AssistHistoryEntry = { id: original.id, status: original.status, createdAt: original.createdAt, modelLabel: original.modelLabel,
  tokenUsage: original.tokenUsage, usageSummary: original.usageSummary };
function reply(value: unknown) { return Response.json(value, { headers: { "x-yummyai-context-authority": authority } }); }

describe("Assist history and original detail transport", () => {
  beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal("fetch", fetchMock); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("reads the API usage metadata list and then the original completed knowledge answer through the actual client parser", async () => {
    fetchMock.mockResolvedValueOnce(reply([historyRow])).mockResolvedValueOnce(reply(original));
    const rows = await assistApi<Array<typeof historyRow>>(historyPath, undefined, undefined, authority);
    expect(rows).toEqual([historyRow]);
    const detail = await assistApi<AssistView>("runs/" + rows[0]!.id, undefined, undefined, authority);
    expect(detail).toEqual(original);
    expect(detail).toMatchObject({ id: rows[0]!.id, status: "completed", stale: false, maxTaskCostUsd: 1,
      result: { summary: "Synthetic original answer" }, tokenUsage: historyRow.tokenUsage, usageSummary: historyRow.usageSummary });
    expect(await assistEntryVerification(detail)).toMatchObject({ runId: original.id, requestId: request.requestId });
    expect(fetchMock.mock.calls.map(([url, init]) => ({ url: String(url), method: init?.method }))).toEqual([
      { url: "/api/ai-assists/" + historyPath, method: "GET" },
      { url: "/api/ai-assists/runs/" + original.id, method: "GET" },
    ]);
  });

  it("retains compatibility with the four-field history shape through the shared optional usage fields", async () => {
    const legacy = { id: original.id, status: original.status, createdAt: original.createdAt, modelLabel: original.modelLabel };
    fetchMock.mockResolvedValueOnce(reply([legacy]));
    expect(await assistApi(historyPath, undefined, undefined, authority)).toEqual([legacy]);
  });

  it("still rejects unknown list fields instead of accepting a substituted answer body", async () => {
    fetchMock.mockResolvedValueOnce(reply([{ ...historyRow, result: original.result }]));
    await expect(assistApi(historyPath, undefined, undefined, authority)).rejects.toMatchObject({ status: 502, code: null });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    { tokenUsage: { ...original.tokenUsage, cachedInputTokens: 101 } },
    { usageSummary: { ...original.usageSummary, reportedCalls: 0 } },
    { tokenUsage: { ...original.tokenUsage, unknownSyntheticUnits: 10 } },
  ])("validates declared usage with the original strict shared contracts: %j", async invalid => {
    fetchMock.mockResolvedValueOnce(reply([{ ...historyRow, ...invalid }]));
    await expect(assistApi(historyPath, undefined, undefined, authority)).rejects.toMatchObject({ status: 502, code: null });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
