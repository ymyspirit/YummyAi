import process from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { requireStudioPersonalEnvironment } from "./require-studio-personal-environment.mjs";
import { requireDisposableIntegrationEnvironment } from "./require-disposable-integration.mjs";

/** Every branch rejects ordinary or mixed resources before creating a client. */
export function requireCreativeResponseAdoptionEnvironment(environment = process.env, browser = false) {
  if (environment.E2E_CREATIVE_RESPONSE_ADOPTION_ISOLATED !== "1" || environment.DATABASE_POOL_SIZE !== "1")
    throw new Error("creative_response_adoption_explicit_isolation_required");
  const upgrade = environment.E2E_CREATIVE_RESPONSE_ADOPTION_UPGRADE_ISOLATED === "1";
  let isolated: { url: string; nonce: string; name: string };
  if (upgrade) {
    if (browser || environment.E2E_LEGACY_SCHEMA_TARGET !== "189" || environment.YUMMYAI_STUDIO_PERSONAL_TEST_ISOLATION !== "1")
      throw new Error("creative_response_adoption_real189_upgrade_required");
    const url = new URL(requireDisposableIntegrationEnvironment(environment));
    const nonce = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(url.pathname)?.[1];
    const redis = new URL(environment.E2E_DISPOSABLE_REDIS_URL || "https://invalid.invalid");
    const local = ["localhost", "127.0.0.1", "[::1]"];
    if (!nonce || !local.includes(url.hostname) || environment.S3_PRIVATE_BUCKET !== `order-daily-e2e-${nonce}`
      || environment.REDIS_URL !== environment.E2E_DISPOSABLE_REDIS_URL || environment.E2E_DISPOSABLE_REDIS_CONTAINER !== `yummyai-daily-${nonce}`
      || !["redis:", "rediss:"].includes(redis.protocol) || !local.includes(redis.hostname)
      || Object.entries(environment).some(([key, value]) => key.startsWith("DEMO_") && value && value !== "0"))
      throw new Error("creative_response_adoption_exact_upgrade_nonce_required");
    isolated = { url: url.href, nonce, name: `order_daily_e2e_${nonce}` };
  } else {
    isolated = requireStudioPersonalEnvironment(environment, browser);
  }
  const lane = fileURLToPath(new URL("../../tmp/order-daily-artifacts-" + isolated.nonce, import.meta.url));
  if (!environment.YUMMYAI_TEST_CACHE_DIR || !path.isAbsolute(environment.YUMMYAI_TEST_CACHE_DIR)
      || environment.YUMMYAI_TEST_CACHE_DIR !== lane)
    throw new Error("creative_response_adoption_exact_runner_output_required");
  return { ...isolated, upgrade, schema: 192 as const, lane };
}
