import { defineConfig } from "@playwright/test";
import methods from "./playwright.methods.config";
const servers = Array.isArray(methods.webServer) ? methods.webServer : [];
export default defineConfig({
  ...methods,
  timeout: 180_000,
  workers: 1,
  testMatch: ["execution-methods.spec.ts", "methods.spec.ts", "workflow-operator.spec.ts"],
  outputDir: "../../tmp/execution-methods-e2e",
  webServer: servers.map(server=>({...server,env:{...server.env,WORKFLOW_CENTER_TENANT_IDS:"*",POD_ENABLED_TOOLS:"pattern_crop",POD_PROCESSOR_DEPLOYMENT_ID:"synthetic-method-browser",POD_PROCESSOR_URL:"https://synthetic.invalid/pod",POD_PROCESSOR_API_KEY:"synthetic-fixture-only"}})),
});
