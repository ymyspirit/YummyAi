import { Body, Controller, Get, Inject, Param, Post, Req } from "@nestjs/common";
import { Permission, authorize } from "@yummyai/authz";
import { CalculateVocAnalysisInputSchema, RecordAdvertisingReportInputSchema, RecordCustomerSignalInputSchema, ReviewCustomerRecommendationInputSchema, UpsertVocDefinitionInputSchema } from "@yummyai/contracts/customer-intelligence";
import { z } from "zod";
import { RequiresPermission } from "../auth/permissions.decorator.js";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { CustomerIntelligenceService } from "./customer-intelligence.service.js";

@Controller("v1/customer-intelligence")
export class CustomerIntelligenceController {
  constructor(@Inject(CustomerIntelligenceService) private readonly service: CustomerIntelligenceService) {}
  @Get("workspace") @RequiresPermission(Permission.CustomerIntelligenceRead) workspace(@Req() request: AuthenticatedRequest) { const context = requireContext(request); authorize(context, Permission.CustomerIntelligenceRead); return this.service.workspace(context); }
  @Post("advertising-reports") @RequiresPermission(Permission.CustomerIntelligenceWrite) recordAdvertisingReport(@Req() request: AuthenticatedRequest, @Body() body: unknown) { const context = requireContext(request); authorize(context, Permission.CustomerIntelligenceWrite); return this.service.recordAdvertisingReport(context, RecordAdvertisingReportInputSchema.parse(body)); }
  @Post("signals") @RequiresPermission(Permission.CustomerIntelligenceWrite) recordSignal(@Req() request: AuthenticatedRequest, @Body() body: unknown) { const context = requireContext(request); authorize(context, Permission.CustomerIntelligenceWrite); return this.service.recordCustomerSignal(context, RecordCustomerSignalInputSchema.parse(body)); }
  @Post("definitions") @RequiresPermission(Permission.CustomerIntelligenceReview) upsertDefinition(@Req() request: AuthenticatedRequest, @Body() body: unknown) { const context = requireContext(request); authorize(context, Permission.CustomerIntelligenceReview); return this.service.upsertDefinition(context, UpsertVocDefinitionInputSchema.parse(body)); }
  @Post("analyses") @RequiresPermission(Permission.CustomerIntelligenceReview) calculateAnalysis(@Req() request: AuthenticatedRequest, @Body() body: unknown) { const context = requireContext(request); authorize(context, Permission.CustomerIntelligenceReview); return this.service.calculateAnalysis(context, CalculateVocAnalysisInputSchema.parse(body)); }
  @Post("recommendations/:recommendationId/review") @RequiresPermission(Permission.CustomerIntelligenceReview) reviewRecommendation(@Req() request: AuthenticatedRequest, @Param("recommendationId") recommendationId: string, @Body() body: unknown) { const context = requireContext(request); authorize(context, Permission.CustomerIntelligenceReview); return this.service.reviewRecommendation(context, z.uuidv7().parse(recommendationId), ReviewCustomerRecommendationInputSchema.parse(body)); }
}
function requireContext(request: AuthenticatedRequest) { if (!request.tenantContext) throw new Error("Tenant context is required"); return request.tenantContext; }
