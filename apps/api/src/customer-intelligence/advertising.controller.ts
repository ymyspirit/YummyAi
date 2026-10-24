import {
  Body,
  Controller,
  Get,
  Header,
  Inject,
  Param,
  Post,
  Query,
  Req,
  StreamableFile,
} from "@nestjs/common";
import { Permission } from "@yummyai/authz";
import { z } from "zod";
import {
  AdImportInputSchema,
  AdCommitImportSchema,
  AdSaveGoalInputSchema,
  AdObservationInputSchema,
  AdAnalysisInputSchema,
  AdActionEventInputSchema,
  AdFactQuerySchema,
  AdExportInputSchema,
  AdWorkspaceQuerySchema,
} from "@yummyai/contracts/advertising";
import {AdHistoryQuerySchema,AdHistoryRecordQuerySchema} from "@yummyai/contracts/advertising/history";
import { RequiresPermission } from "../auth/permissions.decorator.js";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { AdvertisingService } from "./advertising.service.js";
import { advertisingReviewCsv } from "./ad-export.js";

@Controller("v1/advertising")
export class AdvertisingController {
  constructor(@Inject(AdvertisingService) private readonly service: AdvertisingService) {}
  @Get("workspace")
  @Header("Cache-Control", "no-store")
  workspace(@Req() r: AuthenticatedRequest, @Query() query: unknown) {
    return this.service.workspace(context(r), AdWorkspaceQuerySchema.parse(query).accountId);
  }
  @Get("facts")
  @Header("Cache-Control", "no-store")
  @RequiresPermission(Permission.CustomerIntelligenceRead)
  facts(@Req() r: AuthenticatedRequest, @Query() query: unknown) {
    return this.service.facts(context(r), AdFactQuerySchema.parse(query));
  }
  @Get("history")
  @Header("Cache-Control", "no-store")
  history(@Req() r:AuthenticatedRequest,@Query() query:unknown){
    return this.service.history(context(r),AdHistoryQuerySchema.parse(query));
  }
  @Get("records/:id")
  @Header("Cache-Control", "no-store")
  record(@Req() r:AuthenticatedRequest,@Param("id") id:string,@Query() query:unknown){
    return this.service.record(context(r),z.uuidv7().parse(id),AdHistoryRecordQuerySchema.parse(query));
  }
  @Post("imports/preview")
  @Header("Cache-Control", "no-store")
  @RequiresPermission(Permission.CustomerIntelligenceWrite)
  preview(@Req() r: AuthenticatedRequest, @Body() input: unknown) {
    return this.service.preview(context(r), AdImportInputSchema.parse(input));
  }
  @Post("imports")
  @Header("Cache-Control", "no-store")
  @RequiresPermission(Permission.CustomerIntelligenceWrite)
  commit(@Req() r: AuthenticatedRequest, @Body() input: unknown) {
    return this.service.commit(context(r), AdCommitImportSchema.parse(input));
  }
  @Post("goals")
  @Header("Cache-Control", "no-store")
  @RequiresPermission(Permission.CustomerIntelligenceReview)
  goal(@Req() r: AuthenticatedRequest, @Body() input: unknown) {
    return this.service.saveGoal(context(r), AdSaveGoalInputSchema.parse(input));
  }
  @Post("observations")
  @Header("Cache-Control", "no-store")
  @RequiresPermission(Permission.CustomerIntelligenceWrite)
  observation(@Req() r: AuthenticatedRequest, @Body() input: unknown) {
    return this.service.recordObservation(context(r), AdObservationInputSchema.parse(input));
  }
  @Post("analyses")
  @Header("Cache-Control", "no-store")
  @RequiresPermission(Permission.CustomerIntelligenceReview)
  analyze(@Req() r: AuthenticatedRequest, @Body() input: unknown) {
    return this.service.analyze(context(r), AdAnalysisInputSchema.parse(input));
  }
  @Post("actions/:id/events")
  @Header("Cache-Control", "no-store")
  @RequiresPermission(Permission.CustomerIntelligenceReview)
  event(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Body() input: unknown) {
    return this.service.transition(
      context(r),
      z.uuidv7().parse(id),
      AdActionEventInputSchema.parse(input),
    );
  }
  @Post("imports/:id/archive")
  @Header("Cache-Control", "no-store")
  @RequiresPermission(Permission.CustomerIntelligenceWrite)
  archive(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Body() input: unknown) {
    return this.service.archive(context(r), z.uuidv7().parse(id), input);
  }
  @Get("imports/:id/source")
  @Header("Cache-Control", "no-store")
  @RequiresPermission(Permission.CustomerIntelligenceRead)
  async source(@Req() r: AuthenticatedRequest, @Param("id") id: string) {
    const source = await this.service.readSource(context(r), z.uuidv7().parse(id));
    return new StreamableFile(Buffer.from(source.bytes), {
      type: "text/csv; charset=utf-8",
      disposition: `attachment; filename="advertising-source-${id}.csv"`,
    });
  }
  @Post("exports")
  @Header("Cache-Control", "no-store")
  @RequiresPermission(Permission.CustomerIntelligenceReview)
  export(@Req() r: AuthenticatedRequest, @Body() input: unknown) {
    return this.service.sealExport(context(r), AdExportInputSchema.parse(input));
  }
  @Get("exports/:id")
  @Header("Cache-Control", "no-store")
  @RequiresPermission(Permission.CustomerIntelligenceRead)
  async download(@Req() r: AuthenticatedRequest, @Param("id") id: string) {
    const sealed = await this.service.readExport(context(r), z.uuidv7().parse(id));
    return new StreamableFile(Buffer.from(JSON.stringify(sealed, null, 2), "utf8"), {
      type: "application/json; charset=utf-8",
      disposition: `attachment; filename="advertising-review-${id}.json"`,
    });
  }
  @Get("exports/:id/csv")
  @Header("Cache-Control", "no-store")
  @RequiresPermission(Permission.CustomerIntelligenceRead)
  async csv(@Req() r: AuthenticatedRequest, @Param("id") id: string) {
    const sealed = await this.service.readExport(context(r), z.uuidv7().parse(id));
    return new StreamableFile(Buffer.from(advertisingReviewCsv(sealed), "utf8"), {
      type: "text/csv; charset=utf-8",
      disposition: `attachment; filename="advertising-review-${id}.csv"`,
    });
  }
}
function context(r: AuthenticatedRequest) {
  if (!r.tenantContext) throw new Error("Tenant context required");
  return r.tenantContext;
}
