import { Body, Controller, Get, Inject, Param, Post, Req } from "@nestjs/common";
import { ReviewDecisionInputSchema, SubmitReviewInputSchema } from "@yummyai/contracts";
import { Permission, authorize } from "@yummyai/authz";
import { z } from "zod";

import { RequiresPermission } from "../auth/permissions.decorator.js";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { ReviewService } from "./review.service.js";

@Controller("v1")
export class ReviewController {
  constructor(@Inject(ReviewService) private readonly service: ReviewService) {}

  @Post("listings/:listingId/reviews")
  @RequiresPermission(Permission.ListingReview)
  submit(@Req() request: AuthenticatedRequest, @Param("listingId") listingId: string, @Body() body: unknown) {
    const context = requireContext(request); authorize(context, Permission.ListingReview);
    const parsed = z.object({ listingVersionId: z.uuidv7() }).parse(body);
    return this.service.submit(context, SubmitReviewInputSchema.parse({ listingId: z.uuidv7().parse(listingId), ...parsed }));
  }

  @Post("reviews/:reviewId/decision")
  @RequiresPermission(Permission.ListingReview)
  decide(@Req() request: AuthenticatedRequest, @Param("reviewId") reviewId: string, @Body() body: unknown) {
    const context = requireContext(request); authorize(context, Permission.ListingReview);
    return this.service.decide(context, z.uuidv7().parse(reviewId), ReviewDecisionInputSchema.parse(body));
  }

  @Post("reviews/:reviewId/export")
  @RequiresPermission(Permission.ListingReview)
  export(@Req() request: AuthenticatedRequest, @Param("reviewId") reviewId: string) {
    const context = requireContext(request); authorize(context, Permission.ListingReview);
    return this.service.requestExport(context, z.uuidv7().parse(reviewId));
  }

  @Get("exports/:exportId/download")
  @RequiresPermission(Permission.ListingRead)
  download(@Req() request: AuthenticatedRequest, @Param("exportId") exportId: string) {
    const context = requireContext(request); authorize(context, Permission.ListingRead);
    return this.service.signDownload(context, z.uuidv7().parse(exportId));
  }
}

function requireContext(request: AuthenticatedRequest) { if (!request.tenantContext) throw new Error("Tenant context is required"); return request.tenantContext; }
