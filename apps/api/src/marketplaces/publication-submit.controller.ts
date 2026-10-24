import {BadRequestException,Body,Controller,Get,Head,Header,HttpCode,Inject,Param,Post,Query,Req} from "@nestjs/common";
import {authorize,Permission} from "@yummyai/authz";
import {CancelMarketplacePublicationInputSchema} from "@yummyai/contracts";
import {CreatePublicationSubmitInputSchema,CreatePublicationStatusInputSchema,PublicationSubmitLookupSchema,PublicationSubmitWorkspaceInputSchema} from "@yummyai/contracts/marketplace/publication-submit";
import {z} from "zod";
import {RequiresPermission} from "../auth/permissions.decorator.js";
import type {AuthenticatedRequest} from "../auth/tenant-context.guard.js";
import {MarketplacePublicationService} from "./marketplace-publication.service.js";

@Controller("v1/marketplace-publication-submissions")
export class PublicationSubmitController{
 constructor(@Inject(MarketplacePublicationService) private readonly publications:MarketplacePublicationService){}

 @Get("workspace")
 @Header("cache-control","private, no-store")
 @RequiresPermission(Permission.ListingRead)
 workspace(@Req() request:AuthenticatedRequest,@Query() query:unknown){return this.publications.submissionWorkspace(context(request),boundary(PublicationSubmitWorkspaceInputSchema,query));}

 @Post("requests")
 @Header("cache-control","private, no-store")
 @RequiresPermission(Permission.ListingPublish)
 create(@Req() request:AuthenticatedRequest,@Body() body:unknown){return this.publications.createSubmission(context(request,true),boundary(CreatePublicationSubmitInputSchema,body));}

 @Get("receipt")
 @Header("cache-control","private, no-store")
 @RequiresPermission(Permission.ListingRead)
 receipt(@Req() request:AuthenticatedRequest,@Query() query:unknown){return this.publications.submissionReceipt(context(request),boundary(PublicationSubmitLookupSchema,query));}

 @Get("status-receipt")
 @Header("cache-control","private, no-store")
 @RequiresPermission(Permission.ListingRead)
 statusReceipt(@Req() request:AuthenticatedRequest,@Query() query:unknown){return this.publications.statusReceipt(context(request),boundary(PublicationSubmitLookupSchema,query));}

 @Get("requests/:requestId")
 @Header("cache-control","private, no-store")
 @RequiresPermission(Permission.ListingRead)
 get(@Req() request:AuthenticatedRequest,@Param("requestId") id:string){return this.publications.getSubmission(context(request),boundary(z.uuidv7(),id));}

 @Head("workspace")
 @Header("cache-control","private, no-store")
 @RequiresPermission(Permission.ListingRead)
 headWorkspace(@Req() request:AuthenticatedRequest,@Query() query:unknown){return this.workspace(request,query);}
 @Head("receipt")
 @Header("cache-control","private, no-store")
 @RequiresPermission(Permission.ListingRead)
 headReceipt(@Req() request:AuthenticatedRequest,@Query() query:unknown){return this.receipt(request,query);}
 @Head("status-receipt")
 @Header("cache-control","private, no-store")
 @RequiresPermission(Permission.ListingRead)
 headStatusReceipt(@Req() request:AuthenticatedRequest,@Query() query:unknown){return this.statusReceipt(request,query);}
 @Head("requests/:requestId")
 @Header("cache-control","private, no-store")
 @RequiresPermission(Permission.ListingRead)
 headRequest(@Req() request:AuthenticatedRequest,@Param("requestId") id:string){return this.get(request,id);}

 @Post("requests/:requestId/status")
 @Header("cache-control","private, no-store")
 @RequiresPermission(Permission.ListingPublish)
 status(@Req() request:AuthenticatedRequest,@Param("requestId") id:string,@Body() body:unknown){return this.publications.createStatusRead(context(request,true),boundary(z.uuidv7(),id),boundary(CreatePublicationStatusInputSchema,body));}

 @Post("requests/:requestId/cancel")
 @HttpCode(200)
 @Header("cache-control","private, no-store")
 @RequiresPermission(Permission.ListingPublish)
 cancel(@Req() request:AuthenticatedRequest,@Param("requestId") id:string,@Body() body:unknown){return this.publications.cancelSubmission(context(request,true),boundary(z.uuidv7(),id),boundary(CancelMarketplacePublicationInputSchema,body));}
}
function context(request:AuthenticatedRequest,write=false){
 if(!request.tenantContext)throw new Error("Tenant context is required");
 authorize(request.tenantContext,Permission.ListingRead);authorize(request.tenantContext,Permission.StoreRead);
 if(write)authorize(request.tenantContext,Permission.ListingPublish);return request.tenantContext;
}
function boundary<T>(schema:z.ZodType<T>,raw:unknown):T{const value=schema.safeParse(raw);if(!value.success)throw new BadRequestException({code:"publication_submit_input_invalid"});return value.data;}
