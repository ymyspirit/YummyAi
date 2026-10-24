import {describe,expect,it} from "vitest";
import {createEntityId} from "../common/ids.js";
import {PublicationPreviewReadCheckInputSchema,publicationPreviewReadCheckInput} from "./publication-preview.js";

const listing={id:createEntityId(),versionId:createEntityId()};
describe("bodyless Publication current-object read checks",()=>{
 it("binds the original version and every distinct account from workspace and original receipts",()=>{
  const accounts=[createEntityId(),createEntityId(),createEntityId()].sort();
  expect(publicationPreviewReadCheckInput({listing,sources:[{accountId:accounts[1]!},{accountId:accounts[0]!.toUpperCase()}],recent:[{request:{accountId:accounts[1]!}},{request:{accountId:accounts[2]!}}]}))
   .toEqual({listingId:listing.id,listingVersionId:listing.versionId,accountIds:accounts.join(",")});
 });
 it("allows an empty current store projection without inventing an account",()=>{
  expect(publicationPreviewReadCheckInput({listing,sources:[],recent:[]})).toEqual({listingId:listing.id,listingVersionId:listing.versionId,accountIds:""});
 });
 it("rejects duplicates, noncanonical ordering, malformed identities and extra authority fields",()=>{
  const ids=[createEntityId(),createEntityId()].sort(),base={listingId:listing.id,listingVersionId:listing.versionId};
  for(const accountIds of [ids[0]+","+ids[0],[...ids].reverse().join(","),ids[0]!.toUpperCase(),ids[0]+",",ids[0]+"%2c"+ids[1],"not-an-id"])
   expect(PublicationPreviewReadCheckInputSchema.safeParse({...base,accountIds}).success).toBe(false);
  for(const extra of [{tenantId:createEntityId()},{permissions:["store:read"]},{requestChecksum:"a".repeat(64)}])
   expect(PublicationPreviewReadCheckInputSchema.safeParse({...base,accountIds:ids.join(","),...extra}).success).toBe(false);
 });
 it("covers the full bounded100-source20-receipt union and rejects the next identity",()=>{
  const ids=Array.from({length:121},()=>createEntityId()).sort(),base={listingId:listing.id,listingVersionId:listing.versionId};
  expect(PublicationPreviewReadCheckInputSchema.parse({...base,accountIds:ids.slice(0,120).join(",")})).toEqual({...base,accountIds:ids.slice(0,120).join(",")});
  expect(PublicationPreviewReadCheckInputSchema.safeParse({...base,accountIds:ids.join(",")}).success).toBe(false);
 });
});
