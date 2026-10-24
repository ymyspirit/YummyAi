import assert from "node:assert/strict";
import test from "node:test";
import {advertisingRetentionEnvironment} from "../scripts/advertising-command-retention-runtime.mjs";
const local={DATABASE_URL:"postgresql://synthetic:synthetic@127.0.0.1:5432/synthetic",REDIS_URL:"redis://localhost:6379",S3_ENDPOINT:"http://127.0.0.1:9000"};
test("advertising privacy fixes one maintenance scheduler and zero consumers despite inherited all flags",()=>{
  const before={...local,NODE_ENV:"development",WORKER_QUEUES:"all",WORKER_SCHEDULERS:"all"},result=advertisingRetentionEnvironment(before);
  assert.equal(result.WORKER_QUEUES,"none");assert.equal(result.WORKER_SCHEDULERS,"advertisingCommandRetentionScheduler");assert.equal(result.NODE_ENV,"production");
  assert.equal(result.TSX_DISABLE_CACHE,"1");assert.equal(before.WORKER_QUEUES,"all");
});
test("advertising privacy rejects remote malformed infrastructure or execution arguments before loading a Worker",()=>{
  for(const name of Object.keys(local))for(const value of[undefined,"invalid",local[name].replace(/127\.0\.0\.1|localhost/,"foreign.invalid"),`${local[name]}?execute=1`,`${local[name]}#secret`])
    assert.throws(()=>advertisingRetentionEnvironment({...local,[name]:value}),{message:"LOCAL_ADVERTISING_RETENTION_CONFIGURATION_INVALID"});
  for(const args of[["--execute"],["--queues=all"],["--schedulers=all"]])assert.throws(()=>advertisingRetentionEnvironment(local,args));
});
test("advertising maintenance preserves isolated endpoints without adding an execution consumer",()=>{
  const result=advertisingRetentionEnvironment(local);for(const name of Object.keys(local))assert.equal(result[name],local[name]);
  assert.deepEqual(result.WORKER_SCHEDULERS.split(","),["advertisingCommandRetentionScheduler"]);
});
