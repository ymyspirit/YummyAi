import { afterEach, describe, expect, it, vi } from "vitest";
import { cancelViewTransitions, observeViewTransition } from "./view-transition";
afterEach(() => vi.unstubAllGlobals());
describe("native view transition lifecycle", () => {
  it("removes active visual snapshots when the current identity loses access", async () => {
    let finish!: () => void;
    const skip = vi.fn();
    observeViewTransition({
      ready: Promise.resolve(),
      updateCallbackDone: Promise.resolve(),
      finished: new Promise<void>((resolve) => {
        finish = resolve;
      }),
      skipTransition: skip,
    } as unknown as ViewTransition);
    cancelViewTransitions();
    cancelViewTransitions();
    expect(skip).toHaveBeenCalledTimes(1);
    finish();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  it("settles a skipped animation without treating a successful DOM update as an application failure", async () => {
    const report = vi.fn();
    vi.stubGlobal("reportError", report);
    const skipped = new DOMException(
      "Transition was aborted because of timeout in DOM update",
      "AbortError",
    );
    const value = {
      ready: Promise.reject(skipped),
      finished: Promise.resolve(),
      updateCallbackDone: Promise.resolve(),
      skipTransition: vi.fn(),
    } as unknown as ViewTransition;
    expect(observeViewTransition(value)).toBe(value);
    // Let unhandled rejections surface; the test must not catch them itself.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(report).not.toHaveBeenCalled();
  });
  it("reports an actual failed DOM update once instead of hiding it as an animation cancellation", async () => {
    const report = vi.fn();
    vi.stubGlobal("reportError", report);
    const failure = new Error("Synthetic real UI update failure");
    const value = {
      ready: Promise.reject(failure),
      finished: Promise.reject(failure),
      updateCallbackDone: Promise.reject(failure),
    } as unknown as ViewTransition;
    observeViewTransition(value);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(report).toHaveBeenCalledExactlyOnceWith(failure);
  });
});
