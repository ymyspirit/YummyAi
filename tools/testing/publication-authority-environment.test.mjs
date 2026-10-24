import assert from "node:assert/strict";
import { test } from "node:test";
import { requirePublicationAuthorityEnvironment, PUBLICATION_AUTHORITY_LANE } from "./publication-authority-environment.mjs";
const nonce="0123456789abcdef0123456789abcdef";
const valid=()=>({E2E_ISOLATED_DAILY:"1",E2E_PUBLICATION_NODE_PREVIEW_ISOLATED:"1",E2E_PUBLICATION_AUTHORITY_ISOLATED:"1",
 E2E_LEGACY_SCHEMA_TARGET:"current",DATABASE_URL:`postgres://app:synthetic@127.0.0.1:42830/order_daily_e2e_${nonce}`,
 REDIS_URL:"redis://127.0.0.1:55222",E2E_DISPOSABLE_REDIS_URL:"redis://127.0.0.1:55222",E2E_DISPOSABLE_REDIS_CONTAINER:`yummyai-daily-${nonce}`,S3_PRIVATE_BUCKET:`order-daily-e2e-${nonce}`});
test("current authority family returns only exact nonce resources and its own output lane",()=>{
 const result=requirePublicationAuthorityEnvironment(valid());assert.equal(result.nonce,nonce);assert.equal(result.lane,PUBLICATION_AUTHORITY_LANE);assert.match(result.lane,/publication-authority-20261022-f3c8a2d6/);
});
test("each missing family guard rejects before any resource constructor",()=>{
 for(const key of ["E2E_ISOLATED_DAILY","E2E_PUBLICATION_NODE_PREVIEW_ISOLATED","E2E_PUBLICATION_AUTHORITY_ISOLATED","DATABASE_URL","E2E_DISPOSABLE_REDIS_URL","E2E_DISPOSABLE_REDIS_CONTAINER","S3_PRIVATE_BUCKET"]){const env=valid();delete env[key];assert.throws(()=>requirePublicationAuthorityEnvironment(env));}
});
test("ordinary, foreign and mismatched resource identities are rejected",()=>{
 for(const change of [{E2E_LEGACY_SCHEMA_TARGET:"pre-0182"},{DATABASE_URL:"postgres://app:synthetic@127.0.0.1:42830/yummyai"},
  {S3_PRIVATE_BUCKET:"ordinary-private"},
  {E2E_DISPOSABLE_REDIS_CONTAINER:"yummyai-daily-ffffffffffffffffffffffffffffffff"},{REDIS_URL:"redis://127.0.0.1:55223"},
  {REDIS_URL:"redis://remote.invalid:55222",E2E_DISPOSABLE_REDIS_URL:"redis://remote.invalid:55222"}])assert.throws(()=>requirePublicationAuthorityEnvironment({...valid(),...change}));
});

test("browser family requires compiled personal Web and actual isolated API members",()=>{
 const env={...valid(),E2E_COMPILED_WEB:"1",WEB_AUTH_MODE:"personal",API_BASE_URL:"http://127.0.0.1:8130",ERP_FIXTURE_ACTORS:"runner-owned-actors"};
 assert.equal(requirePublicationAuthorityEnvironment(env,true).nonce,nonce);
 for(const change of [{E2E_COMPILED_WEB:"0"},{WEB_AUTH_MODE:"demo"},{API_BASE_URL:"http://127.0.0.1:3001"},{ERP_FIXTURE_ACTORS:""}])
  assert.throws(()=>requirePublicationAuthorityEnvironment({...env,...change},true));
});
