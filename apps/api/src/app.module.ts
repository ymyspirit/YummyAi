import { IdentitySessionController } from "./auth/identity-session.controller.js";
import { TeamDirectoryController } from "./auth/team-directory.controller.js";
import { TeamDirectoryService } from "./auth/team-directory.service.js";
import { WorkflowResponsibilityService } from "./workflows/workflow-responsibility.service.js";
import { ProductDevelopmentController } from "./catalog/product-development.controller.js";
import { ManufacturingController } from "./catalog/manufacturing.controller.js";
import { ManufacturingService } from "./catalog/manufacturing.service.js";
import { SalesPlanController } from "./catalog/sales-plan.controller.js";
import { SalesPlanService } from "./catalog/sales-plan.service.js";
import { SalesPlanLaunchService } from "./catalog/sales-plan-launch.service.js";
import { SalesPlanLaunchController } from "./catalog/sales-plan-launch.controller.js";
import { SalesPlanPreparationService } from "./catalog/sales-plan-agent.service.js";
import { SalesPlanPreparationController } from "./catalog/sales-plan-agent.controller.js";
import { ProductVisualsService } from "./catalog/product-visuals.service.js";
import { ProductVisualsController } from "./catalog/product-visuals.controller.js";
import { SalesPlanDeliveryService } from "./catalog/sales-plan-delivery.service.js";
import { SalesPlanDeliveryController } from "./catalog/sales-plan-delivery.controller.js";
import { ContentProjectController } from "./content-projects/content-project.controller.js";
import { PillowProjectController } from "./content-projects/pillow-project.controller.js";
import { PillowProjectService } from "./content-projects/pillow-project.service.js";
import { ContentProjectService } from "./content-projects/content-project.service.js";
import { ProductDevelopmentService } from "./catalog/product-development.service.js";
import { SalesRecipeService } from "./catalog/sales-recipe.service.js";
import { SalesPackageService } from "./catalog/sales-package.service.js";
import { SalesAdaptationService } from "./design/sales-adaptation.service.js";
import { Module } from "@nestjs/common";
import type { SecretVault } from "@yummyai/ai-core";
import type { DatabaseConnection } from "@yummyai/database";
import { CatalogPackageService } from "@yummyai/catalog-core";
import { PodArtworkOwner, type PodArtworkEnqueuer } from "@yummyai/pod-core";
import { WorkflowNodeRuntime } from "@yummyai/workflow-core";
import { AssistController } from "./ai/assist.controller.js";
import { AgentReadController } from "./ai/agent-read.controller.js";
import { AgentReadService } from "./ai/agent-read.service.js";
import { AgentToolOwners } from "./ai/agent-tool-owners.js";
import { AgentResourceOwners } from "./ai/agent-resource-owners.js";
import { AgentResourcesService } from "./ai/agent-resources.service.js";
import { AgentResourcesController } from "./ai/agent-resources.controller.js";
import { AgentFulfillmentService } from "./ai/agent-fulfillment.service.js";
import { AgentFulfillmentController } from "./ai/agent-fulfillment.controller.js";
import { AgentToolsService } from "./ai/agent-tools.service.js";
import { AgentToolsController } from "./ai/agent-tools.controller.js";
import { AgentLoopController } from "./ai/agent-loop.controller.js";
import { AgentLoopService, AgentLoopDispatcher } from "./ai/agent-loop.service.js";
import { AgentCommandController } from "./ai/agent-command.controller.js";
import { AgentCommandService } from "./ai/agent-command.service.js";
import { AgentCommandOwnerAdapter } from "./ai/agent-command-owner.js";
import { AgentFulfillmentCommandController } from "./ai/agent-fulfillment-command.controller.js";
import { AgentFulfillmentCommandService } from "./ai/agent-fulfillment-command.service.js";
import { AgentFulfillmentCommandOwner } from "./ai/agent-fulfillment-command-owner.js";
import { AgentDependencyPlanController } from "./ai/agent-dependency-plan.controller.js";
import { AgentDependencyPlanService } from "./ai/agent-dependency-plan.service.js";
import { AgentDependencyPlanSource } from "./ai/agent-dependency-plan-source.js";
import { RedisAgentLoopDispatcher } from "./ai/redis-agent-loop-dispatcher.js";
import { AgentPlanController } from "./ai/agent-plan.controller.js";
import { AgentPlanService, AgentPlanDispatcher } from "./ai/agent-plan.service.js";
import { AgentNativeController } from "./ai/agent-native.controller.js";
import { AgentNativeService } from "./ai/agent-native.service.js";
import { AgentNativeV2Controller } from "./ai/agent-native-v2.controller.js";
import { AgentNativeV2Service } from "./ai/agent-native-v2.service.js";
import { AgentNativeV3Controller } from "./ai/agent-native-v3.controller.js";
import { AgentNativeV3Service } from "./ai/agent-native-v3.service.js";
import { AgentNativeV4Controller } from "./ai/agent-native-v4.controller.js";
import { AgentNativeV4Service } from "./ai/agent-native-v4.service.js";
import { AgentReadinessController } from "./ai/agent-readiness.controller.js";
import { AgentReadinessService } from "./ai/agent-readiness.service.js";
import { AgentRuntimeReadinessController } from "./ai/agent-runtime-readiness.controller.js";
import { AgentRuntimeReadinessService, AGENT_RUNTIME_PRESENCE_READER } from "./ai/agent-runtime-readiness.service.js";
import { RedisAgentRuntimePresence } from "@yummyai/jobs";
import { RedisAgentPlanDispatcher } from "./ai/redis-agent-plan-dispatcher.js";
import { AssistTargetPageController } from "./ai/assist-target-page.controller.js";
import { AssistTargetPageOwner } from "./ai/assist-target-page-owner.js";
import { AssistTargetPageService } from "./ai/assist-target-page.service.js";
import { ModelBillingController } from "./ai/model-billing.controller.js";
import { ModelBillingService } from "./ai/model-billing.service.js";
import { AssistTaskWorkspaceController } from "./ai/assist-task-workspace.controller.js";
import { AssistTaskWorkspaceService } from "./ai/assist-task-workspace.service.js";
import { AssistService, AssistEnqueuer } from "./ai/assist.service.js";
import { AssistContextService } from "./ai/assist-context.service.js";
import { AssistCatalogContextService } from "./ai/assist-catalog-context.service.js";
import { AssistBusinessContextService } from "./ai/assist-business-context.service.js";
import { RedisAssistEnqueuer } from "./ai/redis-assist-enqueuer.js";
import { AI_ASSIST_VAULT } from "./platform.tokens.js";
import { createEnvironmentSecretVault } from "@yummyai/ai-core";
import { MODEL_SECRET_VAULT } from "./platform.tokens.js";
import { ModelConfigController } from "./ai/model-config.controller.js";
import { ModelConfigurationController } from "./ai/model-configuration.controller.js";
import { ModelConfigurationService } from "./ai/model-configuration.service.js";
import { CreativeStudioController } from "./design/creative-studio.controller.js";
import { CreativeStudioService } from "./design/creative-studio.service.js";
import { CreativeStudioPersonalService } from "./design/creative-studio-personal.service.js";
import { StudioPaidImageService } from "./design/studio-paid-image.service.js";
import { StudioImageBudgetService } from "./design/studio-image-budget.service.js";
import { StudioDocumentTransferService } from "./design/studio-document-transfer.service.js";
import { StudioVideoDirectoryService } from "./design/studio-video-directory.service.js";
import {
  StudioGenerationService,
  StudioGenerationEnqueuer,
} from "./design/studio-generation.service.js";
import { RedisStudioGenerationEnqueuer } from "./design/redis-studio-generation-enqueuer.js";
import { APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";
import { ApiClientAuthorityInterceptor } from "./auth/api-client-authority.interceptor.js";
import { ApiClientRouteGuard } from "./auth/api-client-route.guard.js";
import { IntegrationAgentCapabilityController } from "./integrations/agent-capability.controller.js";
import { assertDatabaseMigrationsCurrent, connectDatabase } from "@yummyai/database";
import {
  HttpMarketplaceAuthorizationGateway,
  HttpMarketplaceCapabilityGateway,
} from "@yummyai/marketplace-connectors";
import { createStorageFromEnvironment, ClamAvScanner } from "@yummyai/storage";
import { KNOWLEDGE_EVIDENCE_VAULT, KNOWLEDGE_DOCUMENT_SCANNER } from "./platform.tokens.js";

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
import { AdvertisingController } from "./customer-intelligence/advertising.controller.js";
import { AdvertisingService } from "./customer-intelligence/advertising.service.js";
import { AdvertisingCommandController } from "./customer-intelligence/advertising-command.controller.js";
import { AdvertisingCommandService } from "./customer-intelligence/advertising-command.service.js";
import { AdvertisingCommandOwnerAdapter } from "./customer-intelligence/advertising-command-owner.js";
import { createAdvertisingCommandVault } from "./customer-intelligence/advertising-command-vault.js";
import { ADVERTISING_COMMAND_VAULT } from "./platform.tokens.js";
import { AdSourceGateway, AD_SOURCE_SCANNER } from "./customer-intelligence/ad-source.gateway.js";
import { ProductController } from "./catalog/product.controller.js";
import { ProductSupplyController } from "./catalog/product-supply.controller.js";
import { ProductSupplyService } from "./catalog/product-supply.service.js";
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
import { FulfillmentAttentionService } from "./dashboard/fulfillment-attention.service.js";
import { DesignController } from "./design/design.controller.js";
import { DesignService, DrizzleDesignRepository } from "./design/design.service.js";
import { ProductionEditorController } from "./design/production-editor.controller.js";
import {
  ProductionEditorService,
  ProductionEditorRenderEnqueuer,
  ProductionEditorScanner,
  ClamAvProductionEditorScanner,
} from "./design/production-editor.service.js";
import { RedisProductionEditorRenderEnqueuer } from "./design/redis-production-editor-render-enqueuer.js";
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
import { CanvasBridgeController } from "./design/canvas-bridge.controller.js";
import { CanvasBridgeService } from "./design/canvas-bridge.service.js";
import { CanvasWorkflowService } from "./design/canvas-workflow.service.js";
import { PodBatchWorkflowService } from "./design/pod-batch-workflow.service.js";
import { CreativeExecutionOperatorController } from "./design/creative-execution-operator.controller.js";
import { CreativeExecutionOperatorService } from "./design/creative-execution-operator.service.js";
import { CreativeResponseAdoptionController } from "./design/creative-response-adoption.controller.js";
import { CreativeResponseAdoptionService } from "./design/creative-response-adoption.service.js";
import { CreativeOwnerResponseAdoptionController } from "./design/creative-owner-response-adoption.controller.js";
import { CreativeOwnerResponseAdoptionService } from "./design/creative-owner-response-adoption.service.js";
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
import { FinancePayablesService } from "./finance/finance-payables.service.js";
import { FinancePayablesController } from "./finance/finance-payables.controller.js";
import { FinancePayablesAdjustmentsService } from "./finance/finance-payables-adjustments.service.js";
import { FinancePayablesAdjustmentsController } from "./finance/finance-payables-adjustments.controller.js";
import { FinanceLedgerService } from "./finance/finance-ledger.service.js";
import { FinanceLedgerController } from "./finance/finance-ledger.controller.js";
import { FinanceCostAllocationService } from "./finance/finance-cost-allocation.service.js";
import { FinanceCostAllocationController } from "./finance/finance-cost-allocation.controller.js";
import { FinanceCommandController } from "./finance/finance-command.controller.js";
import { FinanceCommandService } from "./finance/finance-command.service.js";
import { FinanceCommandResultReader } from "./finance/finance-command-result.reader.js";
import { FinanceCommandOwnerAdapter } from "./finance/finance-command-owner.js";
import { createFinanceCommandVault } from "./finance/finance-command-vault.js";
import { FINANCE_COMMAND_VAULT } from "./platform.tokens.js";
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
import { MarketplaceAuthorityWorkspaceService } from "./marketplaces/marketplace-authority-workspace.service.js";
import { StoreNodeController, StoreNodeEnrollmentController } from "./marketplaces/store-node.controller.js";
import { StoreNodeService } from "./marketplaces/store-node.service.js";
import { StoreNodeCertificateIssuer } from "./marketplaces/store-node.types.js";
import { StoreNodePki } from "./marketplaces/store-node-pki.js";
import { StoreNodeRuntimeGateway } from "./marketplaces/store-node-runtime-gateway.js";
import { StoreNodeExecutionController } from "./marketplaces/store-node-execution.controller.js";
import { StoreNodeExecutionService } from "./marketplaces/store-node-execution.service.js";
import { StoreNodeExecutionRuntime } from "./marketplaces/store-node-execution.types.js";
import { MarketplaceAuthorizationService } from "./marketplaces/marketplace-authorization.service.js";
import { MarketplaceAutomationController } from "./marketplaces/marketplace-automation.controller.js";
import { MarketplaceAutomationService } from "./marketplaces/marketplace-automation.service.js";
import { MarketplaceCapabilityService } from "./marketplaces/marketplace-capability.service.js";
import { MarketplaceListingSyncController } from "./marketplaces/marketplace-listing-sync.controller.js";
import { MarketplaceListingSyncService } from "./marketplaces/marketplace-listing-sync.service.js";
import { MarketplacePublicationBatchController } from "./marketplaces/marketplace-publication-batch.controller.js";
import { MarketplacePublicationBatchService } from "./marketplaces/marketplace-publication-batch.service.js";
import { MarketplacePublicationController } from "./marketplaces/marketplace-publication.controller.js";
import { PublicationSubmitController } from "./marketplaces/publication-submit.controller.js";
import { MarketplacePublicationService } from "./marketplaces/marketplace-publication.service.js";
import { createMarketplaceSecretVault } from "./marketplaces/marketplace-secret-vault.js";
import { RedisMarketplacePublicationBatchEnqueuer } from "./marketplaces/redis-marketplace-publication-batch-enqueuer.js";
import { RedisMarketplacePublicationEnqueuer } from "./marketplaces/redis-marketplace-publication-enqueuer.js";
import { RedisMarketplaceListingSyncEnqueuer } from "./marketplaces/redis-marketplace-listing-sync-enqueuer.js";
import { NotificationController } from "./notifications/notification.controller.js";
import { OrderController } from "./orders/order.controller.js";
import { AmazonOrderReportController } from "./orders/amazon-order-report.controller.js";
import { OrderDesignAgentController } from "./orders/order-design-agent.controller.js";
import { RuleCenterController } from "./rules/rule-center.controller.js";
import { RuleCenterService } from "./rules/rule-center.service.js";
import { KnowledgeController } from "./knowledge/knowledge.controller.js";
import { KnowledgeService } from "./knowledge/knowledge.service.js";
import { MethodGovernanceService } from "./knowledge/method-governance.service.js";
import { MethodGovernanceController } from "./knowledge/method-governance.controller.js";
import { KnowledgeImportService } from "./knowledge/knowledge-import.service.js";
import { KnowledgeGovernanceService } from "./knowledge/knowledge-governance.service.js";
import { KnowledgeEvaluationService } from "./knowledge/knowledge-evaluation.service.js";
import { KnowledgeBenchmarkDatasetService } from "./knowledge/knowledge-benchmark-dataset.service.js";
import { KnowledgeBenchmarkExperimentService } from "./knowledge/knowledge-benchmark-experiment.service.js";
import { KnowledgeBenchmarkCostService } from "./knowledge/knowledge-benchmark-cost.service.js";
import { KnowledgeBenchmarkBusinessService } from "./knowledge/knowledge-benchmark-business.service.js";
import { KnowledgeBenchmarkController } from "./knowledge/knowledge-benchmark.controller.js";
import { KnowledgeAnswerContextService } from "./knowledge/knowledge-answer-context.service.js";
import { KnowledgeGovernanceController } from "./knowledge/knowledge-governance.controller.js";
import { OrderWorkspaceController } from "./orders/order-workspace.controller.js";
import { OrderWorkspaceService } from "./orders/order-workspace.service.js";
import { OrderWholeDetailService } from "./orders/order-whole-detail.service.js";
import { OrderTaskService } from "./orders/order-task.service.js";
import { OrderResponsibilityService } from "./orders/order-responsibility.service.js";
import { BusinessFollowupService } from "./business-followups/business-followup.service.js";
import { BusinessFollowupController } from "./business-followups/business-followup.controller.js";
import { OrderResponsibilityController } from "./orders/order-responsibility.controller.js";
import { OrderTaskController } from "./orders/order-task.controller.js";
import { OrderReviewService } from "./orders/order-review.service.js";
import { AmazonOrderReportService } from "./orders/amazon-order-report.service.js";
import {
  AmazonReportArchiveGateway,
  HttpAmazonReportArchiveGateway,
} from "./orders/amazon-report-archive.gateway.js";
import {
  AmazonReportRetentionEnqueuer,
  RedisAmazonReportRetentionEnqueuer,
} from "./orders/redis-amazon-report-retention-enqueuer.js";
import {
  AmazonReportProcessingEnqueuer,
  RedisAmazonReportProcessingEnqueuer,
} from "./orders/redis-amazon-report-processing-enqueuer.js";
import { FulfillmentAutomationController } from "./orders/fulfillment-automation.controller.js";
import { FulfillmentAutomationService } from "./orders/fulfillment-automation.service.js";
import { RedisFulfillmentAutomationEnqueuer } from "./orders/redis-fulfillment-automation-enqueuer.js";
import {
  OrderAfterSalesCommandController,
  OrderAfterSalesController,
} from "./orders/order-after-sales.controller.js";
import { OrderAfterSalesService } from "./orders/order-after-sales.service.js";
import { OrderCustomizationService } from "./orders/order-customization.service.js";
import { OrderIngestionService } from "./orders/order-ingestion.service.js";
import { createOrderPiiVault } from "./orders/order-pii-vault.js";
import { OrderService } from "./orders/order.service.js";
import {
  OrderShipmentCommandController,
  OrderShipmentController,
} from "./orders/order-shipment.controller.js";
import { OrderShipmentService } from "./orders/order-shipment.service.js";
import { RedisShipmentWritebackEnqueuer } from "./orders/redis-shipment-writeback-enqueuer.js";
import { OrderRoutingService } from "./orders/order-routing.service.js";
import { SupplierRoutingController } from "./orders/supplier-routing.controller.js";
import { FactoryDirectoryController } from "./suppliers/factory-directory.controller.js";
import { FactoryDirectoryService } from "./suppliers/factory-directory.service.js";
import { FactoryCapacityController } from "./suppliers/factory-capacity.controller.js";
import { FactoryCapacityService } from "./suppliers/factory-capacity.service.js";
import { ShiposController } from "./suppliers/shipos.controller.js";
import { ShiposService } from "./suppliers/shipos.service.js";
import { LogisticsService, LogisticsEnqueuer } from "./logistics/logistics.service.js";
import { LogisticsController } from "./logistics/logistics.controller.js";
import { RedisLogisticsEnqueuer } from "./logistics/redis-logistics-enqueuer.js";
import { HttpLogisticsGateway, LogisticsReadOwner } from "@yummyai/logistics";
import { ShiposReadGateway, createShiposReadGateway } from "./suppliers/shipos-read.gateway.js";
import {
  OrderProductionCommandController,
  OrderProductionController,
} from "./orders/order-production.controller.js";
import { OrderProductionService } from "./orders/order-production.service.js";
import { ProductionCommandService } from "./orders/production-command.service.js";
import { OrderFulfillmentCommandService } from "./orders/order-fulfillment-command.service.js";
import { OrderFulfillmentCommandOwner } from "./orders/order-fulfillment-command-owner.js";
import { OrderFulfillmentCommandController } from "./orders/order-fulfillment-command.controller.js";
import { ProductionMaterialService } from "./orders/production-material.service.js";
import { ProductionMaterialCommandService } from "./orders/production-material-command.service.js";
import { ProductionMaterialController } from "./orders/production-material.controller.js";
import { ProductionQuantityService } from "./orders/production-quantity.service.js";
import { ProductionQuantityController } from "./orders/production-quantity.controller.js";
import { QualityScrapService } from "./orders/quality-scrap.service.js";
import { QualityScrapController } from "./orders/quality-scrap.controller.js";
import { ProductionCommandController } from "./orders/production-command.controller.js";
import { NativeProductionService } from "./orders/native-production.service.js";
import { NativeProductionController } from "./orders/native-production.controller.js";
import { OrderProductionDeliveryController } from "./orders/order-production-delivery.controller.js";
import { OrderProductionDeliveryService } from "./orders/order-production-delivery.service.js";
import { FactoryErpImportController } from "./orders/factory-erp-import.controller.js";
import { FactoryErpImportService } from "./orders/factory-erp-import.service.js";
import { FactoryErpSourceGateway, FACTORY_ERP_SOURCE_SCANNER } from "./orders/factory-erp-source.gateway.js";
import { FactoryCollaborationService } from "./orders/factory-collaboration.service.js";
import {
  FactoryCollaborationController,
  FactoryPortalController,
} from "./orders/factory-portal.controller.js";
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
import { ResearchStudyService } from "./research/research-study.service.js";
import { ResearchArchiveService } from "./research/research-archive.service.js";
import { ProcurementController } from "./procurement/procurement.controller.js";
import { ProcurementService } from "./procurement/procurement.service.js";
import { InvoiceReconciliationService } from "./procurement/invoice-reconciliation.service.js";
import { InvoiceReconciliationController } from "./procurement/invoice-reconciliation.controller.js";
import { IncomingInspectionService } from "./procurement/incoming-inspection.service.js";
import { IncomingInspectionController } from "./procurement/incoming-inspection.controller.js";
import { IncomingCommandService } from "./procurement/incoming-command.service.js";
import { createIncomingCommandVault } from "./procurement/incoming-command-vault.js";
import { INCOMING_COMMAND_VAULT } from "./platform.tokens.js";
import { ProcurementCommandController } from "./procurement/procurement-command.controller.js";
import { ProcurementCommandService } from "./procurement/procurement-command.service.js";
import { createProcurementCommandVault } from "./procurement/procurement-command-vault.js";
import { PROCUREMENT_COMMAND_VAULT } from "./platform.tokens.js";
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
import { WorkflowOperatorService } from "./workflows/workflow-operator.service.js";

@Module({
  controllers: [
    IdentitySessionController,
    TeamDirectoryController,
    ProductDevelopmentController,
    ManufacturingController,
    SalesPlanController,
    SalesPlanLaunchController,
    SalesPlanPreparationController,
    ProductVisualsController,
    SalesPlanDeliveryController,
    ModelConfigController,
    ModelConfigurationController,
    AssistController,
    AgentReadController,
    AgentToolsController,
    AgentResourcesController,
    AgentFulfillmentController,
    AgentLoopController,
    AgentCommandController,
    AgentFulfillmentCommandController,
    AgentDependencyPlanController,
    AgentPlanController,
    AgentNativeController,
    AgentNativeV2Controller,
    AgentNativeV3Controller,
    AgentNativeV4Controller,
    AgentReadinessController,
    AgentRuntimeReadinessController,
    AssistTargetPageController,
    ModelBillingController,
    AssistTaskWorkspaceController,
    CreativeStudioController,
    CreativeExecutionOperatorController,
    CreativeResponseAdoptionController,
    CreativeOwnerResponseAdoptionController,
    AssetsController,
    AmazonCustomWorkflowController,
    CaptureController,
    ChannelInventoryController,
    CustomerIntelligenceController,
    AdvertisingController,
    AdvertisingCommandController,
    CustomProductPackageController,
    CompetitorShopController,
    DashboardController,
    DesignController,
    ProductionEditorController,
    PodWorkbenchController,
    PodGovernanceController,
    PodPersonalizationController,
    OrderPersonalizationBatchController,
    OrderPersonalizationRenderController,
    PodExportController,
    PodBatchWorkflowController,
    CanvasBridgeController,
    PillowProjectController,
    ContentProjectController,
    FinanceController,
    FinancePayablesController,
    FinancePayablesAdjustmentsController,
    FinanceLedgerController,
    FinanceCostAllocationController,
    FinanceCommandController,
    HealthController,
    InventoryController,
    IntegrationController,
    IntegrationAgentCapabilityController,
    ListingController,
    MarketplaceAccountController,
    StoreNodeController,
    StoreNodeEnrollmentController,
    StoreNodeExecutionController,
    MarketplaceAutomationController,
    MarketplaceListingSyncController,
    MarketplacePublicationBatchController,
    MarketplacePublicationController,
    PublicationSubmitController,
    NotificationController,
    AmazonOrderReportController,
    OrderDesignAgentController,
    OrderTaskController,
    OrderResponsibilityController,
    BusinessFollowupController,
    RuleCenterController,
    KnowledgeController,
    MethodGovernanceController,
    KnowledgeGovernanceController,
    KnowledgeBenchmarkController,
    OrderWorkspaceController,
    OrderController,
    FulfillmentAutomationController,
    OrderAfterSalesController,
    OrderAfterSalesCommandController,
    OrderProductionController,
    OrderProductionCommandController,
    NativeProductionController,
    ProductionCommandController,
    OrderFulfillmentCommandController,
    ProductionMaterialController,
    ProductionQuantityController,
    QualityScrapController,
    OrderProductionDeliveryController,
    FactoryErpImportController,
    FactoryCollaborationController,
    FactoryPortalController,
    OrderShipmentController,
    OrderShipmentCommandController,
    ProcurementController,
    InvoiceReconciliationController,
    IncomingInspectionController,
    ProcurementCommandController,
    PlanningController,
    SupplierPerformanceController,
    ProductController,
    ProductSupplyController,
    ResearchController,
    SupplierRoutingController,
    FactoryDirectoryController,
    FactoryCapacityController,
    ShiposController,
    LogisticsController,
    WorkflowDefinitionController,
    WorkflowRunController,
  ],
  providers: [
    ProductDevelopmentService,
    ManufacturingService,
    SalesPlanService,
    SalesPlanLaunchService,
    SalesPlanPreparationService,
    ProductVisualsService,
    SalesPlanDeliveryService,
    SalesRecipeService,
    SalesPackageService,
    SalesAdaptationService,
    ContentProjectService,
    PillowProjectService,
    {
      provide: MODEL_SECRET_VAULT,
      useFactory: () =>
        createEnvironmentSecretVault("MODEL_CREDENTIAL_ENCRYPTION_KEY", "yummyai:model-config"),
    },
    { provide: StudioGenerationEnqueuer, useClass: RedisStudioGenerationEnqueuer },
    CreativeStudioService,
    CreativeStudioPersonalService,
    StudioPaidImageService,
    StudioImageBudgetService,
    StudioDocumentTransferService,
    StudioVideoDirectoryService,
    StudioGenerationService,
    ModelConfigurationService,
    AssistService,
    AgentReadService,
    AgentToolOwners,
    AgentResourceOwners,
    AgentResourcesService,
    AgentFulfillmentService,
    AgentToolsService,
    AgentLoopService,
    AgentCommandOwnerAdapter,
    AgentCommandService,
    AgentFulfillmentCommandOwner,
    AgentFulfillmentCommandService,
    AgentDependencyPlanSource,
    AgentDependencyPlanService,
    { provide: AgentLoopDispatcher, useClass: RedisAgentLoopDispatcher },
    AgentPlanService,
    AgentNativeService,
    AgentNativeV2Service,
    AgentNativeV3Service,
    AgentNativeV4Service,
    AgentReadinessService,
    AgentRuntimeReadinessService,
    { provide: AGENT_RUNTIME_PRESENCE_READER, useFactory: () => {
      const reader = new RedisAgentRuntimePresence();
      return { inspect: reader.inspect.bind(reader), onModuleDestroy: () => reader.close() };
    } },
    { provide: AgentPlanDispatcher, useClass: RedisAgentPlanDispatcher },
    AssistTargetPageOwner,
    AssistTargetPageService,
    ModelBillingService,
    AssistTaskWorkspaceService,
    AssistContextService,
    AssistCatalogContextService,
    AssistBusinessContextService,
    { provide: AssistEnqueuer, useClass: RedisAssistEnqueuer },
    {
      provide: AI_ASSIST_VAULT,
      useFactory: () =>
        createEnvironmentSecretVault("MODEL_CREDENTIAL_ENCRYPTION_KEY", "yummyai:ai-assist"),
    },
    {
      provide: DATABASE_CONNECTION,
      useFactory: async () => {
        const database = connectDatabase();
        try {
          await assertDatabaseMigrationsCurrent(database);
          return database;
        } catch (error) {
          await database.client.end();
          throw error;
        }
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
      useFactory: (database: ReturnType<typeof connectDatabase>) =>
        new DatabaseApiClientContextLoader(database),
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
    {
      provide: MARKETPLACE_AUTHORIZATION_GATEWAY,
      useFactory: () => new HttpMarketplaceAuthorizationGateway(),
    },
    {
      provide: MARKETPLACE_CAPABILITY_GATEWAY,
      useFactory: () => new HttpMarketplaceCapabilityGateway(),
    },
    { provide: MARKETPLACE_LISTING_SYNC_ENQUEUER, useClass: RedisMarketplaceListingSyncEnqueuer },
    { provide: MARKETPLACE_AUTOMATION_DISPATCHER, useExisting: MarketplaceAutomationService },
    {
      provide: MARKETPLACE_PUBLICATION_BATCH_ENQUEUER,
      useClass: RedisMarketplacePublicationBatchEnqueuer,
    },
    { provide: MARKETPLACE_PUBLICATION_ENQUEUER, useClass: RedisMarketplacePublicationEnqueuer },
    { provide: MARKETPLACE_SECRET_VAULT, useFactory: createMarketplaceSecretVault },
    { provide: NOTIFICATION_REPOSITORY, useClass: DrizzleNotificationRepository },
    { provide: ORDER_PII_VAULT, useFactory: createOrderPiiVault },
    { provide: SHIPMENT_WRITEBACK_ENQUEUER, useClass: RedisShipmentWritebackEnqueuer },
    { provide: POD_ARTWORK_ENQUEUER, useClass: RedisPodArtworkEnqueuer },
    { provide: POD_BATCH_WORKFLOW_ENQUEUER, useClass: RedisPodBatchWorkflowEnqueuer },
    { provide: POD_EXPORT_ENQUEUER, useClass: RedisPodExportEnqueuer },
    { provide: WORKFLOW_NODE_ENQUEUER, useClass: RedisWorkflowNodeEnqueuer },
    {
      provide: WorkflowNodeRuntime,
      inject: [
        DATABASE_CONNECTION,
        PRIVATE_STORAGE,
        POD_ARTWORK_ENQUEUER,
        PodWorkbenchService,
        AuditService,
      ],
      useFactory: (
        database: ReturnType<typeof connectDatabase>,
        storage: ReturnType<typeof createStorageFromEnvironment>,
        enqueuer: PodArtworkEnqueuer,
        workbench: PodWorkbenchService,
        audit: AuditService,
      ) =>
        new WorkflowNodeRuntime(
          database,
          new CatalogPackageService(database, storage),
          new PodArtworkOwner(database, enqueuer, workbench, audit),
        ),
    },
    {
      provide: PERSONALIZATION_TEMPLATE_SOURCE_INSPECTION_ENQUEUER,
      useClass: RedisPersonalizationTemplateSourceInspectionEnqueuer,
    },
    {
      provide: ORDER_PERSONALIZATION_BATCH_ENQUEUER,
      useClass: RedisOrderPersonalizationBatchEnqueuer,
    },
    {
      provide: ORDER_PERSONALIZATION_RENDER_ENQUEUER,
      useClass: RedisOrderPersonalizationRenderEnqueuer,
    },
    AuditService,
    RuleCenterService,
    KnowledgeService,
    MethodGovernanceService,
    KnowledgeImportService,
    KnowledgeGovernanceService,
    KnowledgeEvaluationService,
    KnowledgeBenchmarkDatasetService,
    KnowledgeBenchmarkExperimentService,
    KnowledgeBenchmarkCostService,
    KnowledgeBenchmarkBusinessService,
    KnowledgeAnswerContextService,
    {
      provide: KNOWLEDGE_EVIDENCE_VAULT,
      useFactory: () =>
        createEnvironmentSecretVault(
          "KNOWLEDGE_EVIDENCE_ENCRYPTION_KEY",
          "yummyai:knowledge-evidence",
        ),
    },
    { provide: KNOWLEDGE_DOCUMENT_SCANNER, useFactory: () => new ClamAvScanner() },
    AmazonCustomWorkflowService,
    CaptureService,
    ChannelInventoryService,
    CustomerIntelligenceService,
    AdvertisingService,
    AdvertisingCommandOwnerAdapter,
    AdvertisingCommandService,
    {provide:ADVERTISING_COMMAND_VAULT,useFactory:createAdvertisingCommandVault},
    AdSourceGateway,
    { provide: AD_SOURCE_SCANNER, useFactory: () => new ClamAvScanner() },
    CustomProductPackageService,
    AmazonCustomListingMaterialsService,
    CompetitorShopService,
    DashboardService,
    FulfillmentAttentionService,
    DesignService,
    ProductionEditorService,
    { provide: ProductionEditorRenderEnqueuer, useClass: RedisProductionEditorRenderEnqueuer },
    { provide: ProductionEditorScanner, useClass: ClamAvProductionEditorScanner },
    PodWorkbenchService,
    PodToolActivationPolicy,
    PodArtworkTaskService,
    PodGovernanceService,
    PodPersonalizationService,
    OrderPersonalizationBatchService,
    OrderPersonalizationRenderService,
    PodExportService,
    PodBatchWorkflowService,
    CanvasBridgeService,
    CanvasWorkflowService,
    PodMockupBatchService,
    CreativeExecutionOperatorService,
    CreativeResponseAdoptionService,
    CreativeOwnerResponseAdoptionService,
    FinanceService,
    FinancePayablesService,
    FinancePayablesAdjustmentsService,
    FinanceLedgerService,
    FinanceCostAllocationService,
    FinanceCommandOwnerAdapter,
    FinanceCommandService,
    FinanceCommandResultReader,
    { provide: FINANCE_COMMAND_VAULT, useFactory: createFinanceCommandVault },
    ListingService,
    MarketplaceAccountService,
    MarketplaceAuthorityWorkspaceService,
    StoreNodeService,
    StoreNodeExecutionService,
    { provide: StoreNodeExecutionRuntime, useExisting: StoreNodeExecutionService },
    { provide: StoreNodePki, useFactory: () => StoreNodePki.fromEnvironment() },
    { provide: StoreNodeCertificateIssuer, useExisting: StoreNodePki },
    StoreNodeRuntimeGateway,
    MarketplaceAuthorizationService,
    MarketplaceAutomationService,
    MarketplaceCapabilityService,
    MarketplaceListingSyncService,
    MarketplacePublicationBatchService,
    MarketplacePublicationService,
    NotificationService,
    OrderService,
    AmazonOrderReportService,
    OrderWorkspaceService,
    OrderResponsibilityService,
    BusinessFollowupService,
    OrderWholeDetailService,
    OrderTaskService,
    OrderReviewService,
    { provide: AmazonReportArchiveGateway, useClass: HttpAmazonReportArchiveGateway },
    { provide: AmazonReportRetentionEnqueuer, useClass: RedisAmazonReportRetentionEnqueuer },
    { provide: AmazonReportProcessingEnqueuer, useClass: RedisAmazonReportProcessingEnqueuer },
    FulfillmentAutomationService,
    InventoryService,
    IntegrationService,
    OrderAfterSalesService,
    OrderCustomizationService,
    OrderIngestionService,
    OrderProductionService,
    ProductionCommandService,
    OrderFulfillmentCommandService,
    OrderFulfillmentCommandOwner,
    ProductionMaterialService,
    ProductionMaterialCommandService,
    ProductionQuantityService,
    QualityScrapService,
    NativeProductionService,
    OrderProductionDeliveryService,
    FactoryErpImportService,
    FactoryErpSourceGateway,
    { provide: FACTORY_ERP_SOURCE_SCANNER, useFactory: () => new ClamAvScanner() },
    FactoryCollaborationService,
    OrderShipmentService,
    OrderRoutingService,
    FactoryDirectoryService,
    FactoryCapacityService,
    ShiposService,
    LogisticsService,
    { provide: LogisticsReadOwner, useFactory: (database: DatabaseConnection, pii: SecretVault) => new LogisticsReadOwner(database, pii), inject: [DATABASE_CONNECTION, ORDER_PII_VAULT] },
    { provide: HttpLogisticsGateway, useFactory: () => new HttpLogisticsGateway() },
    { provide: LogisticsEnqueuer, useClass: RedisLogisticsEnqueuer },
    { provide: ShiposReadGateway, useFactory: () => createShiposReadGateway() },
    OrderSyncCoordinator,
    ProcurementService,
    InvoiceReconciliationService,
    IncomingInspectionService,
    IncomingCommandService,
    { provide: INCOMING_COMMAND_VAULT, useFactory: createIncomingCommandVault },
    ProcurementCommandService,
    { provide: PROCUREMENT_COMMAND_VAULT, useFactory: createProcurementCommandVault },
    PlanningService,
    SupplierPerformanceService,
    ProductService,
    TeamDirectoryService,
    ProductSupplyService,
    ResearchClassificationService,
    ResearchRepository,
    ResearchStudyService,
    ResearchArchiveService,
    WorkflowCapabilityRegistry,
    WorkflowDefinitionService,
    WorkflowRunService,
    WorkflowOperatorService,
    WorkflowResponsibilityService,
    HumanExecutor,
    InternalCapabilityExecutor,
    ExternalWorkflowExecutor,
    WorkflowExecutorRouter,
    { provide: APP_GUARD, useClass: TenantContextGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
    { provide: APP_GUARD, useClass: ApiClientRouteGuard },
    { provide: APP_INTERCEPTOR, useClass: ApiClientAuthorityInterceptor },
  ],
})
export class AppModule {}
