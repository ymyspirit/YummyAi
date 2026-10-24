import assert from "node:assert/strict";
import test from "node:test";
import {requireAmazonPublicNodeEnvironment} from "./amazon-public-node-environment.mjs";
const nonce="1a2b3c4d5e6f78901234567890123456";
const valid=()=>({NODE_ENV:"test",E2E_ISOLATED_DAILY:"1",E2E_AMAZON_PUBLIC_NODE_ISOLATED:"1",E2E_PUBLICATION_NODE_PREVIEW_ISOLATED:"1",E2E_LEGACY_SCHEMA_TARGET:"current",
 DATABASE_URL:`postgres://fixture:fixture@127.0.0.1:5432/order_daily_e2e_${nonce}`,E2E_DISPOSABLE_DATABASE_URL:`postgres://fixture:fixture@127.0.0.1:5432/order_daily_e2e_${nonce}`,
 S3_PRIVATE_BUCKET:`order-daily-e2e-${nonce}`,REDIS_URL:"redis://127.0.0.1:56379",E2E_DISPOSABLE_REDIS_URL:"redis://127.0.0.1:56379",E2E_DISPOSABLE_REDIS_CONTAINER:`yummyai-daily-${nonce}`});
test("public node rejects missing isolation and operational databases before connection",()=>{
 for(const key of ["E2E_AMAZON_PUBLIC_NODE_ISOLATED","E2E_PUBLICATION_NODE_PREVIEW_ISOLATED","E2E_ISOLATED_DAILY"]){const env=valid();delete env[key];assert.throws(()=>requireAmazonPublicNodeEnvironment(env));}
 const env=valid();env.DATABASE_URL="postgres://fixture:fixture@127.0.0.1:5432/yummyai";assert.throws(()=>requireAmazonPublicNodeEnvironment(env));
});
test("public node rejects resource nonce mismatch and every noncurrent schema",()=>{
 for(const [key,value] of [["S3_PRIVATE_BUCKET","ordinary"],["E2E_DISPOSABLE_REDIS_CONTAINER","yummyai-daily-00000000000000000000000000000000"],["E2E_LEGACY_SCHEMA_TARGET","pre-0182"],["REDIS_URL","redis://127.0.0.1:6379"]])assert.throws(()=>requireAmazonPublicNodeEnvironment({...valid(),[key]:value}));
 const value=requireAmazonPublicNodeEnvironment(valid());assert.equal(value.nonce,nonce);assert.match(value.lane,/amazon-public-node-20261023-3d7f9a21[\\/]qa$/);
});
test("public node browser requires actual compiled personal runtime",()=>{
 assert.throws(()=>requireAmazonPublicNodeEnvironment(valid(),true));
 const env={...valid(),E2E_COMPILED_WEB:"1",WEB_AUTH_MODE:"personal",API_BASE_URL:"http://127.0.0.1:8130",ERP_FIXTURE_ACTORS:"owned-fixture-actors"};
 assert.equal(requireAmazonPublicNodeEnvironment(env,true).nonce,nonce);
 for(const [key,value] of [["WEB_AUTH_MODE","demo"],["API_BASE_URL","http://127.0.0.1:8000"],["E2E_COMPILED_WEB","0"]])assert.throws(()=>requireAmazonPublicNodeEnvironment({...env,[key]:value},true));
});
