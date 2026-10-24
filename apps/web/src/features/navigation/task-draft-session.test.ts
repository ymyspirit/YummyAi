import { afterEach, describe, expect, it, vi } from "vitest";
import { clearSessionTaskDrafts, clearTaskDrafts, readSessionTaskDraft, writeSessionTaskDraft } from "./task-draft";

function storage() {
  const values: Record<string, string> = {};
  const api = {
    get length() { return Object.keys(values).length; },
    key: (index: number) => Object.keys(values)[index] ?? null,
    clear: () => { for (const key of Object.keys(values)) delete values[key]; },
    getItem: (key: string) => values[key] ?? null,
    setItem: (key: string, value: string) => { values[key] = value; },
    removeItem: (key: string) => { delete values[key]; },
  } satisfies Storage;
  return { api, values };
}
afterEach(() => vi.unstubAllGlobals());
describe("opt-in product-only session drafts", () => {
  it("restores the exact scoped draft, rejects a different identity and expires after two hours", () => {
    const { api } = storage(), key = "tenant:user:authority:specification:version:fields";
    writeSessionTaskDraft(api, key, { structure: ["Synthetic draft"], confirmed: [] }, 1000);
    expect(readSessionTaskDraft(api, key, 2000)).toEqual({ structure: ["Synthetic draft"], confirmed: [] });
    expect(readSessionTaskDraft(api, key.replace("user", "other"), 2000)).toBeUndefined();
    expect(readSessionTaskDraft(api, key, 1000 + 2 * 60 * 60 * 1000)).toBeUndefined();
    expect(api.length).toBe(0);
  });
  it("clears only the selected scope, and logout clears all opt-in product drafts without touching other storage", () => {
    const { api, values } = storage();
    writeSessionTaskDraft(api, "A:fields", { value: "Synthetic A" }, 1000);
    writeSessionTaskDraft(api, "AB:fields", { value: "Synthetic AB" }, 1000);
    values["unrelated-page"] = "Synthetic unrelated state";
    values["yummyai.knowledge-evaluation.start.v1:authority:case"] = "Synthetic original paid intent";
    values["yummyai.knowledge-benchmark.intent.v1:authority:request"] = "Synthetic fixed sample original intent";
    values["yummyai.publication-preview.intent.v1:actor:listing"] = "Synthetic original preview scalar intent";
    // Storage's named keys are enumerable in the browser.
    vi.stubGlobal("window", { sessionStorage: values });
    Object.defineProperty(values, "removeItem", { value: api.removeItem, enumerable: false });
    clearTaskDrafts("A");
    expect(readSessionTaskDraft(api, "A:fields", 2000)).toBeUndefined();
    expect(readSessionTaskDraft(api, "AB:fields", 2000)).toEqual({ value: "Synthetic AB" });
    clearSessionTaskDrafts();
    expect(values["yummyai.knowledge-evaluation.start.v1:authority:case"]).toBeUndefined();
    expect(values["yummyai.knowledge-benchmark.intent.v1:authority:request"]).toBeUndefined();
    expect(values["yummyai.publication-preview.intent.v1:actor:listing"]).toBeUndefined();
    expect(values["unrelated-page"]).toBe("Synthetic unrelated state");
    expect(api.length).toBe(1);
  });
  it("does not treat malformed or structurally invalid storage as a valid recovered draft", () => {
    const { api, values } = storage(), key = "A:fields";
    writeSessionTaskDraft(api, key, "wrong shape", 1000);
    expect(() => readSessionTaskDraft(api, key, 2000, (value): value is Record<string, string[]> => !!value && typeof value === "object")).toThrow(/格式已损坏/);
    values[Object.keys(values)[0]!] = "{invalid";
    expect(() => readSessionTaskDraft(api, key, 2000)).toThrow();
  });
});
