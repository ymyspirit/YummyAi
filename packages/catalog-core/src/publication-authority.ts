import {authorize,ForbiddenError,intersectPermissionContexts,Permission,type PermissionValue} from "@yummyai/authz";
import {TenantContextSchema,type TenantContext} from "@yummyai/contracts";
import {listingVersions,loadCurrentMembershipContext,marketplaceAccounts,marketplacePublicationIntents,
  marketplacePublicationRequests,memberships,type TenantTransaction} from "@yummyai/database";
import {and,eq} from "drizzle-orm";
import {assertCatalogListingAccess} from "./access.js";

export class PublicationAuthorityError extends Error {
  readonly status:number;readonly statusCode:number;
  constructor(readonly code="publication_authority_changed"){super(code);this.status=this.statusCode=code==="publication_not_found"?404:409;}
}

/** Shared by the original API owner and its Worker. No queue identity creates grants. */
export async function currentPublicationObjectAuthority(tx:TenantTransaction,ceiling:TenantContext,listingId:string,accountId:string,permission:PermissionValue=Permission.ListingRead){
  const authority=intersectPermissionContexts(ceiling,await loadCurrentMembershipContext(tx,ceiling,{lock:true}));
  const listing=await assertCatalogListingAccess(tx,authority,listingId,[permission,Permission.ListingRead],"share");
  const [account]=await tx.select().from(marketplaceAccounts).where(eq(marketplaceAccounts.id,accountId)).for("update").limit(1);
  if(!account||account.deletedAt)throw new ForbiddenError(Permission.StoreRead,"outside_data_scope");
  authorize(authority,Permission.StoreRead,{ownerId:account.createdBy});
  const [member]=await tx.select({id:memberships.id}).from(memberships).where(and(eq(memberships.userId,authority.userId),eq(memberships.status,"active"))).for("share").limit(1);
  if(!member)throw new PublicationAuthorityError();
  return {authority,listing,account,membershipId:member.id};
}

export async function readPublicationAuthority(tx:TenantTransaction,input:TenantContext,requestId:string,
  permission:PermissionValue=Permission.ListingRead,requireBirth=false){
  const [request]=await tx.select().from(marketplacePublicationRequests).where(eq(marketplacePublicationRequests.id,requestId)).limit(1);
  if(!request)throw new PublicationAuthorityError("publication_not_found");
  const [intent]=await tx.select().from(marketplacePublicationIntents).where(eq(marketplacePublicationIntents.requestId,requestId)).limit(1);
  if(requireBirth&&!intent)throw new PublicationAuthorityError("publication_legacy_authority_missing");
  const ceiling=requireBirth?TenantContextSchema.parse(intent!.authorityCeiling):input;
  if(ceiling.tenantId!==input.tenantId||requireBirth&&(ceiling.userId!==request.createdBy||ceiling.userId!==input.userId||intent!.createdBy!==request.createdBy))throw new PublicationAuthorityError();
  const current=await currentPublicationObjectAuthority(tx,ceiling,request.listingId,request.accountId,permission);
  if(requireBirth&&(current.membershipId!==intent!.membershipId||current.account.authorizationGeneration!==intent!.authorizationGeneration))throw new PublicationAuthorityError();
  const [version]=await tx.select().from(listingVersions).where(and(eq(listingVersions.id,request.listingVersionId),eq(listingVersions.listingId,request.listingId))).limit(1);
  if(!version)throw new PublicationAuthorityError("publication_source_changed");
  return {...current,request,intent:intent??null,version};
}
