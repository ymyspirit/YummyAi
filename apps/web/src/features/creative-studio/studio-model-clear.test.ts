import { describe, expect, it, vi } from "vitest";
import { ASSIST_INTENT_CLEAR_EVENT } from "@yummyai/contracts/ai/assist-recovery";
import { STUDIO_PERSONAL_CLEAR_EVENT } from "@yummyai/contracts/pod/studio-personal";
import { bindStudioModelClear } from "./studio-model-clear";

describe("the real host model-clear event binding", () => {
  it("sends cancellation on both clear events using the current exact frame channel and origin", () => {
    const events = new EventTarget(), postMessage = vi.fn(); let channel = "original-channel";
    const close = bindStudioModelClear(events, () => ({ postMessage }), "http://127.0.0.1:4316", () => channel);
    events.dispatchEvent(new Event(STUDIO_PERSONAL_CLEAR_EVENT)); channel = "next-channel";
    events.dispatchEvent(new Event(ASSIST_INTENT_CLEAR_EVENT));
    expect(postMessage.mock.calls).toEqual([[{ type: "studio.clear", channel: "original-channel" }, "http://127.0.0.1:4316"], [{ type: "studio.clear", channel: "next-channel" }, "http://127.0.0.1:4316"]]);
    close();
  });
  it("clears before disposing the binding and removes both event listeners", () => {
    const events = new EventTarget(), postMessage = vi.fn(), close = bindStudioModelClear(events, () => ({ postMessage }), "http://127.0.0.1:4316", () => "retained-channel");
    events.dispatchEvent(new Event("unrelated-event")); expect(postMessage).not.toHaveBeenCalled();
    close(); expect(postMessage).toHaveBeenCalledTimes(1);
    events.dispatchEvent(new Event(STUDIO_PERSONAL_CLEAR_EVENT)); events.dispatchEvent(new Event(ASSIST_INTENT_CLEAR_EVENT)); close();
    expect(postMessage).toHaveBeenCalledTimes(1);
  });
  it("does not notify an uninitialized or already disposed frame", () => {
    const events = new EventTarget(), postMessage = vi.fn(); let target: Pick<Window, "postMessage"> | null = { postMessage }, channel = "";
    const close = bindStudioModelClear(events, () => target, "http://127.0.0.1:4316", () => channel);
    events.dispatchEvent(new Event(STUDIO_PERSONAL_CLEAR_EVENT)); channel = "initialized"; target = null;
    events.dispatchEvent(new Event(STUDIO_PERSONAL_CLEAR_EVENT)); close(); expect(postMessage).not.toHaveBeenCalled();
  });
  it("keeps local logout cleanup working if frame delivery fails", () => {
    const events = new EventTarget(), postMessage = vi.fn(() => { throw new Error("Disposed frame"); });
    const close = bindStudioModelClear(events, () => ({ postMessage }), "http://127.0.0.1:4316", () => "original-channel");
    expect(() => events.dispatchEvent(new Event(STUDIO_PERSONAL_CLEAR_EVENT))).not.toThrow();
    expect(close).not.toThrow(); expect(postMessage).toHaveBeenCalledTimes(2);
    events.dispatchEvent(new Event(STUDIO_PERSONAL_CLEAR_EVENT)); expect(postMessage).toHaveBeenCalledTimes(2);
  });
});
