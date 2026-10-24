/** Trusted, persisted execution evidence; never an authorization decision. */
export type PaidRequestRecoveryEvidence = Readonly<{
  submissionState?: "not_submitted" | "submitted" | "received";
  hasResponseReceipt: boolean;
  hasResponseCheckpoint: boolean;
  provenNotSubmitted?: boolean;
}>;

export type PaidRequestRecovery =
  | { action: "submit"; reservation: "release"; reason: "not_submitted" }
  | { action: "reuse_response"; reservation: "retain"; reason: "response_checkpoint" }
  | { action: "reconcile"; reservation: "retain"; reason: "response_uncheckpointed" | "submission_unknown" };

/** Checkpoint validity, current permissions and retry limits remain the caller's responsibility. */
export function assessPaidRequestRecovery(evidence: PaidRequestRecoveryEvidence): PaidRequestRecovery {
  if (evidence.hasResponseCheckpoint)
    return { action: "reuse_response", reservation: "retain", reason: "response_checkpoint" };
  if (evidence.hasResponseReceipt || evidence.submissionState === "received")
    return { action: "reconcile", reservation: "retain", reason: "response_uncheckpointed" };
  if (evidence.submissionState === "not_submitted" || evidence.provenNotSubmitted)
    return { action: "submit", reservation: "release", reason: "not_submitted" };
  return { action: "reconcile", reservation: "retain", reason: "submission_unknown" };
}
