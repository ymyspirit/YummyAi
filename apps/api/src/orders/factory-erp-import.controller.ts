import { Body, Controller, Get, Header, Inject, Param, Post, Query, Req } from "@nestjs/common";
import { z } from "zod";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { RequiresPermission } from "../auth/permissions.decorator.js";
import { FACTORY_ERP_READ, FACTORY_ERP_WRITE, FactoryErpImportService } from "./factory-erp-import.service.js";
const Id = z.uuidv7();
function context(request: AuthenticatedRequest) { if (!request.tenantContext) throw new Error("Tenant context required"); return request.tenantContext; }
@Controller("v1/factory-erp-imports")
export class FactoryErpImportController {
  constructor(@Inject(FactoryErpImportService) private readonly imports: FactoryErpImportService) {}
  @Post() @Header("Cache-Control", "private, no-store") @RequiresPermission(...FACTORY_ERP_WRITE)
  upload(@Req() request: AuthenticatedRequest, @Body() body: unknown) { return this.imports.upload(context(request), body); }
  @Get() @Header("Cache-Control", "private, no-store") @RequiresPermission(...FACTORY_ERP_READ)
  list(@Req() request: AuthenticatedRequest, @Query() query: unknown) { return this.imports.list(context(request), query); }
  @Get("candidates") @Header("Cache-Control", "private, no-store") @RequiresPermission(...FACTORY_ERP_READ)
  candidates(@Req() request: AuthenticatedRequest, @Query() query: unknown) { return this.imports.candidates(context(request), query); }
  @Get("lifecycle") @Header("Cache-Control", "private, no-store") @RequiresPermission(...FACTORY_ERP_READ)
  lifecycleList(@Req() request: AuthenticatedRequest, @Query() query: unknown) { return this.imports.listLifecycle(context(request), query); }
  @Get("bindings") @Header("Cache-Control", "private, no-store") @RequiresPermission(...FACTORY_ERP_READ)
  bindings(@Req() request: AuthenticatedRequest, @Query() query: unknown) { return this.imports.listBindings(context(request), query); }
  @Get("bindings/:id/void-observations") @Header("Cache-Control", "private, no-store") @RequiresPermission(...FACTORY_ERP_READ)
  voidObservations(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Query() query: unknown) { return this.imports.voidObservations(context(request), Id.parse(id), query); }
  @Get("bindings/:id/void-observations/:observationId") @Header("Cache-Control", "private, no-store") @RequiresPermission(...FACTORY_ERP_READ)
  voidObservation(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Param("observationId") observationId: string) { return this.imports.voidObservation(context(request), Id.parse(id), Id.parse(observationId)); }
  @Get("bindings/:id/void-reviews") @Header("Cache-Control", "private, no-store") @RequiresPermission(...FACTORY_ERP_READ)
  voidReviews(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Query() query: unknown) { return this.imports.listVoidReviews(context(request), Id.parse(id), query); }
  @Get("bindings/:id/void-reviews/:reviewId") @Header("Cache-Control", "private, no-store") @RequiresPermission(...FACTORY_ERP_READ)
  voidReview(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Param("reviewId") reviewId: string) { return this.imports.voidReview(context(request), Id.parse(id), Id.parse(reviewId)); }
  @Post("bindings/:id/void-reviews") @Header("Cache-Control", "private, no-store") @RequiresPermission(...FACTORY_ERP_WRITE)
  reviewVoid(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown) { return this.imports.reviewVoid(context(request), Id.parse(id), body); }
  @Get("bindings/:id") @Header("Cache-Control", "private, no-store") @RequiresPermission(...FACTORY_ERP_READ)
  binding(@Req() request: AuthenticatedRequest, @Param("id") id: string) { return this.imports.binding(context(request), Id.parse(id)); }
  @Get("bindings/:id/changes") @Header("Cache-Control", "private, no-store") @RequiresPermission(...FACTORY_ERP_READ)
  bindingChanges(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Query() query: unknown) { return this.imports.listBindingChanges(context(request), Id.parse(id), query); }
  @Get("bindings/:id/changes/:changeId") @Header("Cache-Control", "private, no-store") @RequiresPermission(...FACTORY_ERP_READ)
  bindingChange(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Param("changeId") changeId: string) { return this.imports.bindingChange(context(request), Id.parse(id), Id.parse(changeId)); }
  @Post("bindings/:id/changes") @Header("Cache-Control", "private, no-store") @RequiresPermission(...FACTORY_ERP_WRITE)
  changeBinding(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown) { return this.imports.changeBinding(context(request), Id.parse(id), body); }
  @Get(":id/lifecycle") @Header("Cache-Control", "private, no-store") @RequiresPermission(...FACTORY_ERP_READ)
  lifecycle(@Req() request: AuthenticatedRequest, @Param("id") id: string) { return this.imports.lifecycle(context(request), Id.parse(id)); }
  @Get(":id/applications") @Header("Cache-Control", "private, no-store") @RequiresPermission(...FACTORY_ERP_READ)
  applications(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Query() query: unknown) { return this.imports.listApplications(context(request), Id.parse(id), query); }
  @Get(":id/applications/:applicationId") @Header("Cache-Control", "private, no-store") @RequiresPermission(...FACTORY_ERP_READ)
  application(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Param("applicationId") applicationId: string) { return this.imports.application(context(request), Id.parse(id), Id.parse(applicationId)); }
  @Get(":id") @Header("Cache-Control", "private, no-store") @RequiresPermission(...FACTORY_ERP_READ)
  get(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Query() query: unknown) { return this.imports.get(context(request), Id.parse(id), query); }
  @Post(":id/apply") @Header("Cache-Control", "private, no-store") @RequiresPermission(...FACTORY_ERP_WRITE)
  apply(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown) { return this.imports.apply(context(request), Id.parse(id), body); }
}
