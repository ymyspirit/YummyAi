import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { requireNativeV2Environment } from "../../tools/testing/require-agent-native-v2-environment.mjs";
import base from "./playwright.product-access.config";
requireNativeV2Environment(process.env, "current", true);
const servers = Array.isArray(base.webServer) ? base.webServer : [];
export default defineConfig({ ...base, testMatch:"agent-native-v2.spec.ts",grep:undefined,workers:1,fullyParallel:false,retries:0,timeout:300_000,
  use:{...base.use,baseURL:"http://localhost:3130",trace:"off",video:"off",screenshot:"off"},
  webServer:servers.map(server=>({...server,env:{...server.env,NODE_OPTIONS:"",TSX_DISABLE_CACHE:"1",
    TSX_TSCONFIG_PATH:String(server.url).includes(":8130")?fileURLToPath(new URL("../api/tsconfig.json",import.meta.url)):""}})),
  outputDir:fileURLToPath(new URL("../../tmp/agent-native-v2-20261022-5c82e6b4/qa/browser",import.meta.url)),
});
