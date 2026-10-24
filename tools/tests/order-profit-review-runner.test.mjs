import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import { promisify } from "node:util";
import test from "node:test";

const root=fileURLToPath(new URL("../../",import.meta.url));
const loader=new URL("../../apps/api/node_modules/tsx/dist/loader.mjs",import.meta.url).href;
const configuration=new URL("../../apps/web/playwright.order-profit-review.config.ts",import.meta.url).href;
const token="b".repeat(32);
const valid={E2E_ISOLATED_DAILY:"1",E2E_ORDER_PROFIT_REVIEW_ISOLATED:"1",WEB_AUTH_MODE:"personal",
  API_BASE_URL:"http://127.0.0.1:8130",DATABASE_URL:`postgres://unused:unused@127.0.0.1/order_daily_e2e_${token}`,
  S3_PRIVATE_BUCKET:`order-daily-e2e-${token}`,YUMMYAI_TEST_CACHE_DIR:"D:/YummyAI/tmp/synthetic-config-only",
  NODE_OPTIONS:`--import "${loader}"`,TSX_TSCONFIG_PATH:fileURLToPath(new URL("../../apps/api/tsconfig.json",import.meta.url)),TSX_DISABLE_CACHE:"1"};
const probe=`try { const {default:config}=await import(${JSON.stringify(configuration)}); process.stdout.write(JSON.stringify({accepted:true,
  match:config.testMatch,workers:config.workers,external:config.build.external,
  baseURL:config.use.baseURL,servers:config.webServer.map(server=>({url:server.url,reuse:server.reuseExistingServer,
    nodeOptions:server.env.NODE_OPTIONS,tsx:server.env.TSX_TSCONFIG_PATH,auth:server.env.WEB_AUTH_MODE,origin:server.env.WEB_ORIGIN,
    demo:[server.env.DASHBOARD_DEMO_MODE,server.env.ANALYSIS_DEMO_MODE,server.env.PRODUCT_DEMO_MODE,server.env.DESIGN_DEMO_MODE,server.env.LISTING_DEMO_MODE]}))}));
} catch { process.stdout.write(JSON.stringify({accepted:false})); }`;
async function inspect(overrides={}) {
  const {stdout}=await promisify(execFile)(process.execPath,["--import",loader,"--input-type=module","-e",probe],
    {cwd:root,env:{...process.env,...valid,...overrides},windowsHide:true,timeout:15_000,maxBuffer:256*1024});
  return JSON.parse(stdout);
}
test("personal order review selects one real route and removes the fixture loader from application servers",async()=>{
  const result=await inspect();assert.equal(result.accepted,true);assert.deepEqual(result.match,["order-profit-review.spec.ts"]);
  assert.equal(result.baseURL,"http://localhost:3130");assert.equal(result.workers,1);assert.deepEqual(result.external,["**/apps/api/**"]);
  assert.equal(result.servers.length,2);
  for(const server of result.servers){assert.equal(server.reuse,false);assert.equal(server.nodeOptions,"");assert.equal(server.tsx,"");
    assert.equal(server.auth,"personal");assert.equal(server.origin,"http://localhost:3130");assert.deepEqual(server.demo,["0","0","0","0","0"]);}
});
for(const [name,overrides] of [
  ["missing suite isolation",{E2E_ORDER_PROFIT_REVIEW_ISOLATED:"0"}],
  ["missing disposable boundary",{E2E_ISOLATED_DAILY:"0"}],
  ["ordinary database",{DATABASE_URL:"postgres://unused:unused@127.0.0.1/yummyai"}],
  ["mismatched private bucket",{S3_PRIVATE_BUCKET:`order-daily-e2e-${"c".repeat(32)}`}],
  ["service identity",{WEB_AUTH_MODE:"local-service"}],
  ["ordinary API",{API_BASE_URL:"http://127.0.0.1:8000"}],
  ["missing owned outputs",{YUMMYAI_TEST_CACHE_DIR:""}],
]) test(`personal order review rejects ${name} before any connection`,async()=>assert.equal((await inspect(overrides)).accepted,false));
