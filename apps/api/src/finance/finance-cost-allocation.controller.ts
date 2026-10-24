import { Body, Controller, Get, Header, HttpCode, Inject, Param, Post, Query, Req } from "@nestjs/common";
import { authorize, Permission } from "@yummyai/authz";
import { RequiresPermission } from "../auth/permissions.decorator.js";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { FinanceCostAllocationService } from "./finance-cost-allocation.service.js";
import { allocationInputInvalid } from "./finance-cost-allocation.targets.js";

@Controller("v1/finance/cost-allocations")
export class FinanceCostAllocationController {
  constructor(@Inject(FinanceCostAllocationService) private readonly service: FinanceCostAllocationService) {}

  @Get("bases/:id")
  @Header("Cache-Control", "private, no-store")
  @RequiresPermission(Permission.FinanceRead)
  base(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Query() raw: unknown) {
    emptyQuery(raw); return this.service.base(context(request, Permission.FinanceRead), id);
  }

  @Get("bases/:id/sources")
  @Header("Cache-Control", "private, no-store")
  @RequiresPermission(Permission.FinanceRead)
  sources(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Query() raw: unknown) {
    return this.service.sources(context(request, Permission.FinanceRead), query(raw, { baseRunId: id }));
  }

  @Get("targets")
  @Header("Cache-Control", "private, no-store")
  @RequiresPermission(Permission.FinanceRead)
  targets(@Req() request: AuthenticatedRequest, @Query() raw: unknown) {
    return this.service.targets(context(request, Permission.FinanceRead), query(raw));
  }

  @Get("versions")
  @Header("Cache-Control", "private, no-store")
  @RequiresPermission(Permission.FinanceRead)
  versions(@Req() request: AuthenticatedRequest, @Query() raw: unknown) {
    return this.service.listVersions(context(request, Permission.FinanceRead), query(raw));
  }

  @Get("versions/:id")
  @Header("Cache-Control", "private, no-store")
  @RequiresPermission(Permission.FinanceRead)
  version(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Query() raw: unknown) {
    emptyQuery(raw); return this.service.version(context(request, Permission.FinanceRead), id);
  }

  @Get("runs")
  @Header("Cache-Control", "private, no-store")
  @RequiresPermission(Permission.FinanceRead)
  runs(@Req() request: AuthenticatedRequest, @Query() raw: unknown) {
    return this.service.listRuns(context(request, Permission.FinanceRead), query(raw));
  }

  @Get("runs/:id")
  @Header("Cache-Control", "private, no-store")
  @RequiresPermission(Permission.FinanceRead)
  run(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Query() raw: unknown) {
    emptyQuery(raw); return this.service.run(context(request, Permission.FinanceRead), id);
  }

  @Get("runs/:id/slices")
  @Header("Cache-Control", "private, no-store")
  @RequiresPermission(Permission.FinanceRead)
  slices(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Query() raw: unknown) {
    return this.service.slices(context(request, Permission.FinanceRead), id, query(raw));
  }

  @Post("preview")
  @HttpCode(200)
  @Header("Cache-Control", "private, no-store")
  @RequiresPermission(Permission.FinanceRead)
  preview(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    return this.service.preview(context(request, Permission.FinanceRead), body);
  }

  @Post("versions")
  @HttpCode(201)
  @Header("Cache-Control", "private, no-store")
  @RequiresPermission(Permission.FinanceReview)
  approve(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    return this.service.approve(context(request, Permission.FinanceReview), body);
  }

  @Post("runs")
  @HttpCode(201)
  @Header("Cache-Control", "private, no-store")
  @RequiresPermission(Permission.FinanceReview)
  calculate(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    return this.service.calculate(context(request, Permission.FinanceReview), body);
  }
}

function context(request: AuthenticatedRequest, permission: Permission) {
  if (!request.tenantContext) throw new Error("Tenant context is required");
  authorize(request.tenantContext, permission); return request.tenantContext;
}

function query(raw: unknown, route: Record<string, string> = {}): Record<string, unknown> {
  const value = raw === undefined ? {} : raw;
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(route).some(key => Object.hasOwn(value, key))) allocationInputInvalid();
  return { ...value, ...route };
}

function emptyQuery(raw: unknown) { if (Object.keys(query(raw)).length) allocationInputInvalid(); }
