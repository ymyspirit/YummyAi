import { defineConfig } from "@playwright/test";
import { requireStudioPersonalEnvironment } from "../../tools/testing/require-studio-personal-environment.mjs";
import base from "./playwright.creative-studio-personal.config.js";

const isolated = requireStudioPersonalEnvironment(process.env, true);
if (process.env.E2E_STUDIO_CONFIGURATION_ISOLATED !== "1")
  throw new Error("Studio configuration browser requires its dedicated isolated runner");
const servers = Array.isArray(base.webServer) ? base.webServer : [];

export default defineConfig({
  ...base,
  testMatch: ["creative-studio-configuration.spec.ts", "content-project-personal-auth.spec.ts"],
  grep: undefined,
  workers: 1,
  fullyParallel: false,
  retries: 0,
  webServer: servers.map(server => ({ ...server, env: { ...server.env, E2E_STUDIO_CONFIGURATION_ISOLATED: "1" } })),
  metadata: {
    ...base.metadata,
    isolatedNonce: isolated.nonce,
    scope: "compiled_personal_configuration_and_content_project_read",
    configurationHttpBoundary: "synthetic_fixture",
    assistModelsHttpBoundary: "synthetic_fixture",
    contentProjectsHttpBoundary: "real_personal_bff_and_api",
    paidExecutionExercised: false,
    realPaidCalls: 0,
  },
});
