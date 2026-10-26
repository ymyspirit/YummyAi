import { ForbiddenError, Permission } from "@yummyai/authz";
import type { TenantContext } from "@yummyai/contracts";
import { StudioGenerateRequestSchema } from "@yummyai/contracts/pod/creative-studio";
import { describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import { ProductVisualsService } from "./product-visuals.service.js";

const id = (last: string) => `019a0000-0000-7000-8000-${last.padStart(12, "0")}`;
const modelId = id("2"), requestId = id("3"), planId = id("9"), groupId = id("10");
const required = [Permission.ProductRead, Permission.DesignRead, Permission.AssetRead, Permission.DesignWrite] as const;
const context: TenantContext = { tenantId: id("4"), userId: id("5"), permissions: required, dataScope: "self", teamIds: [] };
function fixture(slotKey: "artwork" | "scene" = "artwork") {
  const databaseAccess = vi.fn(() => { throw new Error("legacy_visual_database_access_forbidden"); });
  const database = { get db() { return databaseAccess(); }, get client() { return databaseAccess(); } };
  const plans = { assistBasis: vi.fn() }, workflow = { results: vi.fn() }, assets = { invoke: vi.fn() };
  const studio = { originalInput: vi.fn().mockResolvedValue(null), models: vi.fn(), create: vi.fn() };
  const storage = { readPrivate: vi.fn(), putPrivate: vi.fn() }, audit = { record: vi.fn() };
  const service = new ProductVisualsService(database as never, storage as never, plans as never, {} as never,
    workflow as never, studio as never, assets as never, audit as never);
  const group = vi.spyOn(service as unknown as { group: (...args: unknown[]) => Promise<unknown[]> }, "group");
  const input = { requestId, modelId, slotKey, ...(slotKey === "scene" ? { artworkVersionId: id("8") } : {}) };
  const sideEffects = { databaseAccess, plan: plans.assistBasis, group, originalRead: studio.originalInput, models: studio.models,
    create: studio.create, workflow: workflow.results, assets: assets.invoke, storageRead: storage.readPrivate,
    storageWrite: storage.putPrivate, audit: audit.record };
  return { service, studio, input, sideEffects };
}
function noSideEffects(f: ReturnType<typeof fixture>) {
  for (const [name, spy] of Object.entries(f.sideEffects)) expect(spy, name).not.toHaveBeenCalled();
}

// Formerly "product visual generation preserves the selected model request".
// Real quoted model pin/replay is covered by studio-visual-paid-image and
// studio-paid-image API suites; historical originals by the paid legacy suite.
// This file only covers the predecessor's paused boundary.
describe("legacy product visual generation stops before quoted image admission", () => {
  it.each([
    { name: "a valid new artwork request", slotKey: "artwork" as const, replay: false },
    { name: "an original-key artwork replay", slotKey: "artwork" as const, replay: true },
    { name: "a scene replay with retained artwork references", slotKey: "scene" as const, replay: true },
  ])("keeps $name paused without reading owners or creating work", async ({ slotKey, replay }) => {
    const f = fixture(slotKey);
    if (replay) f.studio.originalInput.mockResolvedValue(StudioGenerateRequestSchema.parse({ requestId, modelId,
      prompt: "Original fixed input", capability: "image", selectionRevision: "a".repeat(64),
      ...(slotKey === "scene" ? { referenceKeys: ["retained-reference"] } : {}) }));
    f.studio.models.mockRejectedValue(new Error("Original catalogue must remain unread"));
    await expect(f.service.generate(context, planId, groupId, f.input)).rejects.toMatchObject({
      status: 409, response: { code: "studio_paid_execution_paused" },
    });
    noSideEffects(f);
  });

  it.each(required)("rejects missing %s before reading data or validating the request", async permission => {
    const f = fixture("scene"), missing: TenantContext = { ...context, permissions: required.filter(value => value !== permission) };
    for (const input of [f.input, { ...f.input, requestId: "invalid-request-id" }]) {
      const operation = f.service.generate(missing, planId, groupId, input);
      await expect(operation).rejects.toBeInstanceOf(ForbiddenError);
      await expect(operation).rejects.toMatchObject({ status: 403, code: "FORBIDDEN", permission, reason: "missing_permission" });
    }
    noSideEffects(f);
  });

  it("rejects malformed input and quote fields on the legacy route without any side effect", async () => {
    const f = fixture();
    for (const input of [{ ...f.input, requestId: "invalid-request-id" },
      { ...f.input, quoteHash: "b".repeat(64), confirmed: true }]) {
      await expect(f.service.generate(context, planId, groupId, input)).rejects.toBeInstanceOf(ZodError);
    }
    noSideEffects(f);
  });
});
