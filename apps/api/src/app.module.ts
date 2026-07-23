import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { connectDatabase, migrateDatabase } from "@yummyai/database";
import { HttpMarketplaceAuthorizationGateway, HttpMarketplaceCapabilityGateway } from "@yummyai/marketplace-connectors";
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
import { ChannelInventoryController } from "./channel-inventory/channel-inventory.controller.js";
import { ChannelInventoryService } from "./channel-inventory/channel-inventory.service.js";
import { ProductController } from "./catalog/product.controller.js";
import { DrizzleCatalogRepository, ProductService } from "./catalog/product.service.js";
import { CompetitorShopController } from "./competitors/competitor-shop.controller.js";
import { CompetitorShopService } from "./competitors/competitor-shop.service.js";
import { DashboardController } from "./dashboard/dashboard.controller.js";
import { DashboardService, DrizzleDashboardRepository } from "./dashboard/dashboard.service.js";
import { DesignController } from "./design/design.controller.js";
import { DesignService, DrizzleDesignRepository } from "./design/design.service.js";
import { FinanceController } from "./finance/finance.controller.js";
import { FinanceService } from "./finance/finance.service.js";
import { HealthController } from "./health.controller.js";
import { InventoryController } from "./inventory/inventory.controller.js";
import { InventoryService } from "./inventory/inventory.service.js";
import { ListingController } from "./listings/listing.controller.js";
import { DrizzleListingRepository, ListingService } from "./listings/listing.service.js";
import { MarketplaceAccountController } from "./marketplaces/marketplace-account.controller.js";
import { MarketplaceAccountService } from "./marketplaces/marketplace-account.service.js";
import { MarketplaceAuthorizationService } from "./marketplaces/marketplace-authorization.service.js";
import { MarketplaceAutomationController } from "./marketplaces/marketplace-automation.controller.js";
import { MarketplaceAutomationService } from "./marketplaces/marketplace-automation.service.js";
import { MarketplaceCapabilityService } from "./marketplaces/marketplace-capability.service.js";
import { MarketplaceListingSyncController } from "./marketplaces/marketplace-listing-sync.controller.js";
import { MarketplaceListingSyncService } from "./marketplaces/marketplace-listing-sync.service.js";
import { MarketplacePublicationController } from "./marketplaces/marketplace-publication.controller.js";
import { MarketplacePublicationService } from "./marketplaces/marketplace-publication.service.js";
import { createMarketplaceSecretVault } from "./marketplaces/marketplace-secret-vault.js";
import { RedisMarketplacePublicationEnqueuer } from "./marketplaces/redis-marketplace-publication-enqueuer.js";
import { RedisMarketplaceListingSyncEnqueuer } from "./marketplaces/redis-marketplace-listing-sync-enqueuer.js";
import { NotificationController } from "./notifications/notification.controller.js";
import { OrderController } from "./orders/order.controller.js";
import { FulfillmentAutomationController } from "./orders/fulfillment-automation.controller.js";
import { FulfillmentAutomationService } from "./orders/fulfillment-automation.service.js";
import { RedisFulfillmentAutomationEnqueuer } from "./orders/redis-fulfillment-automation-enqueuer.js";
import { OrderAfterSalesCommandController, OrderAfterSalesController } from "./orders/order-after-sales.controller.js";
import { OrderAfterSalesService } from "./orders/order-after-sales.service.js";
import { OrderCustomizationService } from "./orders/order-customization.service.js";
import { OrderIngestionService } from "./orders/order-ingestion.service.js";
import { createOrderPiiVault } from "./orders/order-pii-vault.js";
import { OrderService } from "./orders/order.service.js";
import { OrderShipmentCommandController, OrderShipmentController } from "./orders/order-shipment.controller.js";
import { OrderShipmentService } from "./orders/order-shipment.service.js";
import { RedisShipmentWritebackEnqueuer } from "./orders/redis-shipment-writeback-enqueuer.js";
import { OrderRoutingService } from "./orders/order-routing.service.js";
import { SupplierRoutingController } from "./orders/supplier-routing.controller.js";
import { OrderProductionCommandController, OrderProductionController } from "./orders/order-production.controller.js";
import { OrderProductionService } from "./orders/order-production.service.js";
import { OrderSyncCoordinator } from "./orders/order-sync-coordinator.js";
import { RedisCustomizationFileScanEnqueuer } from "./orders/redis-customization-file-scan-enqueuer.js";
import {
  DrizzleNotificationRepository,
  NotificationService,
} from "./notifications/notification.service.js";
import {
  CAPTURE_MEDIA_ENQUEUER,
  CUSTOMIZATION_FILE_SCAN_ENQUEUER,
  FULFILLMENT_AUTOMATION_ENQUEUER,
  CATALOG_REPOSITORY,
  DASHBOARD_REPOSITORY,
  DATABASE_CONNECTION,
  DESIGN_REPOSITORY,
  LISTING_REPOSITORY,
  MARKETPLACE_AUTHORIZATION_GATEWAY,
  MARKETPLACE_CAPABILITY_GATEWAY,
  MARKETPLACE_LISTING_SYNC_ENQUEUER,
  MARKETPLACE_AUTOMATION_DISPATCHER,
  MARKETPLACE_PUBLICATION_ENQUEUER,
  MARKETPLACE_SECRET_VAULT,
  NOTIFICATION_REPOSITORY,
  ORDER_PII_VAULT,
  SHIPMENT_WRITEBACK_ENQUEUER,
  PRIVATE_STORAGE,
} from "./platform.tokens.js";
import { ResearchController } from "./research/research.controller.js";
import { ResearchRepository } from "./research/research.repository.js";
import { ProcurementController } from "./procurement/procurement.controller.js";
import { ProcurementService } from "./procurement/procurement.service.js";

