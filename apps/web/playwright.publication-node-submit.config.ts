import {defineConfig} from "@playwright/test";
import {fileURLToPath} from "node:url";
import {requirePublicationNodeSubmitEnvironment} from "../../tools/testing/publication-node-submit-environment.mjs";
import base from "./playwright.product-access.config";
requirePublicationNodeSubmitEnvironment(process.env,"current",true);
const root=fileURLToPath(new URL("../../",import.meta.url)),servers=Array.isArray(base.webServer)?base.webServer:[];
export default defineConfig({...base,testMatch:"publication-node-submit.spec.ts",grep:undefined,workers:1,fullyParallel:false,retries:0,timeout:180000,
 use:{...base.use,viewport:{width:1440,height:960},baseURL:"http://localhost:3130",trace:"off",video:"off",screenshot:"off"},
 webServer:servers.map(server=>String(server.url).includes(":8130")?{...server,cwd:root,url:"http://127.0.0.1:8130/__publication_node_submit_fixture_ready",
  command:`node --import "${new URL("../api/node_modules/tsx/dist/loader.mjs",import.meta.url).href}" "${fileURLToPath(new URL("../api/src/marketplaces/publication-node-submit-browser.test-fixture.ts",import.meta.url))}" --publication-node-submit-api`,
  env:{...server.env,NODE_OPTIONS:"",TSX_DISABLE_CACHE:"1",TSX_TSCONFIG_PATH:fileURLToPath(new URL("../api/tsconfig.json",import.meta.url))}}:server),
 outputDir:fileURLToPath(new URL("../../tmp/publication-node-submit-20261023-74c2e8b1/qa/browser",import.meta.url))});
