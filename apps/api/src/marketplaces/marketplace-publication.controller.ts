import { BadRequestException, Body, Controller, Get, Head, Header, Inject, Param, Post, Query, Req } from "@nestjs/common";
import { Permission, authorize } from "@yummyai/authz";
import {
  CancelMarketplacePublicationInputSchema,
  CreateMarketplacePublicationInputSchema,
  ListMarketplacePublicationsInputSchema,
} from "@yummyai/contracts";
import { z } from "zod";
import {CreatePublicationPreviewInputSchema,PublicationPreviewLookupSchema,PublicationPreviewWorkspaceInputSchema,PublicationPreviewReadCheckInputSchema} from "@yummyai/contracts/marketplace/publication-preview";

import { RequiresPermission } from "../auth/permissions.decorator.js";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { MarketplacePublicationService } from "./marketplace-publication.service.js";

@Controller("v1/marketplace-publications")
export class MarketplacePublicationController {
  constructor(
    @Inject(MarketplacePublicationService) private readonly publications: MarketplacePublicationService,
  ) {}

  @Head("preview/workspace")
  @Header("cache-control","private, no-store")
  @RequiresPermission(Permission.ListingRead)
  checkPreviewWorkspace(@Req() request:AuthenticatedRequest,@Query() query:unknown){return this.publications.checkPreviewWorkspaceRead(requireContext(request),boundary(PublicationPreviewReadCheckInputSchema,query));}

  @Head("preview/:id")
  @Header("cache-control","private, no-store")
  @RequiresPermission(Permission.ListingRead)
  checkPreviewRequest(@Req() request:AuthenticatedRequest,@Param("id") id:string){return this.publications.checkPreviewRequestRead(requireContext(request),boundary(z.uuidv7(),id));}

  @Get("preview/workspace")
  @RequiresPermission(Permission.ListingRead)
  previewWorkspace(@Req() request:AuthenticatedRequest,@Query() query:unknown){return this.publications.previewWorkspace(requireContext(request),boundary(PublicationPreviewWorkspaceInputSchema,query));}

  @Post("preview")
  @RequiresPermission(Permission.ListingPublish)
  createPreview(@Req() request:AuthenticatedRequest,@Body() body:unknown){return this.publications.createPreview(requireContext(request),boundary(CreatePublicationPreviewInputSchema,body));}

  @Get("preview/receipt")
  @RequiresPermission(Permission.ListingRead)
  previewReceipt(@Req() request:AuthenticatedRequest,@Query() query:unknown){return this.publications.previewReceipt(requireContext(request),boundary(PublicationPreviewLookupSchema,query));}

  @Get("preview/:id")
  @RequiresPermission(Permission.ListingRead)
  getPreview(@Req() request:AuthenticatedRequest,@Param("id") id:string){return this.publications.getPreview(requireContext(request),boundary(z.uuidv7(),id));}

  @Post("preview/:id/cancel")
  @RequiresPermission(Permission.ListingPublish)
  cancelPreview(@Req() request:AuthenticatedRequest,@Param("id") id:string,@Body() body:unknown){return this.publications.cancelPreview(requireContext(request),boundary(z.uuidv7(),id),boundary(CancelMarketplacePublicationInputSchema,body));}

  @Post()
  @RequiresPermission(Permission.ListingPublish)
  create(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const context = requireContext(request);
    authorize(context, Permission.ListingPublish);
    return this.publications.create(context, CreateMarketplacePublicationInputSchema.parse(body));
  }

  @Post(":id/continue")
  @RequiresPermission(Permission.ListingPublish)
  continue(@Req() request: AuthenticatedRequest, @Param("id") id: string) {
    const context = requireContext(request);
    authorize(context, Permission.ListingPublish);
    return this.publications.continue(context, z.uuidv7().parse(id));
  }

  @Post(":id/cancel")
  @RequiresPermission(Permission.ListingPublish)
  cancel(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown) {
    const context = requireContext(request);
    authorize(context, Permission.ListingPublish);
    return this.publications.cancel(
      context,
      z.uuidv7().parse(id),
      CancelMarketplacePublicationInputSchema.parse(body),
    );
  }

  @Get()
  @RequiresPermission(Permission.ListingRead)
  list(@Req() request: AuthenticatedRequest, @Query() query: unknown) {
    const context = requireContext(request);
    authorize(context, Permission.ListingRead);
    return this.publications.list(context, ListMarketplacePublicationsInputSchema.parse(query));
  }

  @Get(":id")
  @RequiresPermission(Permission.ListingRead)
  get(@Req() request: AuthenticatedRequest, @Param("id") id: string) {
    const context = requireContext(request);
    authorize(context, Permission.ListingRead);
    return this.publications.get(context, z.uuidv7().parse(id));
  }

  @Get(":id/events")
  @RequiresPermission(Permission.ListingRead)
  events(@Req() request: AuthenticatedRequest, @Param("id") id: string) {
    const context = requireContext(request);
    authorize(context, Permission.ListingRead);
    return this.publications.events(context, z.uuidv7().parse(id));
  }
}

function requireContext(request: AuthenticatedRequest) {
  if (!request.tenantContext) throw new Error("Tenant context is required");
  return request.tenantContext;
}
function boundary<T>(schema:z.ZodType<T>,input:unknown):T{const value=schema.safeParse(input);if(!value.success)throw new BadRequestException({code:"publication_input_invalid"});return value.data;}
