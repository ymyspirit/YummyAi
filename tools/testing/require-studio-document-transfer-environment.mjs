import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { requireStudioPersonalEnvironment } from "./require-studio-personal-environment.mjs";

/** A new acceptance family inherits the real personal boundary before any DB,
 * S3 or Redis connection. The adopted ERP is never a transfer test fixture. */
export function requireStudioDocumentTransferEnvironment(environment = process.env, browser = false) {
  const isolated = requireStudioPersonalEnvironment(environment, browser);
  if (environment.E2E_STUDIO_DOCUMENT_TRANSFER_ISOLATED !== "1")
    throw new Error("Studio document transfer requires its explicit disposable current188 acceptance family");
  return { ...isolated, lane: fileURLToPath(new URL("../../tmp/studio-transfer-20261024-d8b42e71/qa", import.meta.url)) };
}
