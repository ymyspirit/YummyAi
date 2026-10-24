import { describe, expect, it } from "vitest";
import { createProcurementWriteActivity, procurementCommandReadPath } from "./procurement-command-lifecycle";

describe("procurement command display and write lifetime", () => {
  it("releases a settled write even when its old display may no longer receive the result", async () => {
    const activity = createProcurementWriteActivity(), lease = activity.begin()!;
    let displayEpoch = 1, release!: (value: string) => void;
    const capturedEpoch = displayEpoch, shown: string[] = [];
    const response = new Promise<string>(resolve => { release = resolve; }).then(value => {
      if (capturedEpoch === displayEpoch) shown.push(value);
    }).finally(() => activity.settle(lease));
    displayEpoch++;
    expect(activity.begin()).toBeNull();
    release("original committed response"); await response;
    expect(shown).toEqual([]);
    expect(activity.busy).toBe(false);
    expect(activity.begin()).not.toBeNull();
  });

  it("does not let an old actor's late completion unlock the new actor's in-flight operation", () => {
    const activity = createProcurementWriteActivity(), old = activity.begin()!;
    activity.revoke();
    const current = activity.begin()!;
    activity.settle(old);
    expect(activity.busy).toBe(true);
    expect(activity.begin()).toBeNull();
    activity.settle(current);
    expect(activity.busy).toBe(false);
  });
});

describe("procurement original recovery queries", () => {
  const target = "019a0101-0000-7000-8000-000000000001", before = "019a0101-0000-7000-8000-000000000002";

  it("finds an older same-source original independently of fifty newer global records", () => {
    const request = new URL(procurementCommandReadPath({ kind: "supply_purchase_create", targetId: target }), "https://synthetic.invalid/");
    expect(request.searchParams.get("kind")).toBe("supply_purchase_create");
    expect(request.searchParams.get("targetId")).toBe(target);
    expect(request.searchParams.has("before")).toBe(false);
  });

  it("recovers root creates without sending a caller-selected or literal null target", () => {
    for (const kind of ["requisition_create", "purchase_create"] as const) {
      const request = new URL(procurementCommandReadPath({ kind, targetId: null }), "https://synthetic.invalid/");
      expect(request.searchParams.get("kind")).toBe(kind);
      expect(request.searchParams.has("targetId")).toBe(false);
    }
  });

  it("keeps the cursor and source scope together while leaving global recovery unfiltered", () => {
    const filtered = new URL(procurementCommandReadPath({ kind: "purchase_revise", targetId: target }, before), "https://synthetic.invalid/");
    expect(Object.fromEntries(filtered.searchParams)).toEqual({ kind: "purchase_revise", targetId: target, before });
    const global = new URL(procurementCommandReadPath(null, before), "https://synthetic.invalid/");
    expect(Object.fromEntries(global.searchParams)).toEqual({ before });
  });
});
