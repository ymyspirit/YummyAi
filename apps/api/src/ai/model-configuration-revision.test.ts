import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  modelConfigurationRevision,
  type ModelConfigurationRevisionProvider,
  type ModelConfigurationRevisionRoute,
} from "./model-configuration-revision.js";

const provider: ModelConfigurationRevisionProvider = {
  id: "019cf7a0-abcd-7000-8000-000000000001",
  updatedAt: new Date("2026-10-24T00:00:00.000Z"),
};
const otherProviderId = "019cf7a0-abcd-7000-8000-000000000002";
const route = (suffix: string, patch: Partial<ModelConfigurationRevisionRoute> = {}): ModelConfigurationRevisionRoute => ({
  id: `019cf7a0-abcd-7000-8000-${suffix.padStart(12, "0")}`,
  updatedAt: new Date("2026-10-24T00:00:00.000Z"),
  status: "enabled",
  modelKey: `Model ${suffix}`,
  taskType: "studio_image",
  targets: [{ providerConfigId: provider.id, providerModel: `image-${suffix}`, timeoutMs: 600_000 }],
  ...patch,
});

describe("model configuration selection revision", () => {
  it("retains the existing revision fields in stable route ID order", () => {
    const first = route("1"), second = route("2");
    const expected = createHash("sha256").update(JSON.stringify([
      provider.updatedAt,
      [first, second].map(value => [value.id, value.updatedAt, value.status, value.targets, value.modelKey, value.taskType]),
    ])).digest("hex");
    expect(modelConfigurationRevision(provider, [second, first])).toBe(expected);
    expect(expected).toMatch(/^[a-f0-9]{64}$/);
  });

  it("is independent of equal-time database row ordering", () => {
    const rows = [route("3"), route("1"), route("2")];
    const expected = modelConfigurationRevision(provider, rows);
    expect(modelConfigurationRevision(provider, [rows[1]!, rows[2]!, rows[0]!])).toBe(expected);
    expect(modelConfigurationRevision(provider, [...rows].reverse())).toBe(expected);
  });

  it("does not reorder or change the caller's route and target arrays", () => {
    const rows = [route("2"), route("1", { targets: [
      { providerConfigId: otherProviderId, providerModel: "first", timeoutMs: 1_000 },
      { providerConfigId: provider.id, providerModel: "second", timeoutMs: 2_000 },
    ] })];
    const before = globalThis.structuredClone({ provider, rows });
    Object.freeze(rows);
    for (const row of rows) {
      Object.freeze(row.targets);
      Object.freeze(row);
    }
    expect(() => modelConfigurationRevision(provider, rows)).not.toThrow();
    expect({ provider, rows }).toEqual(before);
  });

  it("ignores routes belonging only to another provider", () => {
    const own = route("1"), other = route("2", {
      targets: [{ providerConfigId: otherProviderId, providerModel: "other", timeoutMs: 10_000 }],
    });
    expect(modelConfigurationRevision(provider, [other, own])).toBe(modelConfigurationRevision(provider, [own]));
    expect(modelConfigurationRevision(provider, [own, { ...other, status: "disabled", modelKey: "renamed" }]))
      .toBe(modelConfigurationRevision(provider, [own]));
  });

  it("includes disabled, analysis and dependent routes, even a secondary provider target", () => {
    const owned = route("1");
    for (const related of [
      route("2", { status: "disabled" }),
      route("3", { taskType: "studio_analysis" }),
      route("4", { taskType: "business_analysis", targets: [
        { providerConfigId: otherProviderId, providerModel: "primary", timeoutMs: 1_000 },
        { providerConfigId: provider.id, providerModel: "fallback", timeoutMs: 2_000 },
      ] }),
    ]) {
      expect(modelConfigurationRevision(provider, [owned, related])).not.toBe(modelConfigurationRevision(provider, [owned]));
    }
  });

  const changes: Array<[string, Partial<ModelConfigurationRevisionRoute>]> = [
    ["route ID", { id: "019cf7a0-abcd-7000-8000-000000000099" }],
    ["update time", { updatedAt: new Date("2026-10-24T00:00:01.000Z") }],
    ["status", { status: "disabled" }],
    ["display name", { modelKey: "Renamed model" }],
    ["capability", { taskType: "studio_video" }],
    ["provider model", { targets: [{ providerConfigId: provider.id, providerModel: "video-model", timeoutMs: 600_000 }] }],
    ["timeout", { targets: [{ providerConfigId: provider.id, providerModel: "image-1", timeoutMs: 10_000 }] }],
    ["pricing", { targets: [{ providerConfigId: provider.id, providerModel: "image-1", timeoutMs: 600_000, analysisPricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 2, maxTaskCostUsd: 3 } }] }],
    ["provider association", { targets: [{ providerConfigId: otherProviderId, providerModel: "image-1", timeoutMs: 600_000 }] }],
  ];
  it.each(changes)("changes when %s changes", (_label, patch) => {
    const original = route("1");
    expect(modelConfigurationRevision(provider, [{ ...original, ...patch }])).not.toBe(modelConfigurationRevision(provider, [original]));
  });

  it("changes when the provider update time changes", () => {
    const rows = [route("1")];
    expect(modelConfigurationRevision({ ...provider, updatedAt: new Date("2026-10-24T00:00:01.000Z") }, rows))
      .not.toBe(modelConfigurationRevision(provider, rows));
  });

  it("retains target priority order", () => {
    const original = route("1", { targets: [
      { providerConfigId: provider.id, providerModel: "first", timeoutMs: 1_000 },
      { providerConfigId: otherProviderId, providerModel: "second", timeoutMs: 2_000 },
    ] });
    expect(modelConfigurationRevision(provider, [{ ...original, targets: [...original.targets].reverse() }]))
      .not.toBe(modelConfigurationRevision(provider, [original]));
  });

  it("matches UUID provider associations without rewriting stored target bytes", () => {
    const original = route("1", { targets: [{ providerConfigId: provider.id.toUpperCase(), providerModel: "image-1", timeoutMs: 600_000 }] });
    const before = globalThis.structuredClone(original);
    expect(modelConfigurationRevision(provider, [original])).not.toBe(modelConfigurationRevision(provider, []));
    expect(original).toEqual(before);
  });

  it("does not read credentials, endpoints or other provider fields", () => {
    const publicProvider = {
      ...provider,
      get encryptedApiKey(): never { throw new Error("credential must not be read"); },
      get endpoint(): never { throw new Error("endpoint must not be read"); },
    };
    expect(modelConfigurationRevision(publicProvider, [route("1")])).toBe(modelConfigurationRevision(provider, [route("1")]));
  });
});
