import { Controller, Get, Inject, Param, Query, Req } from "@nestjs/common";
import { Permission, authorize } from "@yummyai/authz";

import { RequiresPermission } from "../auth/permissions.decorator.js";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { ResearchRepository, type ResearchFilters } from "./research.repository.js";

type ResearchQuery = Omit<ResearchFilters, "limit" | "priceMax" | "priceMin" | "rating" | "tags"> & {
  limit?: number | string;
  priceMax?: number | string;
  priceMin?: number | string;
  rating?: number | string;
  tags?: string[] | string;
};

@Controller("v1/research-items")
export class ResearchController {
  constructor(@Inject(ResearchRepository) private readonly repository: ResearchRepository) {}

  @Get()
  @RequiresPermission(Permission.ResearchRead)
  list(@Req() request: AuthenticatedRequest, @Query() query: ResearchQuery) {
    const context = requireContext(request);
    authorize(context, Permission.ResearchRead);
    return this.repository.list(context, normalizeFilters(query));
  }

  @Get(":id/snapshots")
  @RequiresPermission(Permission.ResearchRead)
  timeline(@Req() request: AuthenticatedRequest, @Param("id") id: string) {
    const context = requireContext(request);
    authorize(context, Permission.ResearchRead);
    return this.repository.timeline(context, id);
  }
}

function normalizeFilters(query: ResearchQuery): ResearchFilters {
  const numeric = (value: unknown) => typeof value === "string" && value !== "" ? Number(value) : value;
  const tags = typeof query.tags === "string" ? query.tags.split(",").map((tag) => tag.trim()).filter(Boolean) : query.tags;
  return {
    ...query,
    tags,
    limit: numeric(query.limit) as number | undefined,
    priceMin: numeric(query.priceMin) as number | undefined,
    priceMax: numeric(query.priceMax) as number | undefined,
    rating: numeric(query.rating) as number | undefined,
  };
}

function requireContext(request: AuthenticatedRequest) {
  if (!request.tenantContext) throw new Error("Tenant context is required");
  return request.tenantContext;
}
