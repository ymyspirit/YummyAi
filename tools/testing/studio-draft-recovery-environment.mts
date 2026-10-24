import process from "node:process";
import { fileURLToPath } from "node:url";
import { requireStudioPersonalEnvironment } from "./require-studio-personal-environment.mjs";

/** A new owner-bound recovery family cannot inherit an earlier family's flag. */
export function requireStudioDraftRecoveryEnvironment(environment = process.env, browser = false) {
  const isolated = requireStudioPersonalEnvironment(environment, browser);
  if (environment.E2E_STUDIO_DRAFT_RECOVERY_ISOLATED !== "1")
    throw new Error("studio_draft_recovery_explicit_isolation_required");
  return { ...isolated, lane: fileURLToPath(new URL("../../tmp/studio-draft-recovery-20261024-f29c6a81/qa", import.meta.url)) };
}
