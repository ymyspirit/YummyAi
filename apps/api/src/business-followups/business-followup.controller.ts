import { Body, Controller, Get, Header, Inject, Param, Post, Query, Req } from "@nestjs/common";
import { z } from "zod";
import {
  FollowupSourceSchema,
  FollowupTaskInboxQuerySchema,
  FollowupResponsibilityInputSchema,
} from "@yummyai/contracts/operations/followup";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { BusinessFollowupService } from "./business-followup.service.js";
const memberQuery = z.object({ q: z.string().trim().max(100).default("") }).strict();
/** Authenticated membership is global; the service checks each source's current permissions. */
@Controller("v1/business-followups/:source")
export class BusinessFollowupController {
  constructor(
    @Inject(BusinessFollowupService) private readonly followup: BusinessFollowupService,
  ) {}
  @Get("tasks")
  @Header("Cache-Control", "private, no-store")
  list(@Req() req: AuthenticatedRequest, @Param("source") source: string, @Query() raw: unknown) {
    return this.followup.list(
      req.tenantContext!,
      FollowupSourceSchema.parse(source),
      FollowupTaskInboxQuerySchema.parse(raw),
    );
  }
  @Get(":id")
  @Header("Cache-Control", "private, no-store")
  get(
    @Req() req: AuthenticatedRequest,
    @Param("source") source: string,
    @Param("id") id: string,
    @Query() raw: unknown,
  ) {
    return this.followup.get(
      req.tenantContext!,
      FollowupSourceSchema.parse(source),
      z.uuidv7().parse(id),
      memberQuery.parse(raw).q,
    );
  }
  @Post(":id/responsibility")
  update(
    @Req() req: AuthenticatedRequest,
    @Param("source") source: string,
    @Param("id") id: string,
    @Body() raw: unknown,
  ) {
    return this.followup.update(
      req.tenantContext!,
      FollowupSourceSchema.parse(source),
      z.uuidv7().parse(id),
      FollowupResponsibilityInputSchema.parse(raw),
    );
  }
  @Post(":id/resume")
  resume(
    @Req() req: AuthenticatedRequest,
    @Param("source") source: string,
    @Param("id") id: string,
    @Body() raw: unknown,
  ) {
    return this.followup.update(
      req.tenantContext!,
      FollowupSourceSchema.parse(source),
      z.uuidv7().parse(id),
      FollowupResponsibilityInputSchema.parse(raw),
      true,
    );
  }
}
