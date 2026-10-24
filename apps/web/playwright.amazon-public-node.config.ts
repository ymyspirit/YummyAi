import {defineConfig} from "@playwright/test";
import {fileURLToPath} from "node:url";
import {requireAmazonPublicNodeEnvironment} from "../../tools/testing/amazon-public-node-environment.mjs";
import base from "./playwright.product-access.config";
requireAmazonPublicNodeEnvironment(process.env,true);
const root=fileURLToPath(new URL("../../",import.meta.url)),servers=Array.isArray(base.webServer)?base.webServer:[];
export default defineConfig({...base,testMatch:"amazon-public-node.spec.ts",grep:undefined,workers:1,fullyParallel:false,retries:0,timeout:180000,
 use:{...base.use,baseURL:"http://localhost:3130",trace:"off",video:"off",screenshot:"off"},
 webServer:servers.map(server=>String(server.url).includes(":8130")?{...server,cwd:root,url:"http://127.0.0.1:8130/__amazon_public_node_fixture_ready",
 command:`node --import "${new URL("../api/node_modules/tsx/dist/loader.mjs",import.meta.url).href}" "${fileURLToPath(new URL("../api/src/marketplaces/amazon-public-node-browser.test-fixture.ts",import.meta.url))}" --amazon-public-node-api`,
 env:{...server.env,NODE_OPTIONS:"",TSX_DISABLE_CACHE:"1",TSX_TSCONFIG_PATH:fileURLToPath(new URL("../api/tsconfig.json",import.meta.url))}}:server),
 outputDir:fileURLToPath(new URL("../../tmp/amazon-public-node-20261023-3d7f9a21/qa/browser",import.meta.url))});
