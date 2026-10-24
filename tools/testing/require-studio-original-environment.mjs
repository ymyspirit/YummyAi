import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { requireStudioPersonalEnvironment } from "./require-studio-personal-environment.mjs";

/** Extend the exact existing disposable boundary; never admit the daily ERP. */
export function requireStudioOriginalEnvironment(environment = process.env, browser = false) {
  const isolated = requireStudioPersonalEnvironment(environment, browser);
  if (environment.E2E_STUDIO_ORIGINAL_ISOLATED !== "1")
    throw new Error("Studio original requires its explicit disposable acceptance family");
  return { ...isolated, lane: fileURLToPath(new URL("../../tmp/studio-original-20261024-c14d7a62/qa", import.meta.url)) };
}
