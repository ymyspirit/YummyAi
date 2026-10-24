import assert from "node:assert/strict";
import test from "node:test";
import { nativeV4IsolationFlags } from "../testing/require-agent-native-v4-environment.mjs";
import { requireShipmentCreateEnvironment } from "../testing/require-shipment-create-environment.mjs";

const nonce="0c7e35a1000000000000000000000001";
const isolated=()=>({...Object.fromEntries(nativeV4IsolationFlags.map(key=>[key,"1"])),E2E_SHIPMENT_CREATE_ISOLATED:"1",
  DATABASE_URL:`postgresql://synthetic:synthetic@127.0.0.1/order_daily_e2e_${nonce}`,
  E2E_LEGACY_SCHEMA_TARGET:"current",S3_PRIVATE_BUCKET:`order-daily-e2e-${nonce}`,
  E2E_DISPOSABLE_REDIS_URL:"redis://127.0.0.1:26379",REDIS_URL:"redis://127.0.0.1:26379",
  E2E_DISPOSABLE_REDIS_CONTAINER:`yummyai-daily-${nonce}`});
test("partial shipment tests cannot enter any ordinary, partial or unflagged resource set",()=>{
  const result=requireShipmentCreateEnvironment(isolated()); assert.equal(result.nonce,nonce);
  assert.match(result.lane.replaceAll("\\","/"),/\/tmp\/shipment-create-20261023-0c7e35a1\/qa\/?$/);
  for(const flag of [...nativeV4IsolationFlags,"E2E_SHIPMENT_CREATE_ISOLATED"]){const environment=isolated();delete environment[flag];assert.throws(()=>requireShipmentCreateEnvironment(environment),undefined,flag);}
  for(const changed of [{DATABASE_URL:"postgresql://synthetic:synthetic@127.0.0.1/yummyai"},{S3_PRIVATE_BUCKET:"ordinary-private"},
    {REDIS_URL:"redis://127.0.0.1:6379"},{E2E_LEGACY_SCHEMA_TARGET:"pre-0187"}])
    assert.throws(()=>requireShipmentCreateEnvironment({...isolated(),...changed}));
  assert.throws(()=>requireShipmentCreateEnvironment(isolated(),"pre-0187"));
});
test("partial shipment browser tests require a compiled personal candidate and dedicated loopback API",()=>{
  assert.throws(()=>requireShipmentCreateEnvironment(isolated(),"current",true));
  const environment={...isolated(),E2E_COMPILED_WEB:"1",WEB_AUTH_MODE:"personal",API_BASE_URL:"http://localhost:8130",ERP_FIXTURE_ACTORS:"synthetic-fixture-metadata"};
  assert.equal(requireShipmentCreateEnvironment(environment,"current",true).nonce,nonce);
  for(const changed of [{WEB_AUTH_MODE:"demo"},{API_BASE_URL:"http://localhost:8000"},{ERP_FIXTURE_ACTORS:""}])
    assert.throws(()=>requireShipmentCreateEnvironment({...environment,...changed},"current",true));
});
