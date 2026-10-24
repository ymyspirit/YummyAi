import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { requirePublicationNodePreviewEnvironment } from "./publication-node-preview-environment.mjs";

export const PUBLICATION_AUTHORITY_LANE = fileURLToPath(new URL("../../tmp/publication-authority-20261022-f3c8a2d6/qa", import.meta.url));
/** Pure preflight; importers must call this before opening any resource. */
export function requirePublicationAuthorityEnvironment(env = process.env, browser = false) {
  const isolated = requirePublicationNodePreviewEnvironment(env, "current", browser);
  if (env.E2E_PUBLICATION_AUTHORITY_ISOLATED !== "1" || env.E2E_LEGACY_SCHEMA_TARGET !== "current")
    throw new Error("Publication authority requires its current isolated resource family before connection");
  return { ...isolated, lane: PUBLICATION_AUTHORITY_LANE };
}
