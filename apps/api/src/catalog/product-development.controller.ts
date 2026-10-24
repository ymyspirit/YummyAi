import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
  StreamableFile,
} from "@nestjs/common";
import { Permission } from "@yummyai/authz";
import { z } from "zod";
import { RequiresPermission } from "../auth/permissions.decorator.js";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { ProductDevelopmentService } from "./product-development.service.js";
import { SalesRecipeService } from "./sales-recipe.service.js";
import { SalesPackageService } from "./sales-package.service.js";

@Controller("v1/product-development")
export class ProductDevelopmentController {
  constructor(
    @Inject(ProductDevelopmentService) private readonly catalog: ProductDevelopmentService,
    @Inject(SalesRecipeService) private readonly recipes: SalesRecipeService,
    @Inject(SalesPackageService) private readonly packages: SalesPackageService,
  ) {}
  @Post("spus")
  @RequiresPermission(Permission.ProductWrite)
  createSpu(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    return this.catalog.createSpu(context(req), body);
  }
  @Post("spus/:id")
  @RequiresPermission(Permission.ProductWrite)
  updateSpu(@Req() req: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown) {
    return this.catalog.updateSpu(context(req), z.uuidv7().parse(id), body);
  }
  @Get("assets/:id/preview")
  @RequiresPermission(Permission.AssetRead)
  async preview(
    @Req() req: AuthenticatedRequest,
    @Param("id") id: string,
    @Res({ passthrough: true }) res: { setHeader(name: string, value: string): void },
  ) {
    const bytes = await this.catalog.preview(context(req), z.uuidv7().parse(id));
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    return new StreamableFile(bytes, { type: "image/png" });
  }
  @Get("options")
  @RequiresPermission(Permission.ProductRead)
  options(@Req() req: AuthenticatedRequest) {
    return this.catalog.options(context(req));
  }
  @Get("workspace")
  @RequiresPermission(Permission.ProductRead)
  workspace(@Req() req: AuthenticatedRequest, @Query() query: unknown) {
    return this.catalog.workspace(context(req), query);
  }
  @Get("skus/:id")
  @RequiresPermission(Permission.ProductRead)
  detail(@Req() req: AuthenticatedRequest, @Param("id") id: string) {
    return this.catalog.detail(context(req), z.uuidv7().parse(id));
  }
  @Post("artworks")
  @RequiresPermission(Permission.ProductWrite)
  artwork(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    return this.catalog.registerArtwork(context(req), body);
  }
  @Post("specifications")
  @RequiresPermission(Permission.ProductWrite)
  spec(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    return this.catalog.saveSpecification(context(req), body);
  }
  @Post("artworks/:id/archive")
  @RequiresPermission(Permission.ProductWrite)
  archiveArtwork(@Req() req: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown) {
    return this.catalog.archiveArtwork(context(req), z.uuidv7().parse(id), body);
  }
  @Post("specifications/batch")
  @RequiresPermission(Permission.ProductWrite)
  specs(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    return this.catalog.createSpecifications(context(req), body);
  }
  @Post("combinations")
  @RequiresPermission(Permission.ProductWrite)
  combine(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    return this.catalog.combine(context(req), body);
  }
  @Post("skus/:id/revisions")
  @RequiresPermission(Permission.ProductWrite)
  revise(@Req() req: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown) {
    return this.catalog.revise(context(req), z.uuidv7().parse(id), body);
  }
  @Post("recipes/:id/actions")
  @RequiresPermission(Permission.ProductWrite)
  action(@Req() req: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown) {
    return this.recipes.action(context(req), z.uuidv7().parse(id), body);
  }
  @Post("listings")
  @RequiresPermission(Permission.ListingWrite)
  listing(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    return this.packages.createListing(context(req), body);
  }
  @Post("packages")
  @RequiresPermission(Permission.ListingReview)
  seal(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    return this.packages.seal(context(req), body);
  }
  @Post("channels/preview")
  @HttpCode(200)
  @RequiresPermission(Permission.ProductRead)
  previewChannel(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    return this.packages.previewBinding(context(req), body);
  }
  @Post("channels")
  @RequiresPermission(Permission.StoreManage)
  bind(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    return this.packages.bind(context(req), body);
  }
  @Get("packages/:id/export")
  @RequiresPermission(Permission.ListingRead)
  async download(
    @Req() req: AuthenticatedRequest,
    @Param("id") id: string,
    @Res({ passthrough: true }) res: { setHeader(name: string, value: string): void },
  ) {
    const file = await this.packages.export(context(req), z.uuidv7().parse(id));
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Disposition", `attachment; filename="${file.name}"`);
    return new StreamableFile(file.body);
  }
}
function context(req: AuthenticatedRequest) {
  if (!req.tenantContext) throw new Error("Tenant context is required");
  return req.tenantContext;
}
