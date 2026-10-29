import process from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { requireStudioPersonalEnvironment } from "./require-studio-personal-environment.mjs";
import { currentSchemaVersion } from "./current-schema.mjs";

function requirePrivateLoopbackStorage(environment: NodeJS.ProcessEnv) {
  const endpoint = new URL(environment.S3_ENDPOINT || "https://invalid.invalid");
  if (!["http:", "https:"].includes(endpoint.protocol)
      || !["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname)
      || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== "/")
    throw new Error("studio_paid_image_loopback_private_storage_required");
}
function paidLane(environment: NodeJS.ProcessEnv, nonce: string) {
  const expected = fileURLToPath(new URL("../../tmp/order-daily-artifacts-" + nonce, import.meta.url));
  if (!environment.YUMMYAI_TEST_CACHE_DIR || !path.isAbsolute(environment.YUMMYAI_TEST_CACHE_DIR)
      || environment.YUMMYAI_TEST_CACHE_DIR !== expected)
    throw new Error("studio_paid_image_exact_runner_output_required");
  return expected;
}

/** This family owns only its current-schema nonce DB, bucket, Redis and output. */
export function requireStudioPaidImageEnvironment(environment = process.env, browser = false) {
  const isolated = requireStudioPersonalEnvironment(environment, browser);
  if (environment.E2E_STUDIO_PAID_IMAGE_ISOLATED !== "1" || environment.DATABASE_POOL_SIZE !== "1")
    throw new Error("studio_paid_image_explicit_isolation_required");
  requirePrivateLoopbackStorage(environment);
  return { ...isolated, schema: currentSchemaVersion(),
    lane: paidLane(environment, isolated.nonce) };
}

/** Legacy owner reads use nested transactions and require a second connection.
 * This permission belongs only to a separate disposable regression family. */
export function requireStudioPaidImageLegacyEnvironment(environment = process.env) {
  const isolated = requireStudioPersonalEnvironment(environment);
  if (environment.E2E_STUDIO_PAID_IMAGE_ISOLATED !== "1" || environment.E2E_STUDIO_PAID_IMAGE_LEGACY_ISOLATED !== "1"
      || environment.DATABASE_POOL_SIZE !== "2" || environment.STUDIO_PAID_IMAGE_ENABLED !== "0"
      || environment.STUDIO_PAID_IMAGE_TENANT_IDS !== "") throw new Error("studio_paid_image_legacy_explicit_isolation_required");
  requirePrivateLoopbackStorage(environment);
  return { ...isolated, schema: currentSchemaVersion(), lane: paidLane(environment, isolated.nonce) };
}
