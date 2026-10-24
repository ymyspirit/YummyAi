import { afterEach, describe, expect, it, vi } from "vitest";
import { createStudioAccessChecks } from "./studio-access-check";

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (cause: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
async function settled() { await Promise.resolve(); await Promise.resolve(); }
afterEach(() => { vi.useRealTimers(); });

describe("captured Studio access checks", () => {
  it("merges pending tool and focus triggers into one in-flight read plus one trailing read", async () => {
    const owner = new AbortController(), first = deferred<string>(), second = deferred<string>();
    const read = vi.fn<(signal: AbortSignal) => Promise<string>>().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise), onValue = vi.fn(), onError = vi.fn();
    const checks = createStudioAccessChecks({ signal: owner.signal, isCurrent: () => true, read, onValue, onError });
    checks.request(); checks.request(); checks.request();
    expect(read).toHaveBeenCalledTimes(1); expect(read.mock.calls[0]![0].aborted).toBe(false);
    first.resolve("first"); await settled(); expect(read).toHaveBeenCalledTimes(2);
    expect(read.mock.calls[0]![0].aborted).toBe(false); second.resolve("second"); await settled();
    expect(onValue.mock.calls).toEqual([["first"], ["second"]]); expect(onError).not.toHaveBeenCalled(); expect(read).toHaveBeenCalledTimes(2); checks.stop();
  });
  it("clears a completed controller and its deadline before a later check or stop", async () => {
    vi.useFakeTimers();
    const owner = new AbortController(), second = deferred<string>(), read = vi.fn<(signal: AbortSignal) => Promise<string>>().mockResolvedValueOnce("complete").mockReturnValueOnce(second.promise), onValue = vi.fn();
    const checks = createStudioAccessChecks({ signal: owner.signal, isCurrent: () => true, read, onValue, onError: vi.fn() });
    checks.request(); await settled(); const completed = read.mock.calls[0]![0];
    expect(vi.getTimerCount()).toBe(0); await vi.advanceTimersByTimeAsync(20_000); expect(completed.aborted).toBe(false);
    checks.request(); expect(read).toHaveBeenCalledTimes(2); expect(completed.aborted).toBe(false);
    checks.stop(); expect(read.mock.calls[1]![0].aborted).toBe(true); expect(completed.aborted).toBe(false);
    second.resolve("late"); await settled(); expect(onValue).toHaveBeenCalledExactlyOnceWith("complete");
  });
  it("immediately aborts CLEAR and never sends its queued check or adopts a late value", async () => {
    const owner = new AbortController(), pending = deferred<string>(), read = vi.fn<(signal: AbortSignal) => Promise<string>>(() => pending.promise), onValue = vi.fn(), onError = vi.fn();
    const checks = createStudioAccessChecks({ signal: owner.signal, isCurrent: () => true, read, onValue, onError });
    checks.request(); checks.request(); owner.abort(); expect(read.mock.calls[0]![0].aborted).toBe(true);
    checks.request(); pending.resolve("late"); await settled();
    expect(read).toHaveBeenCalledTimes(1); expect(onValue).not.toHaveBeenCalled(); expect(onError).not.toHaveBeenCalled();
  });
  it("drops both late values and the trailing read when the captured scope is no longer current", async () => {
    let current = true;
    const owner = new AbortController(), pending = deferred<string>(), read = vi.fn<(signal: AbortSignal) => Promise<string>>(() => pending.promise), onValue = vi.fn();
    const checks = createStudioAccessChecks({ signal: owner.signal, isCurrent: () => current, read, onValue, onError: vi.fn() });
    checks.request(); checks.request(); current = false; pending.resolve("old owner"); await settled(); checks.request();
    expect(read).toHaveBeenCalledTimes(1); expect(onValue).not.toHaveBeenCalled(); checks.stop();
  });
  it("allows a checked revocation to stop the queued follow-up before any more reads", async () => {
    const owner = new AbortController(), pending = deferred<{ read: boolean }>(), read = vi.fn<(signal: AbortSignal) => Promise<{ read: boolean }>>(() => pending.promise), revoked = vi.fn();
    const checks = createStudioAccessChecks({ signal: owner.signal, isCurrent: () => true, read,
      onValue: value => { if (!value.read) { revoked(); checks.stop(); } }, onError: vi.fn() });
    checks.request(); checks.request(); pending.resolve({ read: false }); await settled(); checks.request();
    expect(revoked).toHaveBeenCalledTimes(1); expect(read).toHaveBeenCalledTimes(1);
  });
  it("reports a read deadline while retaining one trailing check and clears its timer on stop", async () => {
    vi.useFakeTimers();
    const owner = new AbortController(), onError = vi.fn();
    const read = vi.fn<(signal: AbortSignal) => Promise<string>>(signal => { const pending = deferred<string>(); signal.addEventListener("abort", () => pending.reject(signal.reason), { once: true }); return pending.promise; });
    const checks = createStudioAccessChecks({ signal: owner.signal, isCurrent: () => true, read, onValue: vi.fn(), onError });
    checks.request(); checks.request(); await vi.advanceTimersByTimeAsync(20_000);
    expect(onError).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ name: "TimeoutError" })); expect(read).toHaveBeenCalledTimes(2);
    checks.stop(); expect(vi.getTimerCount()).toBe(0); await settled(); expect(onError).toHaveBeenCalledTimes(1);
  });
});
