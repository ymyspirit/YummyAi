import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { requireDisposableIntegrationEnvironment } from "./require-disposable-integration.mjs";

/** Reject ordinary databases and mixed resource nonces before any connection. */
export function requireStudioPersonalEnvironment(environment = process.env, browser = false) {
  const url = new URL(requireDisposableIntegrationEnvironment(environment));
  const nonce = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(url.pathname)?.[1];
  const local = ["localhost", "127.0.0.1", "[::1]"];
  const redis = new URL(environment.E2E_DISPOSABLE_REDIS_URL || "https://invalid.invalid");
  if (!nonce || environment.YUMMYAI_STUDIO_PERSONAL_TEST_ISOLATION !== "1"
      || environment.E2E_LEGACY_SCHEMA_TARGET !== "current" || !local.includes(url.hostname)
      || environment.S3_PRIVATE_BUCKET !== `order-daily-e2e-${nonce}`
      || environment.REDIS_URL !== environment.E2E_DISPOSABLE_REDIS_URL
      || environment.E2E_DISPOSABLE_REDIS_CONTAINER !== `yummyai-daily-${nonce}`
      || !["redis:", "rediss:"].includes(redis.protocol) || !local.includes(redis.hostname)
      || Object.entries(environment).some(([key, value]) => key.startsWith("DEMO_") && value && value !== "0"))
    throw new Error("Studio personal requires current187 and exact disposable database bucket Redis nonce");
  if (browser) {
    const api = new URL(environment.API_BASE_URL || "https://invalid.invalid");
    const studio = new URL(environment.CANVAS_STUDIO_URL || "https://invalid.invalid");
    if (environment.E2E_COMPILED_WEB !== "1" || environment.WEB_AUTH_MODE !== "personal"
        || environment.CANVAS_STUDIO_PRODUCTION_ENABLED !== "1" || !environment.ERP_FIXTURE_ACTORS
        || !local.includes(api.hostname) || api.port !== "8130"
        || studio.origin !== "http://127.0.0.1:4316" || studio.pathname !== "/" || studio.search || studio.hash
        || !environment.E2E_STUDIO_RUNTIME_MANIFEST)
      throw new Error("Studio personal browser requires compiled personal API and sealed isolated runtime");
  }
  return { url: url.href, nonce, name: `order_daily_e2e_${nonce}`,
    lane: fileURLToPath(new URL("../../tmp/studio-personal-20261023-6e8c4a19/qa", import.meta.url)) };
}
