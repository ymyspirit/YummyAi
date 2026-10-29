import { describe, expect, it } from "vitest";
import { createEntityId } from "@yummyai/contracts";
import { assistHarness, type AssistContext } from "@yummyai/ai-core";
import { CreateAssistSchema } from "@yummyai/contracts/ai/assist";
import { assistTaskFingerprint } from "./assist-task-fingerprint.js";

function packet(): AssistContext {
  return {
    request: {
      kind: "order_review",
      orderLineId: createEntityId(),
      expectedRevision: 2,
      expectedSourceVersionId: null,
      requestId: createEntityId(),
      modelId: createEntityId(),
      taskGoal: "核对缺项",
    },
    data: { title: "Synthetic order", quantity: 1 },
    sources: [],
    checks: [],
    diagnostics: [],
    images: [],
    allowedArtworkIds: [],
    allowedSpecificationIds: [],
    allowMatches: false,
  };
}
describe("task preview checksum", () => {
  it("keeps output token policy outside business evidence while execution policy pins it separately", () => {
    const original = packet();
    expect(assistTaskFingerprint({ ...original, outputTokenPolicy: "provider" })).toBe(assistTaskFingerprint(original));
  });
  it("ignores the catalog knowledge lookup clock while retaining references and retrieval mode", () => {
    const input = {
      ...packet(),
      data: {
        operatingKnowledge: {
          references: [{ checksum: "reviewed-v1" }],
          mode: "keyword",
          retrievedAt: "2026-10-07T00:00:00Z",
        },
      },
    };
    const saved = structuredClone(input),
      hash = assistTaskFingerprint(input);
    const changed = (patch: Record<string, unknown>) => ({
      ...input,
      data: { operatingKnowledge: { ...input.data.operatingKnowledge, ...patch } },
    });
    expect(assistTaskFingerprint(changed({ retrievedAt: "2026-10-07T00:00:05Z" }))).toBe(hash);
    expect(assistTaskFingerprint(changed({ references: [{ checksum: "reviewed-v2" }] }))).not.toBe(
      hash,
    );
    expect(assistTaskFingerprint(changed({ mode: "semantic" }))).not.toBe(hash);
    expect(input).toEqual(saved);
  });
  it("survives transport IDs and does not mutate the pinned request", () => {
    const input = packet(),
      saved = structuredClone(input),
      fingerprint = assistTaskFingerprint(input);
    expect(
      assistTaskFingerprint({
        ...input,
        request: {
          ...input.request,
          requestId: createEntityId(),
          modelId: createEntityId(),
          expectedTaskFingerprint: fingerprint,
        },
      }),
    ).toBe(fingerprint);
    expect(input).toEqual(saved);
  });
  it("detects changed facts, source pixels, goal and rule diagnostics", () => {
    const input = packet(),
      fingerprint = assistTaskFingerprint(input);
    for (const changed of [
      { ...input, data: { ...input.data, quantity: 2 } },
      { ...input, images: [{ sourceId: "asset", dataUrl: "data:image/jpeg;base64,changed" }] },
      { ...input, request: { ...input.request, taskGoal: "其他重点" } },
      { ...input, diagnostics: ["Source changed"] },
    ])
      expect(assistTaskFingerprint(changed)).not.toBe(fingerprint);
  });
  it("keeps the business preview stable when server-side access audit metadata is added", () => {
    const input = packet(), fingerprint = assistTaskFingerprint(input);
    expect(assistTaskFingerprint({ ...input, accessPolicy: { version: "assist-access-test-v1", requiredPermissions: ["order:read"], dataScope: "tenant" } })).toBe(fingerprint);
    expect(assistTaskFingerprint({ ...input, data: { ...input.data, quantity: 2 }, accessPolicy: { version: "assist-access-test-v1", requiredPermissions: [] } })).not.toBe(fingerprint);
  });
  it("separately pins server dependency audit without invalidating a business preview", () => {
    const input = packet(), before = assistTaskFingerprint(input);
    const audited: AssistContext = { ...input, inputAuthority: { version: "assist-input-authority-v1", capturedAt: "2026-10-16T00:00:00.000Z", fingerprint: "1".repeat(64), resources: [] } };
    expect(assistTaskFingerprint(audited)).toBe(before);
    expect(assistTaskFingerprint({ ...audited, data: { ...input.data, quantity: 2 } })).not.toBe(before);
    expect(() => CreateAssistSchema.parse({ ...input.request, inputAuthority: audited.inputAuthority })).toThrow();
  });
  it("seals server methods separately from business previews and rejects caller-supplied contracts", () => {
    const input = packet(), harness = assistHarness("order_review", false, ["order:read", "order:pii:read", "order:write"], "test-policy-v1");
    const executionContract = harness.registry.pin(harness.skill);
    expect(assistTaskFingerprint({ ...input, executionContract })).toBe(assistTaskFingerprint(input));
    expect(() => CreateAssistSchema.parse({ ...input.request, executionContract })).toThrow();
  });
  it("compares knowledge content and mode without invalidating every preview on a new clock", () => {
    const input: AssistContext = {
      ...packet(),
      request: CreateAssistSchema.parse({
        kind: "knowledge_answer",
        requestId: createEntityId(),
        modelId: createEntityId(),
        scopeId: createEntityId(),
        search: { query: "资料核对", topic: "all", platform: "all", market: "ALL", spuIds: [] },
      }),
      data: {
        operatingKnowledge: [
          { sourceId: "version-1", content: "Reviewed facts", checksum: "fixed" },
        ],
        retrieval: { mode: "keyword", retrievedAt: "2026-10-07T00:00:00.000Z" },
      },
      expiresAt: "2026-11-07T00:00:00.000Z",
    };
    const fingerprint = assistTaskFingerprint(input),
      saved = structuredClone(input);
    expect(
      assistTaskFingerprint({
        ...input,
        data: {
          ...input.data,
          retrieval: { mode: "keyword", retrievedAt: "2026-10-07T00:00:03.000Z" },
        },
        expiresAt: "2026-11-07T00:00:03.000Z",
      }),
    ).toBe(fingerprint);
    expect(
      assistTaskFingerprint({
        ...input,
        data: {
          ...input.data,
          operatingKnowledge: [
            { sourceId: "version-2", content: "Revised facts", checksum: "changed" },
          ],
        },
      }),
    ).not.toBe(fingerprint);
    expect(
      assistTaskFingerprint({
        ...input,
        data: {
          ...input.data,
          retrieval: { mode: "other", retrievedAt: "2026-10-07T00:00:00.000Z" },
        },
      }),
    ).not.toBe(fingerprint);
    expect(input).toEqual(saved);
  });
});
