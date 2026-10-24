import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath, URL } from "node:url";
import { nativeV4IsolationFlags, requireAgentNativeV4Environment } from "../testing/require-agent-native-v4-environment.mjs";

const nonce="e7c41a92000000000000000000000001";
const isolated=()=>({...Object.fromEntries(nativeV4IsolationFlags.map(key=>[key,"1"])),
  DATABASE_URL:`postgresql://synthetic:synthetic@127.0.0.1/order_daily_e2e_${nonce}`,
  E2E_LEGACY_SCHEMA_TARGET:"current",S3_PRIVATE_BUCKET:`order-daily-e2e-${nonce}`,
  E2E_DISPOSABLE_REDIS_URL:"redis://127.0.0.1:26379",REDIS_URL:"redis://127.0.0.1:26379",
  E2E_DISPOSABLE_REDIS_CONTAINER:`yummyai-daily-${nonce}`});

test("native v4 admits only one exact isolated resource identity before a client can be created",()=>{
  const environment=isolated(),result=requireAgentNativeV4Environment(environment);
  assert.equal(result.nonce,nonce);assert.equal(result.name,`order_daily_e2e_${nonce}`);assert.equal(result.url,environment.DATABASE_URL);
  assert.match(result.lane.replaceAll("\\","/"),/\/tmp\/agent-native-v4-20261023-e7c41a92\/qa\/?$/);
  assert.deepEqual(environment,isolated());
});
test("native v4 refuses every missing gate and ordinary or mismatched resources without making connections",()=>{
  for(const flag of nativeV4IsolationFlags){const environment=isolated();delete environment[flag];assert.throws(()=>requireAgentNativeV4Environment(environment),undefined,flag);}
  for(const changed of [
    {DATABASE_URL:"postgresql://synthetic:synthetic@127.0.0.1/yummyai"},
    {DATABASE_URL:`postgresql://synthetic:synthetic@remote.invalid/order_daily_e2e_${nonce}`},
    {S3_PRIVATE_BUCKET:"ordinary-private"},{E2E_DISPOSABLE_REDIS_CONTAINER:"infra-redis-1"},
    {REDIS_URL:"redis://127.0.0.1:6379"},{REDIS_URL:"redis://remote.invalid:26379",E2E_DISPOSABLE_REDIS_URL:"redis://remote.invalid:26379"},
    {E2E_LEGACY_SCHEMA_TARGET:"pre-0187"},
  ])assert.throws(()=>requireAgentNativeV4Environment({...isolated(),...changed}));
  assert.throws(()=>requireAgentNativeV4Environment(isolated(),"pre-0187"));
});
test("native v4 browser gate requires compiled personal auth and the dedicated loopback API",()=>{
  assert.throws(()=>requireAgentNativeV4Environment(isolated(),"current",true));
  const environment={...isolated(),E2E_COMPILED_WEB:"1",WEB_AUTH_MODE:"personal",API_BASE_URL:"http://127.0.0.1:8130",ERP_FIXTURE_ACTORS:"synthetic-fixture-metadata"};
  assert.equal(requireAgentNativeV4Environment(environment,"current",true).nonce,nonce);
  for(const changed of [{WEB_AUTH_MODE:"demo"},{API_BASE_URL:"http://127.0.0.1:8000"},{API_BASE_URL:"https://remote.invalid:8130"}])
    assert.throws(()=>requireAgentNativeV4Environment({...environment,...changed},"current",true));
});

test("native v4 legacy admission requires its explicit schema branch and exact retained original186 graph",()=>{
  const source=fileURLToPath(new URL("../../.artifacts/ordinary-api-source-186-d6b2f901-r9",import.meta.url));
  const environment={...isolated(),E2E_LEGACY_SCHEMA_TARGET:"pre-0187",E2E_AGENT_NATIVE_V4_UPGRADE_ISOLATED:"1",E2E_AGENT_NATIVE_V4_LEGACY_SOURCE:source};
  assert.equal(requireAgentNativeV4Environment(environment,"pre-0187").nonce,nonce);
  assert.equal(environment.E2E_LEGACY_SCHEMA_TARGET,"pre-0187");
  assert.throws(()=>requireAgentNativeV4Environment(environment));
  assert.throws(()=>requireAgentNativeV4Environment(environment,"pre-0187",true));
  for(const changed of [{E2E_AGENT_NATIVE_V4_UPGRADE_ISOLATED:"0"},{E2E_AGENT_NATIVE_V4_LEGACY_SOURCE:".artifacts/ordinary-api-source-186-d6b2f901-r9"},
    {E2E_AGENT_NATIVE_V4_LEGACY_SOURCE:source+"-replacement"},{E2E_LEGACY_SCHEMA_TARGET:"current"}])
    assert.throws(()=>requireAgentNativeV4Environment({...environment,...changed},"pre-0187"));
});