@Module({
  controllers: [
    AssetsController,
    CaptureController,
    ChannelInventoryController,
    CompetitorShopController,
    DashboardController,
    DesignController,
    FinanceController,
    HealthController,
    InventoryController,
    ListingController,
    MarketplaceAccountController,
    MarketplaceAutomationController,
    MarketplaceListingSyncController,
    MarketplacePublicationController,
    NotificationController,
    OrderController,
    FulfillmentAutomationController,
    OrderAfterSalesController,
    OrderAfterSalesCommandController,
    OrderProductionController,
    OrderProductionCommandController,
    OrderShipmentController,
    OrderShipmentCommandController,
    ProcurementController,
    ProductController,
    ResearchController,
    SupplierRoutingController,
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
    { provide: CUSTOMIZATION_FILE_SCAN_ENQUEUER, useClass: RedisCustomizationFileScanEnqueuer },
    { provide: FULFILLMENT_AUTOMATION_ENQUEUER, useClass: RedisFulfillmentAutomationEnqueuer },
    { provide: CATALOG_REPOSITORY, useClass: DrizzleCatalogRepository },
    { provide: DASHBOARD_REPOSITORY, useClass: DrizzleDashboardRepository },
    { provide: DESIGN_REPOSITORY, useClass: DrizzleDesignRepository },
    { provide: LISTING_REPOSITORY, useClass: DrizzleListingRepository },
    { provide: MARKETPLACE_AUTHORIZATION_GATEWAY, useFactory: () => new HttpMarketplaceAuthorizationGateway() },
    { provide: MARKETPLACE_CAPABILITY_GATEWAY, useFactory: () => new HttpMarketplaceCapabilityGateway() },
    { provide: MARKETPLACE_LISTING_SYNC_ENQUEUER, useClass: RedisMarketplaceListingSyncEnqueuer },
    { provide: MARKETPLACE_AUTOMATION_DISPATCHER, useExisting: MarketplaceAutomationService },
    { provide: MARKETPLACE_PUBLICATION_ENQUEUER, useClass: RedisMarketplacePublicationEnqueuer },
    { provide: MARKETPLACE_SECRET_VAULT, useFactory: createMarketplaceSecretVault },
    { provide: NOTIFICATION_REPOSITORY, useClass: DrizzleNotificationRepository },
    { provide: ORDER_PII_VAULT, useFactory: createOrderPiiVault },
    { provide: SHIPMENT_WRITEBACK_ENQUEUER, useClass: RedisShipmentWritebackEnqueuer },
    AuditService,
    CaptureService,
    ChannelInventoryService,
    CompetitorShopService,
    DashboardService,
    DesignService,
    FinanceService,
    ListingService,
    MarketplaceAccountService,
    MarketplaceAuthorizationService,
    MarketplaceAutomationService,
    MarketplaceCapabilityService,
    MarketplaceListingSyncService,
    MarketplacePublicationService,
    NotificationService,
    OrderService,
    FulfillmentAutomationService,
    InventoryService,
    OrderAfterSalesService,
    OrderCustomizationService,
    OrderIngestionService,
    OrderProductionService,
    OrderShipmentService,
    OrderRoutingService,
    OrderSyncCoordinator,
    ProcurementService,
    ProductService,
    ResearchRepository,
    { provide: APP_GUARD, useClass: TenantContextGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
})
export class AppModule {}
