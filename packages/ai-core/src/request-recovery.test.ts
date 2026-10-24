import { describe, expect, it } from "vitest";
import { assessPaidRequestRecovery, type PaidRequestRecoveryEvidence } from "./request-recovery.js";

const unknown: PaidRequestRecoveryEvidence = { hasResponseReceipt: false, hasResponseCheckpoint: false };

describe("paid request recovery", () => {
  it("does not treat missing submission evidence or a timeout as proof that a request was never sent", () => {
    expect(assessPaidRequestRecovery(unknown)).toMatchObject({ action: "reconcile", reservation: "retain", reason: "submission_unknown" });
    expect(assessPaidRequestRecovery({ ...unknown, submissionState: "submitted" })).toEqual(assessPaidRequestRecovery(unknown));
  });

  it("allows a new submission only with explicit evidence of no prior submission", () => {
    for (const evidence of [{ ...unknown, submissionState: "not_submitted" as const }, { ...unknown, provenNotSubmitted: true }])
      expect(assessPaidRequestRecovery(evidence)).toEqual({ action: "submit", reservation: "release", reason: "not_submitted" });
  });

  it("keeps receipt-only responses for reconciliation even when a caller claims the request was not sent", () => {
    expect(assessPaidRequestRecovery({ ...unknown, hasResponseReceipt: true, provenNotSubmitted: true, submissionState: "not_submitted" }))
      .toEqual({ action: "reconcile", reservation: "retain", reason: "response_uncheckpointed" });
    expect(assessPaidRequestRecovery({ ...unknown, submissionState: "received" }).action).toBe("reconcile");
  });

  it("reuses a persisted response and retains billing evidence across every submission marker", () => {
    for (const submissionState of [undefined, "not_submitted", "submitted", "received"] as const)
      for (const hasResponseReceipt of [false, true])
        expect(assessPaidRequestRecovery({ submissionState, hasResponseReceipt, hasResponseCheckpoint: true, provenNotSubmitted: true }))
          .toEqual({ action: "reuse_response", reservation: "retain", reason: "response_checkpoint" });
  });
});
