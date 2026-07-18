import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { connectDatabase, migrateDatabase } from "@yummyai/database";
import { createStorageFromEnvironment } from "@yummyai/storage";

import { AssetsController } from "./assets/assets.controller.js";
import { AuditService } from "./audit/audit.service.js";
import {
  DatabaseMembershipContextLoader,
  MembershipContextLoader,
  TenantContextGuard,
} from "./auth/tenant-context.guard.js";
import { OidcJwtStrategy, TokenVerifier } from "./auth/oidc-jwt.strategy.js";
import { PermissionsGuard } from "./auth/permissions.guard.js";
import { CaptureController } from "./capture/capture.controller.js";
import { RedisMediaEnqueuer } from "./capture/redis-media-enqueuer.js";
import { CaptureService } from "./capture/capture.service.js";
import { ProductController } from "./catalog/product.controller.js";
import { DrizzleCatalogRepository, ProductService } from "./catalog/product.service.js";
import { CompetitorShopController } from "./competitors/competitor-shop.controller.js";
import { CompetitorShopService } from "./competitors/competitor-shop.service.js";
import { DashboardController } from "./dashboard/dashboard.controller.js";
import { DashboardService, DrizzleDashboardRepository } from "./dashboard/dashboard.service.js";
import { DesignController } from "./design/design.controller.js";
import { DesignService, DrizzleDesignRepository } from "./design/design.service.js";
import { HealthController } from "./health.controller.js";
import { ListingController } from "./listings/listing.controller.js";
import { DrizzleListingRepository, ListingService } from "./listings/listing.service.js";
import { NotificationController } from "./notifications/notification.controller.js";
import {
  DrizzleNotificationRepository,
  NotificationService,
} from "./notifications/notification.service.js";
import {
  CAPTURE_MEDIA_ENQUEUER,
  CATALOG_REPOSITORY,
  DASHBOARD_REPOSITORY,
  DATABASE_CONNECTION,
  DESIGN_REPOSITORY,
  LISTING_REPOSITORY,
  NOTIFICATION_REPOSITORY,
  PRIVATE_STORAGE,
} from "./platform.tokens.js";
import { ResearchController } from "./research/research.controller.js";
import { ResearchRepository } from "./research/research.repository.js";

@Module({
  controllers: [
    AssetsController,
    CaptureController,
    CompetitorShopController,
    DashboardController,
    DesignController,
    HealthController,
    ListingController,
    NotificationController,
    ProductController,
    ResearchController,
  ],
  providers: [
    {
      provide: DATABASE_CONNECTION,
      useFactory: async () => {
        const database = connectDatabase();
        await migrateDatabase(database);
        return database;
      },
    },
    {
      provide: PRIVATE_STORAGE,
      useFactory: async () => {
        const storage = createStorageFromEnvironment();
        await storage.ensureBucket();
        return storage;
      },
    },
    {
      provide: MembershipContextLoader,
      useFactory: (database: ReturnType<typeof connectDatabase>) =>
        new DatabaseMembershipContextLoader(database),
      inject: [DATABASE_CONNECTION],
    },
    { provide: TokenVerifier, useClass: OidcJwtStrategy },
    { provide: CAPTURE_MEDIA_ENQUEUER, useClass: RedisMediaEnqueuer },
    { provide: CATALOG_REPOSITORY, useClass: DrizzleCatalogRepository },
    { provide: DASHBOARD_REPOSITORY, useClass: DrizzleDashboardRepository },
    { provide: DESIGN_REPOSITORY, useClass: DrizzleDesignRepository },
    { provide: LISTING_REPOSITORY, useClass: DrizzleListingRepository },
    { provide: NOTIFICATION_REPOSITORY, useClass: DrizzleNotificationRepository },
    AuditService,
    CaptureService,
    CompetitorShopService,
    DashboardService,
    DesignService,
    ListingService,
    NotificationService,
    ProductService,
    ResearchRepository,
    { provide: APP_GUARD, useClass: TenantContextGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
})
export class AppModule {}
