import { describe, expect, it } from "vitest";
import { assertAssistInputAuthority, AssistInputChangedError } from "@yummyai/database";
import type { AssistInputAuthority } from "@yummyai/contracts/ai/assist";

function snapshot(
  resources: AssistInputAuthority["resources"],
  fingerprint = "a".repeat(64),
): AssistInputAuthority {
  return {
    version: "assist-input-authority-v1",
    capturedAt: "2026-10-16T00:00:00.000Z",
    fingerprint,
    resources,
  };
}
const order = { key: "order.current", required: true, count: 1, checksum: "1".repeat(64) };
const knowledge = { key: "knowledge.pinned.0", required: true, count: 1, checksum: "2".repeat(64) };
describe("trusted assist dependency comparison", () => {
  it("admits newly resolved knowledge pins while still rejecting changed business dependencies", () => {
    const before = snapshot([order]),
      after = snapshot([order, knowledge], "b".repeat(64));
    expect(() => assertAssistInputAuthority(before, after, { admission: true })).not.toThrow();
    expect(() =>
      assertAssistInputAuthority(
        before,
        snapshot([{ ...order, checksum: "3".repeat(64) }, knowledge]),
        { admission: true },
      ),
    ).toThrow(AssistInputChangedError);
  });
  it("requires the complete pinned graph at execution and ignores only the audit clock", () => {
    const before = snapshot([order, knowledge]);
    expect(() =>
      assertAssistInputAuthority(before, { ...before, capturedAt: "2026-10-16T01:00:00.000Z" }),
    ).not.toThrow();
    expect(() =>
      assertAssistInputAuthority(
        before,
        snapshot([order, { ...knowledge, checksum: "4".repeat(64) }]),
      ),
    ).toThrow(AssistInputChangedError);
    expect(() =>
      assertAssistInputAuthority(before, snapshot([order, knowledge], "b".repeat(64))),
    ).toThrow(AssistInputChangedError);
  });
  it("fails closed for an unavailable mandatory resource even if both graphs contain it", () => {
    const unavailable = snapshot([{ ...knowledge, count: 0 }]);
    expect(() => assertAssistInputAuthority(unavailable, unavailable)).toThrow(
      AssistInputChangedError,
    );
    expect(() => assertAssistInputAuthority(unavailable, unavailable, { admission: true })).toThrow(
      AssistInputChangedError,
    );
  });
});
