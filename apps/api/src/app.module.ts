import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { connectDatabase, migrateDatabase } from "@yummyai/database";
import { HttpMarketplaceAuthorizationGateway, HttpMarketplaceCapabilityGateway } from "@yummyai/marketplace-connectors";
import { createStorageFromEnvironment } from "@yummyai/storage";

import { AssetsController } from "./assets/assets.controller.js";
import { AuditService } from "./audit/audit.service.js";
import {
  DatabaseMembershipContextLoader,
  DatabaseApiClientContextLoader,
  ApiClientContextLoader,
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
import { CustomerIntelligenceController } from "./customer-intelligence/customer-intelligence.controller.js";
import { CustomerIntelligenceService } from "./customer-intelligence/customer-intelligence.service.js";
import { ProductController } from "./catalog/product.controller.js";
import { DrizzleCatalogRepository, ProductService } from "./catalog/product.service.js";
import { AmazonCustomWorkflowController } from "./catalog/amazon-custom-workflow.controller.js";
import { AmazonCustomWorkflowService } from "./catalog/amazon-custom-workflow.service.js";
import { CustomProductPackageController } from "./catalog/custom-product-package.controller.js";
import { CustomProductPackageService } from "./catalog/custom-product-package.service.js";
import { AmazonCustomListingMaterialsService } from "./catalog/amazon-custom-listing-materials.service.js";
import { CompetitorShopController } from "./competitors/competitor-shop.controller.js";
import { CompetitorShopService } from "./competitors/competitor-shop.service.js";
import { DashboardController } from "./dashboard/dashboard.controller.js";
import { DashboardService, DrizzleDashboardRepository } from "./dashboard/dashboard.service.js";
import { DesignController } from "./design/design.controller.js";
import { DesignService, DrizzleDesignRepository } from "./design/design.service.js";
import { PodWorkbenchController } from "./design/pod-workbench.controller.js";
import { PodWorkbenchService } from "./design/pod-workbench.service.js";
import { PodToolActivationPolicy } from "./design/pod-workbench.service.js";
import { PodArtworkTaskService } from "./design/pod-artwork-task.service.js";
import { PodGovernanceController } from "./design/pod-governance.controller.js";
import { PodGovernanceService } from "./design/pod-governance.service.js";
import { PodPersonalizationController } from "./design/pod-personalization.controller.js";
import { PodPersonalizationService } from "./design/pod-personalization.service.js";
import { PodExportController } from "./design/pod-export.controller.js";
import { PodExportService } from "./design/pod-export.service.js";
import { RedisPodExportEnqueuer } from "./design/redis-pod-export-enqueuer.js";
import { RedisPodArtworkEnqueuer } from "./design/redis-pod-artwork-enqueuer.js";
import { PodBatchWorkflowController } from "./design/pod-batch-workflow.controller.js";
import { PodBatchWorkflowService } from "./design/pod-batch-workflow.service.js";
import { PodMockupBatchService } from "./design/pod-mockup-batch.service.js";
import { RedisPodBatchWorkflowEnqueuer } from "./design/redis-pod-batch-workflow-enqueuer.js";
import { RedisPersonalizationTemplateSourceInspectionEnqueuer } from "./design/redis-personalization-template-source-inspection-enqueuer.js";
import { OrderPersonalizationBatchController } from "./design/order-personalization-batch.controller.js";
import { OrderPersonalizationBatchService } from "./design/order-personalization-batch.service.js";
import { RedisOrderPersonalizationBatchEnqueuer } from "./design/redis-order-personalization-batch-enqueuer.js";
import { OrderPersonalizationRenderController } from "./design/order-personalization-render.controller.js";
import { OrderPersonalizationRenderService } from "./design/order-personalization-render.service.js";
import { RedisOrderPersonalizationRenderEnqueuer } from "./design/redis-order-personalization-render-enqueuer.js";
import { FinanceController } from "./finance/finance.controller.js";
import { FinanceService } from "./finance/finance.service.js";
import { HealthController } from "./health.controller.js";
import { InventoryController } from "./inventory/inventory.controller.js";
import { InventoryService } from "./inventory/inventory.service.js";
import { IntegrationController } from "./integrations/integration.controller.js";
import { IntegrationService } from "./integrations/integration.service.js";
import { createIntegrationSecretVault } from "./integrations/integration-secret-vault.js";
import { RedisWebhookDeliveryEnqueuer } from "./integrations/redis-webhook-delivery-enqueuer.js";
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
import { MarketplacePublicationBatchController } from "./marketplaces/marketplace-publication-batch.controller.js";
import { MarketplacePublicationBatchService } from "./marketplaces/marketplace-publication-batch.service.js";
import { MarketplacePublicationController } from "./marketplaces/marketplace-publication.controller.js";
import { MarketplacePublicationService } from "./marketplaces/marketplace-publication.service.js";
import { createMarketplaceSecretVault } from "./marketplaces/marketplace-secret-vault.js";
import { RedisMarketplacePublicationBatchEnqueuer } from "./marketplaces/redis-marketplace-publication-batch-enqueuer.js";
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
  INTEGRATION_SECRET_VAULT,
  CATALOG_REPOSITORY,
  DASHBOARD_REPOSITORY,
  DATABASE_CONNECTION,
  DESIGN_REPOSITORY,
  LISTING_REPOSITORY,
  MARKETPLACE_AUTHORIZATION_GATEWAY,
  MARKETPLACE_CAPABILITY_GATEWAY,
  MARKETPLACE_LISTING_SYNC_ENQUEUER,
  MARKETPLACE_AUTOMATION_DISPATCHER,
  MARKETPLACE_PUBLICATION_BATCH_ENQUEUER,
  MARKETPLACE_PUBLICATION_ENQUEUER,
  MARKETPLACE_SECRET_VAULT,
  NOTIFICATION_REPOSITORY,
  ORDER_PII_VAULT,
  SHIPMENT_WRITEBACK_ENQUEUER,
  WEBHOOK_DELIVERY_ENQUEUER,
  PRIVATE_STORAGE,
  PERSONALIZATION_TEMPLATE_SOURCE_INSPECTION_ENQUEUER,
  ORDER_PERSONALIZATION_BATCH_ENQUEUER,
  ORDER_PERSONALIZATION_RENDER_ENQUEUER,
  POD_ARTWORK_ENQUEUER,
  POD_BATCH_WORKFLOW_ENQUEUER,
  POD_EXPORT_ENQUEUER,
  WORKFLOW_NODE_ENQUEUER,
} from "./platform.tokens.js";
import { ResearchController } from "./research/research.controller.js";
import { ResearchClassificationService } from "./research/research-classification.service.js";
import { ResearchRepository } from "./research/research.repository.js";
import { ProcurementController } from "./procurement/procurement.controller.js";
import { ProcurementService } from "./procurement/procurement.service.js";
import { PlanningController } from "./planning/planning.controller.js";
import { PlanningService } from "./planning/planning.service.js";
import { SupplierPerformanceController } from "./supplier-performance/supplier-performance.controller.js";
import { SupplierPerformanceService } from "./supplier-performance/supplier-performance.service.js";
import { RedisWorkflowNodeEnqueuer } from "./workflows/redis-workflow-node-enqueuer.js";
import { WorkflowCapabilityRegistry } from "./workflows/workflow-capability.registry.js";
import {
  WorkflowDefinitionController,
  WorkflowRunController,
} from "./workflows/workflow.controller.js";
import { WorkflowDefinitionService } from "./workflows/workflow-definition.service.js";
import {
  ExternalWorkflowExecutor,
  HumanExecutor,
  InternalCapabilityExecutor,
  WorkflowExecutorRouter,
} from "./workflows/workflow-node.executor.js";
import { WorkflowRunService } from "./workflows/workflow-run.service.js";

