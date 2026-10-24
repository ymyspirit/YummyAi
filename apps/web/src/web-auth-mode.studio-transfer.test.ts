import { afterEach, describe, expect, it, vi } from "vitest";
import { STUDIO_PERSONAL_CLEAR_EVENT } from "@yummyai/contracts/pod/studio-personal";
import { STUDIO_TRANSFER_INTENT_PREFIX } from "@yummyai/contracts/pod/studio-document-transfer";
import { clearSessionTaskDrafts } from "./features/navigation/task-draft";

afterEach(() => vi.unstubAllGlobals());
describe("Studio copy logout after leaving the Studio route", () => {
  it("fences late responses and clears original pointers without loading the transfer component", () => {
    const key = STUDIO_TRANSFER_INTENT_PREFIX + "synthetic-owner:original-request";
    const values: Record<string, string> = { [key]: "SYNTHETIC ORIGINAL ID", unrelated: "KEEP" };
    Object.defineProperty(values, "removeItem", { value: (at: string) => delete values[at], enumerable: false });
    const events: string[] = [];
    vi.stubGlobal("window", { sessionStorage: values, dispatchEvent: (event: Event) => {
      events.push(event.type);
      if (event.type === STUDIO_PERSONAL_CLEAR_EVENT) expect(values[key]).toBe("SYNTHETIC ORIGINAL ID");
      return true;
    } });
    clearSessionTaskDrafts({ preserveAssistIntents: true });
    expect(values[key]).toBe("SYNTHETIC ORIGINAL ID"); expect(events).toEqual([]);
    clearSessionTaskDrafts();
    expect(events).toContain(STUDIO_PERSONAL_CLEAR_EVENT);
    expect(values).toEqual({ unrelated: "KEEP" });
  });
});
