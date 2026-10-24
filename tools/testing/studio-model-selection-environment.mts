import process from "node:process";
import { fileURLToPath } from "node:url";
import { requireStudioPersonalEnvironment } from "./require-studio-personal-environment.mjs";

/** The model-selection family never inherits admission from an earlier slice. */
export function requireStudioModelSelectionEnvironment(environment = process.env, browser = false) {
  const isolated = requireStudioPersonalEnvironment(environment, browser);
  if (environment.E2E_STUDIO_MODEL_SELECTION_ISOLATED !== "1") throw new Error("studio_model_fixture_explicit_isolation_required");
  return { ...isolated, lane: fileURLToPath(new URL("../../tmp/studio-model-selection-20261024-c5a8f4d1/qa", import.meta.url)) };
}
