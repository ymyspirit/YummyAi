import { afterEach, describe, expect, it, vi } from "vitest";
import { ASSIST_INTENT_CLEAR_EVENT } from "@yummyai/contracts/ai/assist-recovery";
import { AGENT_LOOP_INTENT_CLEAR_EVENT } from "@yummyai/contracts/ai/agent-loop";
import { STUDIO_PERSONAL_CLEAR_EVENT } from "@yummyai/contracts/pod/studio-personal";
import { clearSessionTaskDrafts } from "./task-draft";

const studioKeys = [
  "yummyai.studio.scope",
  `yummyai.studio.scope:${"a".repeat(64)}`,
  `yummyai.studio.scope:${"b".repeat(64)}`,
];
const productKey = "yummyai:product-task-draft:v1:synthetic:field";

function surfaceWithStorage() {
  const storage: Record<string, string> = Object.fromEntries([
    ...studioKeys.map((key, index) => [key, `synthetic-scope-${index}`]),
    [productKey, "synthetic-product-draft"],
    ["yummyai.studio.scope-other", "unrelated-near-prefix"],
    ["unrelated-page", "retain"],
  ]);
  Object.defineProperties(storage, {
    length: { get: () => Object.keys(storage).length },
    key: { value: (index: number) => Object.keys(storage)[index] ?? null },
    getItem: { value: (key: string) => storage[key] ?? null },
    setItem: { value: (key: string, value: string) => { storage[key] = value; } },
    removeItem: { configurable: true, value: (key: string) => { delete storage[key]; } },
  });
  const surface = new EventTarget();
  Object.defineProperty(surface, "sessionStorage", { configurable: true, value: storage });
  vi.stubGlobal("window", surface);
  vi.stubGlobal("sessionStorage", storage);
  return { surface, storage };
}

function observeReaderInvalidation(surface: EventTarget) {
  const events: string[] = [], prematureReads: string[] = [];
  let studioReaderActive = true;
  surface.addEventListener(STUDIO_PERSONAL_CLEAR_EVENT, () => {
    studioReaderActive = false;
    events.push("studio");
  });
  surface.addEventListener(AGENT_LOOP_INTENT_CLEAR_EVENT, () => events.push("loop"));
  surface.addEventListener(ASSIST_INTENT_CLEAR_EVENT, () => {
    events.push("assist");
    surface.dispatchEvent(new Event("focus"));
  });
  surface.addEventListener("focus", () => {
    events.push("focus");
    if (studioReaderActive) prematureReads.push("studio-read-before-clear");
  });
  return { events, prematureReads };
}

describe("personal Studio central clear", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("invalidates Studio before legacy focus synchronously and clears legacy plus every owner scope", () => {
    const { surface, storage } = surfaceWithStorage();
    const { events, prematureReads } = observeReaderInvalidation(surface);
    const atClear: Array<{ allKeysPresent: boolean; carriesDetail: boolean }> = [];
    surface.addEventListener(STUDIO_PERSONAL_CLEAR_EVENT, event => atClear.push({
      allKeysPresent: studioKeys.every(key => storage[key] !== undefined),
      carriesDetail: "detail" in event,
    }));

    clearSessionTaskDrafts();

    expect(events).toEqual(["studio", "loop", "assist", "focus"]);
    expect(prematureReads).toEqual([]);
    expect(atClear).toEqual([{ allKeysPresent: true, carriesDetail: false }]);
    expect(studioKeys.every(key => storage[key] === undefined)).toBe(true);
    expect(storage[productKey]).toBeUndefined();
    expect(Object.keys(storage).sort()).toEqual(["unrelated-page", "yummyai.studio.scope-other"]);
  });

  it("preserves Studio scope keys without any clear or focus event on a same-actor refresh", () => {
    const { surface, storage } = surfaceWithStorage();
    const { events } = observeReaderInvalidation(surface);
    const originalScopes = studioKeys.map(key => storage[key]);

    clearSessionTaskDrafts({ preserveAssistIntents: true });

    expect(events).toEqual([]);
    expect(studioKeys.map(key => storage[key])).toEqual(originalScopes);
    expect(storage[productKey]).toBeUndefined();
    expect(storage["unrelated-page"]).toBe("retain");
    expect(storage["yummyai.studio.scope-other"]).toBe("unrelated-near-prefix");
  });

  it.each(["access", "enumeration", "removal"] as const)(
    "still invalidates readers before legacy focus when session storage fails during %s",
    phase => {
      const { surface, storage } = surfaceWithStorage();
      const { events, prematureReads } = observeReaderInvalidation(surface);
      const failure = () => { throw new Error("SYNTHETIC_STORAGE_UNAVAILABLE"); };
      if (phase === "access") Object.defineProperty(surface, "sessionStorage", { get: failure });
      if (phase === "enumeration") Object.defineProperty(surface, "sessionStorage", {
        value: new Proxy(storage, { ownKeys: failure }),
      });
      if (phase === "removal") Object.defineProperty(storage, "removeItem", { value: failure });

      expect(() => clearSessionTaskDrafts()).not.toThrow();

      expect(events).toEqual(["studio", "loop", "assist", "focus"]);
      expect(prematureReads).toEqual([]);
      // A blocked browser store is not reported as successfully erased. The
      // security boundary here is synchronous reader invalidation despite it.
      expect(studioKeys.every(key => storage[key] !== undefined)).toBe(true);
    },
  );
});
