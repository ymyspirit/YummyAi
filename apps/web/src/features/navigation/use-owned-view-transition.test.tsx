import { describe, expect, it, vi } from "vitest";
import { createOwnedViewTransitions } from "./use-owned-view-transition";
function fixture(animated = true) {
  const updates: Array<() => void> = [];
  const controller = createOwnedViewTransitions({
    animated: () => animated,
    commit: (update) => update(),
    start: (update) => {
      updates.push(update);
      return {
        skipTransition: vi.fn(),
        ready: Promise.resolve(),
        finished: Promise.resolve(),
        updateCallbackDone: Promise.resolve(),
      } as unknown as ViewTransition;
    },
  });
  return { updates, controller };
}
describe("owned private view transitions", () => {
  it("preserves consecutive record and editor updates when the animation is superseded", () => {
    const { updates, controller } = fixture(),
      seen: string[] = [];
    controller.change(() => seen.push("refreshed record"));
    controller.change(() => seen.push("closed editor"));
    updates.forEach((update) => update());
    expect(seen).toEqual(["refreshed record", "closed editor"]);
  });
  it("discards queued private updates after authority is lost", () => {
    const { updates, controller } = fixture(),
      update = vi.fn();
    controller.change(update);
    controller.cancel();
    updates.forEach((run) => run());
    expect(update).not.toHaveBeenCalled();
  });
  it("updates immediately when the operator requests reduced motion", () => {
    const { updates, controller } = fixture(false),
      update = vi.fn();
    controller.change(update);
    expect(update).toHaveBeenCalledOnce();
    expect(updates).toEqual([]);
  });
});
