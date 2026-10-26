import { describe, expect, it, vi } from "vitest";
import { erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { STUDIO_IMAGE_DRAFT_KEY } from "@yummyai/contracts/pod/studio-document-transfer";
import type { StudioImageBudgetSettings, StudioImageBudgetWorkspace } from "@yummyai/contracts/pod/studio-image-budget";
import { captureStudioContext, StudioApiError } from "./studio-api";
import { createStudioImageGenerationClient, studioImageDecimal } from "./studio-image-generation-client";

const tenantId = "019a0000-0000-7000-8000-000000000001", userId = "019a0000-0000-7000-8000-000000000002";
const authority = erpSessionAuthority({ tenantId, userId, permissions: ["design:read"], dataScope: "tenant", teamIds: [] });
const modelId = "019f0000-0000-7000-8000-000000000011";
function setup() {
  let current = true;
  const context = captureStudioContext({ authority, ownerScope: `${tenantId}:${userId}`, localDevelopment: false }, new AbortController().signal, () => current);
  const call = vi.fn<(input: Record<string, unknown>) => Promise<unknown>>();
  return { call, client: createStudioImageGenerationClient({ scope: "unassigned", context, call }), clear: () => { current = false; } };
}
describe("single-image input and price projection", () => {
  it("uses declared image capability and exact route identifiers rather than defaults or model-name guesses", async () => {
    const env = setup(); env.call.mockResolvedValueOnce([
      { id: modelId, label: "synthetic-video-looking-image", model: "synthetic-video", capability: "image", providerLabel: "A", isDefault: false, selectionRevision: "a".repeat(64) },
      { id: "019f0000-0000-7000-8000-000000000012", label: "synthetic-image-looking-video", model: "synthetic-image", capability: "video", providerLabel: "A", isDefault: true, selectionRevision: "b".repeat(64) },
    ]);
    expect((await env.client.models()).map(model => [model.id, model.capability, model.isDefault])).toEqual([[modelId, "image", false]]);
    expect(env.call.mock.calls.map(([input]) => input.operation)).toEqual(["models"]);
  });
  it("projects only the saved active editable image fields and never writes or treats the old count as the new count", async () => {
    const env = setup(), document = { version: 1, activeId: "draft-2", drafts: [
      { id: "draft-1", prompt: "Keep inactive", references: [], config: { imageModel: "old", count: "4" } },
      { id: "draft-2", prompt: "Original saved input", references: [{ id: "ref", name: "Original approved reference", type: "image", dataUrl: "blob:old-session", storageKey: "saved-ref" }], config: { model: "wrong-generic", imageModel: `${modelId}::original-image`, count: "4", size: "1536x1024", quality: "high" } },
    ] };
    const checkpoint = JSON.stringify(document); env.call.mockResolvedValueOnce({ revision: 7, value: document });
    expect(await env.client.draft()).toEqual({ prompt: "Original saved input", model: `${modelId}::original-image`, size: "1536x1024", quality: "high", references: [{ key: "saved-ref", name: "Original approved reference" }], revision: 7, activeId: "draft-2" });
    expect(JSON.stringify(document)).toBe(checkpoint); expect(env.call.mock.calls[0]?.[0]).toEqual({ operation: "state.get", namespace: "app_state", key: STUDIO_IMAGE_DRAFT_KEY });
    expect(env.call).toHaveBeenCalledTimes(1);
  });
  it("refuses unsaved reference bytes and broken active draft identity without uploading or rewriting originals", async () => {
    const env = setup(); env.call.mockResolvedValueOnce({ revision: 3, value: { version: 1, activeId: "a", drafts: [{ id: "a", prompt: "Original", references: [{ id: "r", name: "Unsaved", dataUrl: "data:image/png;base64,AAAA" }], config: {} }] } });
    await expect(env.client.draft()).rejects.toThrow("尚未保存");
    env.call.mockResolvedValueOnce({ revision: 3, value: { version: 1, activeId: "missing", drafts: [] } }); await expect(env.client.draft()).rejects.toThrow("唯一");
    expect(env.call.mock.calls.map(([input]) => input.operation)).toEqual(["state.get", "state.get"]);
  });
  it("does not adopt a fulfilled old catalogue after identity clear", async () => {
    const env = setup(); env.call.mockImplementationOnce(async () => { env.clear(); return []; });
    await expect(env.client.models()).rejects.toThrow(); expect(env.call).toHaveBeenCalledTimes(1);
  });
  it("preserves exact decimal strings without floating-point rounding or inheriting a token price", () => {
    expect(studioImageDecimal("0.04", 8)).toBe("0.04000000"); expect(studioImageDecimal("0.06", 6)).toBe("0.060000");
    expect(studioImageDecimal("99999999.000001", 6)).toBe("99999999.000001");
    for (const value of ["0.0000001", "1e-3", "Infinity", "-1", "", "0.1 USD"]) expect(() => studioImageDecimal(value, 6)).toThrow();
  });
});

describe("organization image budget original revision", () => {
  const settings: StudioImageBudgetSettings = { revision: "a".repeat(64), monthlyCapUsd: "200.000000", defaultTaskCapUsd: "2.000000", imageTaskCapUsd: "0.060000" };
  const before: StudioImageBudgetWorkspace = { version: 1, revision: settings.revision, periodStart: "2026-10-01T00:00:00.000Z", periodEnd: "2026-11-01T00:00:00.000Z", occupiedUsd: "0.060000",
    policy: { monthlyCapUsd: "100.000000", defaultTaskCapUsd: "1.000000", imageTaskCapUsd: null, imageCapSource: "default" } };
  const after: StudioImageBudgetWorkspace = { ...before, revision: "b".repeat(64), policy: { monthlyCapUsd: settings.monthlyCapUsd, defaultTaskCapUsd: settings.defaultTaskCapUsd, imageTaskCapUsd: settings.imageTaskCapUsd, imageCapSource: "specific" } };

  it("requires a read-proven original revision and all three positive explicit strings before a single save", async () => {
    const env = setup(); await expect(env.client.saveBudget(settings)).rejects.toThrow("先只读刷新"); expect(env.call).not.toHaveBeenCalled();
    env.call.mockResolvedValueOnce(structuredClone(before)); const read = await env.client.budget(); read.revision = "f".repeat(64);
    await expect(env.client.saveBudget({ ...settings, revision: read.revision })).rejects.toThrow("原版本");
    await expect(env.client.saveBudget({ ...settings, imageTaskCapUsd: "0.000000" })).rejects.toThrow(); expect(env.call).toHaveBeenCalledTimes(1);
    env.call.mockResolvedValueOnce(structuredClone(after)); const result = await env.client.saveBudget(settings);
    expect(result).toEqual(after); expect(env.call.mock.calls.map(([input]) => input)).toEqual([
      { operation: "paid.image.budget.get" }, { operation: "paid.image.budget.save", settings },
    ]); expect(settings.revision).toBe("a".repeat(64));
  });
  it("preserves an absent policy and null revision instead of inventing default money", async () => {
    const env = setup(); env.call.mockResolvedValueOnce({ ...before, revision: null, policy: null, occupiedUsd: "0.000000" });
    expect(await env.client.budget()).toMatchObject({ revision: null, policy: null, occupiedUsd: "0.000000" });
    expect(env.call.mock.calls.map(([input]) => input.operation)).toEqual(["paid.image.budget.get"]);
  });
  it("consumes save proof after a lost ACK and permits only a subsequent read until an explicit new save", async () => {
    const env = setup(); env.call.mockResolvedValueOnce(structuredClone(before)); await env.client.budget();
    env.call.mockRejectedValueOnce(new Error("Lost budget save ACK")); await expect(env.client.saveBudget(settings)).rejects.toThrow("Lost budget save ACK");
    await expect(env.client.saveBudget(settings)).rejects.toThrow("先只读刷新"); expect(env.call).toHaveBeenCalledTimes(2);
    env.call.mockResolvedValueOnce(structuredClone(after)); expect(await env.client.budget()).toEqual(after);
    expect(env.call.mock.calls.map(([input]) => input.operation)).toEqual(["paid.image.budget.get", "paid.image.budget.save", "paid.image.budget.get"]);
  });
  it.each(["invalid-period", "wrong-settings"] as const)("rejects %s acknowledgement without restoring save proof or replaying", async failure => {
    const env = setup(); env.call.mockResolvedValueOnce(structuredClone(before)); await env.client.budget();
    env.call.mockResolvedValueOnce(failure === "invalid-period" ? { ...after, periodEnd: after.periodStart } : { ...after, policy: { ...after.policy, imageTaskCapUsd: "0.070000" } });
    await expect(env.client.saveBudget(settings)).rejects.toThrow(); await expect(env.client.saveBudget(settings)).rejects.toThrow("先只读刷新");
    expect(env.call).toHaveBeenCalledTimes(2); expect(env.call.mock.calls[1]?.[0]).toEqual({ operation: "paid.image.budget.save", settings });
  });
  it("keeps budget-specific forbidden distinct and rejects a fulfilled read after owner clear", async () => {
    const env = setup(); env.call.mockRejectedValueOnce(new StudioApiError("请联系组织管理员", 403, "studio_image_budget_forbidden"));
    await expect(env.client.budget()).rejects.toMatchObject({ status: 403, code: "studio_image_budget_forbidden" });
    env.call.mockImplementationOnce(async () => { env.clear(); return structuredClone(after); }); await expect(env.client.budget()).rejects.toThrow();
    await expect(env.client.saveBudget(settings)).rejects.toThrow(); expect(env.call).toHaveBeenCalledTimes(2);
    expect(env.call.mock.calls.every(([input]) => input.operation === "paid.image.budget.get")).toBe(true);
  });
});
