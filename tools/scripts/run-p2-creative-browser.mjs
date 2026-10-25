import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import path from "node:path";
import process from "node:process";
import { captureRuntimeSource } from "./database-upgrade.mts";
import { buildLocalWebCandidate, verifyLocalWebCandidate } from "./local-web-candidate.mjs";
import { buildCanvasRuntime } from "./build-canvas-runtime.mjs";
import { sealStudioRuntime } from "./studio-runtime-artifact.mjs";

const root=fileURLToPath(new URL("../../",import.meta.url));
const require=createRequire(import.meta.url);
if(process.argv.length!==2)throw Error("P2_BROWSER_NO_ARGUMENTS_ALLOWED");
// One immutable build is shared by all three isolated browser suites. Each suite
// still owns and tears down its own DB, bucket, Redis and identity processes.
const source=await captureRuntimeSource(root),id=randomUUID().replaceAll("-","");
await mkdir(path.join(root,"apps/web/public"),{recursive:true});
const built=await buildLocalWebCandidate(root,id,source);
await buildCanvasRuntime();const studio=await sealStudioRuntime(root);
const run=async suite=>{
  const code=await new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,["--env-file=.env","--import",pathToFileURL(path.join(root,"apps/api/node_modules/tsx/dist/loader.mjs")).href,
      path.join(root,"tools/scripts/run-order-daily-acceptance.mts"),`--suite=${suite}`,"--compiled-web",`--candidate=${id}`],{
      cwd:root,env:{...process.env,E2E_STUDIO_RUNTIME_MANIFEST:studio.manifestPath,NODE_OPTIONS:"",TSX_DISABLE_CACHE:"1",
        TSX_TSCONFIG_PATH:path.join(root,"apps/api/tsconfig.json")},stdio:"inherit",windowsHide:true});
    child.once("error",reject);child.once("exit",code=>resolve(code));
  });
  if(code!==0)throw Error(`P2_BROWSER_SUITE_FAILED:${suite}`);
  const current=await verifyLocalWebCandidate(root,id);
  if(current.manifest.buildId!==built.manifest.buildId||current.manifest.sourceSha256!==source.sha256)throw Error("P2_BROWSER_CANDIDATE_CHANGED");
};
await run("creative-response-adoption-browser");await run("studio-paid-image-browser");await run("creative-owner-response-adoption-browser");
const output=path.join(root,"output/p2-creative-browser");await mkdir(output,{recursive:true});
await writeFile(path.join(output,"conclusion.json"),JSON.stringify({version:1,candidate:id,buildId:built.manifest.buildId,
  sourceSha256:source.sha256,studioBundleId:studio.id,suites:["creative-response-adoption-browser","studio-paid-image-browser","creative-owner-response-adoption-browser"],
  compiled:true,passed:true,realPaidCalls:0,ordinaryWorkerStarted:false,driverVersion:require("@playwright/test/package.json").version},null,2)+"\n",{flag:"wx"});
