import { defineConfig } from "@playwright/test";
import { requireStudioPersonalEnvironment } from "../../tools/testing/require-studio-personal-environment.mjs";
import base from "./playwright.creative-studio-personal.config.js";

const isolated = requireStudioPersonalEnvironment(process.env, true);
if (process.env.E2E_STUDIO_CONFIGURATION_ISOLATED !== "1")
  throw new Error("Studio configuration browser requires its dedicated isolated runner");
const servers = Array.isArray(base.webServer) ? base.webServer : [];

export default defineConfig({
  ...base,
  testMatch: "creative-studio-configuration.spec.ts",
  grep: undefined,
  workers: 1,
  fullyParallel: false,
  retries: 0,
  webServer: servers.map(server => ({ ...server, env: { ...server.env, E2E_STUDIO_CONFIGURATION_ISOLATED: "1" } })),
  metadata: {
    ...base.metadata,
    isolatedNonce: isolated.nonce,
    scope: "compiled_personal_studio_configuration_http_fixtures",
    configurationHttpBoundary: "synthetic_fixture",
    assistModelsHttpBoundary: "synthetic_fixture",
    paidExecutionExercised: false,
    realPaidCalls: 0,
  },
});
