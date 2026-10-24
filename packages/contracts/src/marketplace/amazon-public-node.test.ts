import {describe,expect,it} from "vitest";
import {StoreNodeExecutionClaimInputSchema,StoreNodeExecutionCredentialSchema,StoreNodeExecutionErrorSchema,STORE_NODE_EXECUTION_OPERATION,STORE_NODE_EXECUTION_PROTOCOL} from "./store-node-execution.js";
const id="019f0000-0000-7000-8000-000000000001",digest="1".repeat(64);
const seed=()=>({account:{authorizationMode:"amazon_private",externalAccountId:"seller",grantedScopes:["product-listing"],marketplaceIds:["ATVPDKIKX0DER"],platform:"amazon",region:"NA"},
 credential:{kind:"amazon_private",clientId:"original-app",refreshToken:"synthetic-refresh"},etsyAppKeySha256:null});
const publicSeed=()=>{const value=seed();value.account.authorizationMode="amazon_public";value.credential.kind="amazon_public";return {...value,amazonAppClientIdSha256:digest};};
describe("public Amazon node wire compatibility",()=>{
 it("keeps legacy private and Etsy seeds without manufacturing a public application pin",()=>{
  const privateSeed=StoreNodeExecutionCredentialSchema.parse(seed());expect(privateSeed).not.toHaveProperty("amazonAppClientIdSha256");
  const etsy=seed();etsy.account.authorizationMode="etsy_oauth";etsy.account.platform="etsy";etsy.account.region="GLOBAL";etsy.credential.kind="etsy_oauth";
  expect(StoreNodeExecutionCredentialSchema.parse(etsy)).not.toHaveProperty("amazonAppClientIdSha256");
 });
 it("requires the original public credential kind clientId and explicit digest",()=>{
  expect(StoreNodeExecutionCredentialSchema.safeParse(publicSeed()).success).toBe(true);
  const missing=publicSeed();delete (missing as Partial<typeof missing>).amazonAppClientIdSha256;expect(StoreNodeExecutionCredentialSchema.safeParse(missing).success).toBe(false);
  for(const change of [{clientId:""},{clientId:" "},{kind:"amazon_private"}]){const value=publicSeed();Object.assign(value.credential,change);expect(StoreNodeExecutionCredentialSchema.safeParse(value).success).toBe(false);}
  const foreign=publicSeed();foreign.account.platform="etsy";expect(StoreNodeExecutionCredentialSchema.safeParse(foreign).success).toBe(false);
  expect(StoreNodeExecutionCredentialSchema.safeParse({...publicSeed(),amazonAppClientIdSha256:"bad"}).success).toBe(false);
 });
 it("allows explicit public support while preserving old claim defaults and rejecting unknown modes",()=>{
  const claim={protocol:STORE_NODE_EXECUTION_PROTOCOL,nodeId:id,certificateGeneration:1,sessionId:id,supportedAuthorizationModes:["amazon_private","amazon_public","etsy_oauth"]};
  expect(StoreNodeExecutionClaimInputSchema.parse(claim).supportedOperations).toEqual([STORE_NODE_EXECUTION_OPERATION]);
  expect(StoreNodeExecutionClaimInputSchema.safeParse({...claim,supportedAuthorizationModes:["amazon_private","etsy_oauth"]}).success).toBe(true);
  expect(StoreNodeExecutionClaimInputSchema.safeParse({...claim,supportedAuthorizationModes:["untrusted_mode"]}).success).toBe(false);
 });
 it("keeps reauthorization a finite application error rather than a personal identity code",()=>{
  expect(StoreNodeExecutionErrorSchema.parse("store_node_application_reauthorization_required")).toBe("store_node_application_reauthorization_required");
  expect(StoreNodeExecutionErrorSchema.safeParse("arbitrary_upstream_secret").success).toBe(false);
 });
});
