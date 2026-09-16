import { Body, Controller, Get, Inject, Param, Patch, Post, Query, Req } from "@nestjs/common";
import {
  ResolveResearchSourcesInputSchema,
  ResearchStudyStatusSchema,
} from "@yummyai/contracts/research/creative";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import { ResearchStudyService } from "./research-study.service.js";
import { ResearchArchiveService } from "./research-archive.service.js";
import { ResearchVisibilitySchema } from "@yummyai/contracts/research";
import { Permission, authorize } from "@yummyai/authz";
import {
  AssignResearchProductTypeInputSchema,
  ResearchClassificationStatusSchema,
} from "@yummyai/contracts";

import { RequiresPermission } from "../auth/permissions.decorator.js";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { ResearchClassificationService } from "./research-classification.service.js";
import { ResearchRepository, type ResearchFilters } from "./research.repository.js";

type ResearchQuery = Omit<
  ResearchFilters,
  "limit" | "priceMax" | "priceMin" | "rating" | "tags"
> & {
  limit?: number | string;
  priceMax?: number | string;
  priceMin?: number | string;
  rating?: number | string;
  tags?: string[] | string;
};

@Controller("v1/research-items")
export class ResearchController {
  constructor(
    @Inject(ResearchRepository) private readonly repository: ResearchRepository,
    @Inject(ResearchClassificationService)
    private readonly classifications: ResearchClassificationService,
    @Inject(ResearchStudyService) private readonly studies: ResearchStudyService,
    @Inject(ResearchArchiveService) private readonly archive: ResearchArchiveService,
  ) {}

  @Get()
  @RequiresPermission(Permission.ResearchRead)
  list(@Req() request: AuthenticatedRequest, @Query() query: ResearchQuery) {
    const context = requireContext(request);
    authorize(context, Permission.ResearchRead);
    return this.repository.list(context, normalizeFilters(query));
  }

  @Get("product-types")
  @RequiresPermission(Permission.ResearchRead)
  productTypes(@Req() request: AuthenticatedRequest, @Query("visibility") visibility?: string) {
    const context = requireContext(request);
    authorize(context, Permission.ResearchRead);
    return this.repository.productTypes(
      context,
      visibility ? ResearchVisibilitySchema.parse(visibility) : "active",
    );
  }

  @Post("archive")
  @RequiresPermission(Permission.ResearchWrite)
  setArchived(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    return this.archive.setArchived(requireContext(request), body);
  }

  @Patch("product-type")
  @RequiresPermission(Permission.ResearchWrite)
  assignProductType(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const context = requireContext(request);
    authorize(context, Permission.ResearchWrite);
    return this.classifications.assign(context, AssignResearchProductTypeInputSchema.parse(body));
  }

  @Get(":id/snapshots")
  @RequiresPermission(Permission.ResearchRead)
  timeline(@Req() request: AuthenticatedRequest, @Param("id") id: string) {
    const context = requireContext(request);
    authorize(context, Permission.ResearchRead);
    return this.repository.timeline(context, id);
  }

  @Post("creative-sources")
  @RequiresPermission(Permission.ResearchRead)
  creativeSources(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    return this.studies.resolve(
      requireContext(request),
      ResolveResearchSourcesInputSchema.parse(body).sources,
    );
  }

  @Get(":id/study")
  @RequiresPermission(Permission.ResearchRead)
  study(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string,
    @Query("revision") revision?: string,
  ) {
    return this.studies.workspace(
      requireContext(request),
      EntityIdSchema.parse(id),
      revision ? EntityIdSchema.parse(revision) : undefined,
    );
  }

  @Post(":id/study")
  @RequiresPermission(Permission.ResearchWrite)
  saveStudy(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown) {
    return this.studies.save(requireContext(request), EntityIdSchema.parse(id), body);
  }
}

function normalizeFilters(query: ResearchQuery): ResearchFilters {
  const numeric = (value: unknown) =>
    typeof value === "string" && value !== "" ? Number(value) : value;
  const tags =
    typeof query.tags === "string"
      ? query.tags
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean)
      : query.tags;
  const classificationStatus = ResearchClassificationStatusSchema.safeParse(
    query.classificationStatus,
  );
  return {
    ...query,
    visibility: query.visibility ? ResearchVisibilitySchema.parse(query.visibility) : "active",
    item: query.item ? EntityIdSchema.parse(query.item) : undefined,
    researchStatus: query.researchStatus
      ? ResearchStudyStatusSchema.parse(query.researchStatus)
      : undefined,
    classificationStatus: classificationStatus.success ? classificationStatus.data : undefined,
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