@Module({
  controllers: [
    AssetsController,
    AmazonCustomWorkflowController,
    CaptureController,
    ChannelInventoryController,
    CustomerIntelligenceController,
    CustomProductPackageController,
    CompetitorShopController,
    DashboardController,
    DesignController,
    PodWorkbenchController,
    PodGovernanceController,
    PodPersonalizationController,
    OrderPersonalizationBatchController,
    OrderPersonalizationRenderController,
    PodExportController,
    PodBatchWorkflowController,
    FinanceController,
    HealthController,
    InventoryController,
    IntegrationController,
    ListingController,
    MarketplaceAccountController,
    MarketplaceAutomationController,
    MarketplaceListingSyncController,
    MarketplacePublicationBatchController,
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
    PlanningController,
    SupplierPerformanceController,
    ProductController,
    ResearchController,
    SupplierRoutingController,
    WorkflowDefinitionController,
    WorkflowRunController,
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
    {
      provide: ApiClientContextLoader,
      useFactory: (database: ReturnType<typeof connectDatabase>) => new DatabaseApiClientContextLoader(database),
      inject: [DATABASE_CONNECTION],
    },
    { provide: TokenVerifier, useClass: OidcJwtStrategy },
    { provide: CAPTURE_MEDIA_ENQUEUER, useClass: RedisMediaEnqueuer },
    { provide: CUSTOMIZATION_FILE_SCAN_ENQUEUER, useClass: RedisCustomizationFileScanEnqueuer },
    { provide: FULFILLMENT_AUTOMATION_ENQUEUER, useClass: RedisFulfillmentAutomationEnqueuer },
    { provide: INTEGRATION_SECRET_VAULT, useFactory: createIntegrationSecretVault },
    { provide: WEBHOOK_DELIVERY_ENQUEUER, useClass: RedisWebhookDeliveryEnqueuer },
    { provide: CATALOG_REPOSITORY, useClass: DrizzleCatalogRepository },
    { provide: DASHBOARD_REPOSITORY, useClass: DrizzleDashboardRepository },
    { provide: DESIGN_REPOSITORY, useClass: DrizzleDesignRepository },
    { provide: LISTING_REPOSITORY, useClass: DrizzleListingRepository },
    { provide: MARKETPLACE_AUTHORIZATION_GATEWAY, useFactory: () => new HttpMarketplaceAuthorizationGateway() },
    { provide: MARKETPLACE_CAPABILITY_GATEWAY, useFactory: () => new HttpMarketplaceCapabilityGateway() },
    { provide: MARKETPLACE_LISTING_SYNC_ENQUEUER, useClass: RedisMarketplaceListingSyncEnqueuer },
    { provide: MARKETPLACE_AUTOMATION_DISPATCHER, useExisting: MarketplaceAutomationService },
    { provide: MARKETPLACE_PUBLICATION_BATCH_ENQUEUER, useClass: RedisMarketplacePublicationBatchEnqueuer },
    { provide: MARKETPLACE_PUBLICATION_ENQUEUER, useClass: RedisMarketplacePublicationEnqueuer },
    { provide: MARKETPLACE_SECRET_VAULT, useFactory: createMarketplaceSecretVault },
    { provide: NOTIFICATION_REPOSITORY, useClass: DrizzleNotificationRepository },
    { provide: ORDER_PII_VAULT, useFactory: createOrderPiiVault },
    { provide: SHIPMENT_WRITEBACK_ENQUEUER, useClass: RedisShipmentWritebackEnqueuer },
    { provide: POD_ARTWORK_ENQUEUER, useClass: RedisPodArtworkEnqueuer },
    { provide: POD_BATCH_WORKFLOW_ENQUEUER, useClass: RedisPodBatchWorkflowEnqueuer },
    { provide: POD_EXPORT_ENQUEUER, useClass: RedisPodExportEnqueuer },
    { provide: WORKFLOW_NODE_ENQUEUER, useClass: RedisWorkflowNodeEnqueuer },
    { provide: PERSONALIZATION_TEMPLATE_SOURCE_INSPECTION_ENQUEUER, useClass: RedisPersonalizationTemplateSourceInspectionEnqueuer },
    { provide: ORDER_PERSONALIZATION_BATCH_ENQUEUER, useClass: RedisOrderPersonalizationBatchEnqueuer },
    { provide: ORDER_PERSONALIZATION_RENDER_ENQUEUER, useClass: RedisOrderPersonalizationRenderEnqueuer },
    AuditService,
    AmazonCustomWorkflowService,
    CaptureService,
    ChannelInventoryService,
    CustomerIntelligenceService,
    CustomProductPackageService,
    AmazonCustomListingMaterialsService,
    CompetitorShopService,
    DashboardService,
    DesignService,
    PodWorkbenchService,
    PodToolActivationPolicy,
    PodArtworkTaskService,
    PodGovernanceService,
    PodPersonalizationService,
    OrderPersonalizationBatchService,
    OrderPersonalizationRenderService,
    PodExportService,
    PodBatchWorkflowService,
    PodMockupBatchService,
    FinanceService,
    ListingService,
    MarketplaceAccountService,
    MarketplaceAuthorizationService,
    MarketplaceAutomationService,
    MarketplaceCapabilityService,
    MarketplaceListingSyncService,
    MarketplacePublicationBatchService,
    MarketplacePublicationService,
    NotificationService,
    OrderService,
    FulfillmentAutomationService,
    InventoryService,
    IntegrationService,
    OrderAfterSalesService,
    OrderCustomizationService,
    OrderIngestionService,
    OrderProductionService,
    OrderShipmentService,
    OrderRoutingService,
    OrderSyncCoordinator,
    ProcurementService,
    PlanningService,
    SupplierPerformanceService,
    ProductService,
    ResearchClassificationService,
    ResearchRepository,
    WorkflowCapabilityRegistry,
    WorkflowDefinitionService,
    WorkflowRunService,
    HumanExecutor,
    InternalCapabilityExecutor,
    ExternalWorkflowExecutor,
    WorkflowExecutorRouter,
    { provide: APP_GUARD, useClass: TenantContextGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
})
export class AppModule {}
