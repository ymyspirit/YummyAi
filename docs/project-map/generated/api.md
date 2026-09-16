# API 控制器与接口清单

自动生成于代码基线 `81fa57402451b3812a87a6dd05738473dbe545c8`。这是静态清单，不表示运行时可用或验收通过。更新命令：`node docs/project-map/scripts/generate-inventory.mjs`。

[返回项目地图](../README.md)

注册列仅核对当前 `AppModule.controllers`。未注册定义不能当成可访问接口；已注册仍需启动、鉴权和集成验收。SSE 是 Nest 装饰器名，实际传输为 GET。权限列列出方法级 `RequiresPermission` 并解析 Permission 常量，空值不代表匿名开放，全局 Guard 仍适用。

## AnalysisController

源码：[apps/api/src/ai/analysis.controller.ts](../../../apps/api/src/ai/analysis.controller.ts)；AppModule 注册：**否**。

| 方法 | 路径 | 处理方法 | 行号 | 方法级权限 |
| --- | --- | --- | --- | --- |
| POST | `/v1/ai/analyses` | `create` | 14 | research:read |
| GET | `/v1/ai/analyses/:reportSeriesId` | `latest` | 22 | research:read |
| GET | `/v1/ai/analyses/:reportSeriesId/versions` | `versions` | 30 | research:read |

## ModelConfigController

源码：[apps/api/src/ai/model-config.controller.ts](../../../apps/api/src/ai/model-config.controller.ts)；AppModule 注册：**否**。

| 方法 | 路径 | 处理方法 | 行号 | 方法级权限 |
| --- | --- | --- | --- | --- |
| GET | `/v1/ai/model-configs` | `list` | 45 | model:configure |
| POST | `/v1/ai/model-configs` | `create` | 67 | model:configure |
| PATCH | `/v1/ai/model-configs/:id` | `update` | 91 | model:configure |

## AssetsController

源码：[apps/api/src/assets/assets.controller.ts](../../../apps/api/src/assets/assets.controller.ts)；AppModule 注册：**是**。

| 方法 | 路径 | 处理方法 | 行号 | 方法级权限 |
| --- | --- | --- | --- | --- |
| POST | `/assets` | `upload` | 34 | asset:write |
| POST | `/assets/:id/read-url` | `signRead` | 88 | asset:read |

## CaptureController

源码：[apps/api/src/capture/capture.controller.ts](../../../apps/api/src/capture/capture.controller.ts)；AppModule 注册：**是**。

| 方法 | 路径 | 处理方法 | 行号 | 方法级权限 |
| --- | --- | --- | --- | --- |
| POST | `/v1/captures` | `create` | 13 | capture:write |
| GET | `/v1/captures/:id` | `get` | 21 | capture:read |

## AmazonCustomWorkflowController

源码：[apps/api/src/catalog/amazon-custom-workflow.controller.ts](../../../apps/api/src/catalog/amazon-custom-workflow.controller.ts)；AppModule 注册：**是**。

| 方法 | 路径 | 处理方法 | 行号 | 方法级权限 |
| --- | --- | --- | --- | --- |
| GET | `/v1/products/custom-workflows` | `list` | 16 | product:read |
| GET | `/v1/products/plans/:id/custom-workflow` | `get` | 24 | product:read |
| POST | `/v1/products/plans/:id/custom-workflow` | `start` | 32 | product:write |
| POST | `/v1/products/plans/:id/custom-workflow/steps/:stepKey/transitions` | `transition` | 46 | product:write |
| PATCH | `/v1/products/plans/:id/custom-workflow/steps/:stepKey` | `updateCompletedStepNote` | 62 | product:write |

## CustomProductPackageController

源码：[apps/api/src/catalog/custom-product-package.controller.ts](../../../apps/api/src/catalog/custom-product-package.controller.ts)；AppModule 注册：**是**。

| 方法 | 路径 | 处理方法 | 行号 | 方法级权限 |
| --- | --- | --- | --- | --- |
| GET | `/v1/products/plans/:planId/custom-package/listing-materials/readiness` | `listingMaterialsReadiness` | 34 | product:read |
| GET | `/v1/products/plans/:planId/custom-package/listing-materials` | `exportListingMaterials` | 42 | product:read |
| POST | `/v1/products/plans/:planId/custom-package/provisional` | `provisional` | 58 | product:write |
| PATCH | `/v1/products/plans/:planId/custom-package/profile` | `saveProfile` | 75 | product:write |
| GET | `/v1/products/plans/:planId/custom-package/completeness` | `completeness` | 91 | product:read |
| GET | `/v1/products/plans/:planId/custom-package` | `export` | 99 | product:read |

## ProductController

源码：[apps/api/src/catalog/product.controller.ts](../../../apps/api/src/catalog/product.controller.ts)；AppModule 注册：**是**。

| 方法 | 路径 | 处理方法 | 行号 | 方法级权限 |
| --- | --- | --- | --- | --- |
| GET | `/v1/products/plans` | `list` | 20 | product:read |
| POST | `/v1/products/plans` | `createPlan` | 28 | product:write |
| PATCH | `/v1/products/plans/:id/customization` | `updateCustomization` | 36 | product:write |
| POST | `/v1/products/plans/:id/transitions` | `transition` | 52 | product:write |
| POST | `/v1/products/plans/:id/spu` | `createSpu` | 61 | product:write |
| POST | `/v1/products/skus` | `createSku` | 69 | product:write |

## ChannelInventoryController

源码：[apps/api/src/channel-inventory/channel-inventory.controller.ts](../../../apps/api/src/channel-inventory/channel-inventory.controller.ts)；AppModule 注册：**是**。

| 方法 | 路径 | 处理方法 | 行号 | 方法级权限 |
| --- | --- | --- | --- | --- |
| GET | `/v1/channel-inventory/workspace` | `workspace` | 20 | channel_inventory:read |
| POST | `/v1/channel-inventory/snapshots` | `recordSnapshot` | 28 | channel_inventory:write |
| POST | `/v1/channel-inventory/allocation-policies` | `upsertPolicy` | 36 | channel_inventory:write |
| POST | `/v1/channel-inventory/allocation-runs` | `runAllocation` | 44 | channel_inventory:write |
| POST | `/v1/channel-inventory/reconciliations` | `recordReconciliation` | 52 | channel_inventory:write |
| POST | `/v1/channel-inventory/reconciliations/:reconciliationId/resolve` | `resolveReconciliation` | 63 | channel_inventory:reconcile |

## CompetitorShopController

源码：[apps/api/src/competitors/competitor-shop.controller.ts](../../../apps/api/src/competitors/competitor-shop.controller.ts)；AppModule 注册：**是**。

| 方法 | 路径 | 处理方法 | 行号 | 方法级权限 |
| --- | --- | --- | --- | --- |
| GET | `/v1/competitor-shops` | `list` | 13 | research:read |
| GET | `/v1/competitor-shops/:id/snapshots` | `timeline` | 21 | research:read |
| POST | `/v1/competitor-shops/captures` | `create` | 29 | capture:write |

## CustomerIntelligenceController

源码：[apps/api/src/customer-intelligence/customer-intelligence.controller.ts](../../../apps/api/src/customer-intelligence/customer-intelligence.controller.ts)；AppModule 注册：**是**。

| 方法 | 路径 | 处理方法 | 行号 | 方法级权限 |
| --- | --- | --- | --- | --- |
| GET | `/v1/customer-intelligence/workspace` | `workspace` | 12 | customer_intelligence:read |
| POST | `/v1/customer-intelligence/advertising-reports` | `recordAdvertisingReport` | 13 | customer_intelligence:write |
| POST | `/v1/customer-intelligence/signals` | `recordSignal` | 14 | customer_intelligence:write |
| POST | `/v1/customer-intelligence/definitions` | `upsertDefinition` | 15 | customer_intelligence:review |
| POST | `/v1/customer-intelligence/analyses` | `calculateAnalysis` | 16 | customer_intelligence:review |
| POST | `/v1/customer-intelligence/recommendations/:recommendationId/review` | `reviewRecommendation` | 17 | customer_intelligence:review |

## DashboardController

源码：[apps/api/src/dashboard/dashboard.controller.ts](../../../apps/api/src/dashboard/dashboard.controller.ts)；AppModule 注册：**是**。

| 方法 | 路径 | 处理方法 | 行号 | 方法级权限 |
| --- | --- | --- | --- | --- |
| GET | `/v1/dashboard` | `metrics` | 12 | dashboard:read |

## CanvasBridgeController

源码：[apps/api/src/design/canvas-bridge.controller.ts](../../../apps/api/src/design/canvas-bridge.controller.ts)；AppModule 注册：**是**。

| 方法 | 路径 | 处理方法 | 行号 | 方法级权限 |
| --- | --- | --- | --- | --- |
| GET | `/v1/canvas-bridge/briefs` | `list` | 13 | design:read |
| GET | `/v1/canvas-bridge/options` | `options` | 15 | design:read, asset:read |
| POST | `/v1/canvas-bridge/briefs` | `create` | 17 | design:read, design:write, asset:read |
| GET | `/v1/canvas-bridge/briefs/:id` | `get` | 19 | design:read, asset:read |
| GET | `/v1/canvas-bridge/briefs/:id/assets/:assetId` | `asset` | 21 | design:read, asset:read |
| POST | `/v1/canvas-bridge/briefs/:id/results` | `submit` | 23 | design:write, asset:write, asset:read |
| GET | `/v1/canvas-bridge/production-templates` | `templates` | 25 | design:read |
| GET | `/v1/canvas-bridge/briefs/:id/results` | `results` | 27 | design:read, asset:read |
| GET | `/v1/canvas-bridge/briefs/:id/results/:versionId/preview` | `preview` | 29 | design:read, asset:read |
| POST | `/v1/canvas-bridge/briefs/:id/review` | `review` | 33 | design:read, design:review, asset:read |
| POST | `/v1/canvas-bridge/briefs/:id/continue` | `continue` | 35 | design:read, design:write, asset:read |
| POST | `/v1/canvas-bridge/briefs/:id/production` | `production` | 37 | design:read, design:write, asset:read |

## DesignController

源码：[apps/api/src/design/design.controller.ts](../../../apps/api/src/design/design.controller.ts)；AppModule 注册：**是**。

| 方法 | 路径 | 处理方法 | 行号 | 方法级权限 |
| --- | --- | --- | --- | --- |
| GET | `/v1/design/tasks` | `listTasks` | 19 | design:read |
| POST | `/v1/design/tasks` | `createTask` | 27 | design:write |
| GET | `/v1/design/tasks/:id/versions` | `listVersions` | 35 | design:read |
| POST | `/v1/design/tasks/:id/versions` | `uploadVersion` | 43 | design:write |
| POST | `/v1/design/versions/:id/review` | `reviewVersion` | 51 | design:review |
| POST | `/v1/design/tasks/:taskId/primary/:versionId` | `setPrimary` | 59 | design:review |
| POST | `/v1/design/assets/:id/rights` | `approveRights` | 67 | asset:promote |
| POST | `/v1/design/assets/:id/promote` | `promoteAsset` | 76 | asset:promote |
| POST | `/v1/design/versions/:versionId/files/:fileId/read-url` | `signFile` | 84 | asset:read |

## OrderPersonalizationBatchController

源码：[apps/api/src/design/order-personalization-batch.controller.ts](../../../apps/api/src/design/order-personalization-batch.controller.ts)；AppModule 注册：**是**。

| 方法 | 路径 | 处理方法 | 行号 | 方法级权限 |
| --- | --- | --- | --- | --- |
| GET | `/v1/pod/order-personalization-batches` | `list` | 14 | order:read, design:read |
| GET | `/v1/pod/order-personalization-batches/options` | `options` | 23 | order:read, design:read |
| GET | `/v1/pod/order-personalization-batches/:id` | `get` | 32 | order:read, design:read |
| POST | `/v1/pod/order-personalization-batches` | `create` | 41 | order:write, order:pii:read, design:write |

## OrderPersonalizationRenderController

源码：[apps/api/src/design/order-personalization-render.controller.ts](../../../apps/api/src/design/order-personalization-render.controller.ts)；AppModule 注册：**是**。

| 方法 | 路径 | 处理方法 | 行号 | 方法级权限 |
| --- | --- | --- | --- | --- |
| GET | `/v1/pod/order-personalization-render-tasks` | `list` | 14 | order:read, design:read |
| GET | `/v1/pod/order-personalization-render-tasks/:id` | `get` | 23 | order:read, design:read |
| POST | `/v1/pod/order-personalization-render-tasks` | `create` | 32 | order:write, order:pii:read, design:write |

## PodBatchWorkflowController

源码：[apps/api/src/design/pod-batch-workflow.controller.ts](../../../apps/api/src/design/pod-batch-workflow.controller.ts)；AppModule 注册：**是**。

| 方法 | 路径 | 处理方法 | 行号 | 方法级权限 |
| --- | --- | --- | --- | --- |
| GET | `/v1/pod/batch-capabilities` | `capabilities` | 28 | design:read |
| GET | `/v1/pod/design-batches` | `listDesignBatches` | 35 | design:read |
| GET | `/v1/pod/design-batches/options` | `designOptions` | 42 | design:read |
| POST | `/v1/pod/design-batches` | `createDesignBatch` | 49 | design:write |
| GET | `/v1/pod/design-batches/:id` | `getDesignBatch` | 56 | design:read |
| POST | `/v1/pod/design-batches/:id/cancel` | `cancelDesignBatch` | 63 | design:write |
| POST | `/v1/pod/design-batches/:id/items/:itemId/retry` | `retryDesignItem` | 70 | design:write |
| POST | `/v1/pod/design-batches/:id/candidates/:candidateId/select` | `selectCandidate` | 77 | design:write |
| POST | `/v1/pod/creative-design-versions/:id/review` | `reviewCreativeVersion` | 84 | design:review |
| POST | `/v1/pod/creative-design-versions/:id/sku-bindings` | `createSkuBindings` | 91 | design:write |
| GET | `/v1/pod/print-specs` | `listPrintSpecs` | 98 | design:read |
| POST | `/v1/pod/print-specs` | `createPrintSpec` | 105 | design:write |
| POST | `/v1/pod/print-specs/:versionId/review` | `reviewPrintSpec` | 112 | design:review |
| GET | `/v1/pod/mockup-template-inspections` | `listInspections` | 119 | design:read |
| POST | `/v1/pod/mockup-template-inspections` | `createInspection` | 126 | design:write |
| POST | `/v1/pod/mockup-template-inspections/:id/confirm` | `confirmInspection` | 133 | design:review |
| GET | `/v1/pod/mockup-template-packs` | `listTemplatePacks` | 140 | design:read |
| POST | `/v1/pod/mockup-template-packs` | `createTemplatePack` | 147 | design:write |
| POST | `/v1/pod/mockup-template-packs/:versionId/review` | `reviewTemplatePack` | 154 | design:review |
| GET | `/v1/pod/mockup-batches` | `listMockupBatches` | 161 | design:read |
| GET | `/v1/pod/mockup-batches/options` | `mockupOptions` | 168 | design:read |
| POST | `/v1/pod/mockup-batches` | `createMockupBatch` | 175 | design:write |
| GET | `/v1/pod/mockup-batches/:id` | `getMockupBatch` | 182 | design:read |
| POST | `/v1/pod/mockup-batches/:id/cancel` | `cancelMockupBatch` | 189 | design:write |
| POST | `/v1/pod/mockup-batches/:id/outputs/:outputId/retry` | `retryMockupOutput` | 196 | design:write |
| POST | `/v1/pod/mockup-batches/:id/review` | `reviewMockupBatch` | 203 | design:review |
| POST | `/v1/pod/mockup-batches/:id/listing-bindings` | `createListingBindings` | 210 | design:write |

## PodExportController

源码：[apps/api/src/design/pod-export.controller.ts](../../../apps/api/src/design/pod-export.controller.ts)；AppModule 注册：**是**。

| 方法 | 路径 | 处理方法 | 行号 | 方法级权限 |
| --- | --- | --- | --- | --- |
| POST | `/v1/pod/tasks/:taskId/exports` | `requestExport` | 14 | design:review |
| GET | `/v1/pod/tasks/:taskId/exports` | `listExports` | 22 | design:read |
| GET | `/v1/pod/exports/:id` | `getExport` | 30 | design:read |
| POST | `/v1/pod/exports/:id/read-url` | `signDownload` | 38 | asset:read |

## PodGovernanceController

源码：[apps/api/src/design/pod-governance.controller.ts](../../../apps/api/src/design/pod-governance.controller.ts)；AppModule 注册：**是**。

| 方法 | 路径 | 处理方法 | 行号 | 方法级权限 |
| --- | --- | --- | --- | --- |
| GET | `/v1/pod/recipes` | `listRecipes` | 20 | design:read |
| POST | `/v1/pod/recipes` | `createRecipe` | 28 | design:write |
| GET | `/v1/pod/rights-assessments/:assetId` | `listRightsAssessments` | 36 | design:read |
| POST | `/v1/pod/rights-assessments` | `createRightsAssessment` | 44 | design:review |
| POST | `/v1/pod/visual-fingerprints` | `registerFingerprint` | 52 | design:write |
| POST | `/v1/pod/visual-search` | `visualSearch` | 60 | design:read |
| GET | `/v1/pod/listing-artifacts/:listingVersionId` | `listListingArtifacts` | 68 | design:read |
| GET | `/v1/pod/listing-options` | `listingOptions` | 76 | design:read |
| POST | `/v1/pod/listing-artifacts` | `createListingArtifact` | 84 | design:write |
| GET | `/v1/pod/trace/assets/:assetId` | `traceAsset` | 92 | design:read |

## PodPersonalizationController

源码：[apps/api/src/design/pod-personalization.controller.ts](../../../apps/api/src/design/pod-personalization.controller.ts)；AppModule 注册：**是**。

| 方法 | 路径 | 处理方法 | 行号 | 方法级权限 |
| --- | --- | --- | --- | --- |
| GET | `/v1/pod/personalization-templates` | `listTemplates` | 22 | design:read |
| GET | `/v1/pod/personalization-template-source-inspections` | `listTemplateSourceInspections` | 30 | design:read |
| POST | `/v1/pod/personalization-template-source-inspections` | `createTemplateSourceInspection` | 38 | design:write |
| GET | `/v1/pod/personalization-template-source-inspections/:id` | `getTemplateSourceInspection` | 46 | design:read |
| POST | `/v1/pod/personalization-template-source-inspections/:id/confirm` | `confirmTemplateSourceInspection` | 54 | design:write |
| POST | `/v1/pod/personalization-templates` | `createTemplate` | 66 | design:write |
| GET | `/v1/pod/personalization-options` | `personalizationOptions` | 74 | design:read |
| POST | `/v1/pod/personalization-templates/:id/clone` | `cloneTemplate` | 82 | design:write |
| POST | `/v1/pod/personalization-templates/:id/review` | `reviewTemplate` | 94 | design:review |
| GET | `/v1/pod/template-bindings/:skuId` | `listBindings` | 102 | design:read |
| POST | `/v1/pod/template-bindings` | `createBinding` | 110 | design:write |
| GET | `/v1/pod/production-manifests` | `listProductionManifests` | 118 | design:read |
| POST | `/v1/pod/production-manifests` | `createProductionManifest` | 126 | design:write |
| POST | `/v1/pod/production-manifests/:id/review` | `reviewProductionManifest` | 134 | design:review |

## PodWorkbenchController

源码：[apps/api/src/design/pod-workbench.controller.ts](../../../apps/api/src/design/pod-workbench.controller.ts)；AppModule 注册：**是**。

| 方法 | 路径 | 处理方法 | 行号 | 方法级权限 |
| --- | --- | --- | --- | --- |
| GET | `/v1/pod/tools` | `getToolCatalog` | 18 | design:read |
| GET | `/v1/pod/tasks` | `listTasks` | 26 | design:read |
| GET | `/v1/pod/input-options/:toolKey` | `inputOptions` | 34 | design:read |
| GET | `/v1/pod/tasks/:id` | `getTask` | 42 | design:read |
| POST | `/v1/pod/tasks` | `createTask` | 50 | design:write |

## ProductionEditorController

源码：[apps/api/src/design/production-editor.controller.ts](../../../apps/api/src/design/production-editor.controller.ts)；AppModule 注册：**是**。

| 方法 | 路径 | 处理方法 | 行号 | 方法级权限 |
| --- | --- | --- | --- | --- |
| GET | `/v1/production-editor/projects` | `list` | 16 | design:read |
| POST | `/v1/production-editor/projects` | `create` | 18 | design:write |
| GET | `/v1/production-editor/projects/:id` | `get` | 20 | design:read |
| DELETE | `/v1/production-editor/projects/:id` | `remove` | 22 | design:write |
| POST | `/v1/production-editor/projects/:id/versions` | `save` | 24 | design:write |
| POST | `/v1/production-editor/projects/:id/review` | `review` | 26 | design:review |
| GET | `/v1/production-editor/projects/:id/images` | `images` | 28 | design:read |
| GET | `/v1/production-editor/projects/:id/fonts` | `fonts` | 30 | design:read |
| GET | `/v1/production-editor/projects/:id/images/:imageId/cutout` | `cutout` | 32 | design:read, asset:read |
| POST | `/v1/production-editor/projects/:id/images/:imageId/segment` | `segment` | 34 | design:write, asset:read |
| POST | `/v1/production-editor/projects/:id/images/:imageId/cutout` | `applyCutout` | 36 | design:write, asset:read |
| POST | `/v1/production-editor/projects/:id/images/:imageId/refine` | `refine` | 38 | design:write, asset:read |
| POST | `/v1/production-editor/projects/:id/images` | `imageUpload` | 40 | design:write |
| POST | `/v1/production-editor/projects/:id/fonts` | `fontUpload` | 42 | design:write |
| GET | `/v1/production-editor/projects/:id/images/:imageId` | `image` | 44 | design:read, asset:read |
| GET | `/v1/production-editor/projects/:id/fonts/:fontId` | `font` | 46 | design:read, asset:read |
| POST | `/v1/production-editor/projects/:id/preflight` | `preflight` | 48 | design:read |
| POST | `/v1/production-editor/projects/:id/renders` | `render` | 50 | design:write |
| GET | `/v1/production-editor/projects/:id/renders/:renderId` | `getRender` | 52 | design:read |
| GET | `/v1/production-editor/projects/:id/renders/:renderId/files/:key` | `file` | 54 | design:read, asset:read |

## FinanceController

源码：[apps/api/src/finance/finance.controller.ts](../../../apps/api/src/finance/finance.controller.ts)；AppModule 注册：**是**。

| 方法 | 路径 | 处理方法 | 行号 | 方法级权限 |
| --- | --- | --- | --- | --- |
| GET | `/v1/finance/workspace` | `workspace` | 19 | finance:read |
| GET | `/v1/finance/statements/:statementId` | `statement` | 27 | finance:read |
| GET | `/v1/finance/profit-runs/:runId` | `profitRun` | 35 | finance:read |
| POST | `/v1/finance/statements` | `recordStatement` | 43 | finance:write |
| POST | `/v1/finance/fx-rates` | `recordFxRate` | 51 | finance:write |
| POST | `/v1/finance/profit-metrics` | `upsertProfitMetric` | 59 | finance:review |
| POST | `/v1/finance/profit-runs` | `calculateProfit` | 70 | finance:review |

## HealthController

源码：[apps/api/src/health.controller.ts](../../../apps/api/src/health.controller.ts)；AppModule 注册：**是**。

| 方法 | 路径 | 处理方法 | 行号 | 方法级权限 |
| --- | --- | --- | --- | --- |
| GET | `/health` | `check` | 11 | 见源码/全局 Guard |

## IntegrationController

源码：[apps/api/src/integrations/integration.controller.ts](../../../apps/api/src/integrations/integration.controller.ts)；AppModule 注册：**是**。

| 方法 | 路径 | 处理方法 | 行号 | 方法级权限 |
| --- | --- | --- | --- | --- |
| GET | `/v1/integrations/workspace` | `workspace` | 13 | integration:read |
| POST | `/v1/integrations/api-clients` | `createClient` | 14 | integration:manage |
| POST | `/v1/integrations/api-clients/:clientId/revoke` | `revokeClient` | 15 | integration:manage |
| POST | `/v1/integrations/webhook-endpoints` | `createEndpoint` | 16 | integration:manage |
| PATCH | `/v1/integrations/webhook-endpoints/:endpointId` | `updateEndpoint` | 17 | integration:manage |
| POST | `/v1/integrations/webhook-endpoints/:endpointId/rotate-secret` | `rotateEndpointSecret` | 18 | integration:manage |
| POST | `/v1/integrations/webhook-events` | `publishEvent` | 19 | integration:manage |
| POST | `/v1/integrations/webhook-deliveries/:deliveryId/replay` | `replayDelivery` | 20 | integration:manage |
| POST | `/v1/integrations/retention-runs` | `runRetention` | 21 | integration:manage |

## InventoryController

源码：[apps/api/src/inventory/inventory.controller.ts](../../../apps/api/src/inventory/inventory.controller.ts)；AppModule 注册：**是**。

| 方法 | 路径 | 处理方法 | 行号 | 方法级权限 |
| --- | --- | --- | --- | --- |
| GET | `/v1/inventory/workspace` | `workspace` | 27 | inventory:read |
| GET | `/v1/inventory/warehouses` | `warehouses` | 35 | inventory:read |
| POST | `/v1/inventory/warehouses` | `createWarehouse` | 43 | inventory:write |
| GET | `/v1/inventory/locations` | `locations` | 51 | inventory:read |
| POST | `/v1/inventory/locations` | `createLocation` | 59 | inventory:write |
| GET | `/v1/inventory/stock-items` | `stockItems` | 67 | inventory:read |
| POST | `/v1/inventory/stock-items` | `createStockItem` | 75 | inventory:write |
| GET | `/v1/inventory/lots` | `lots` | 83 | inventory:read |
| POST | `/v1/inventory/lots` | `createLot` | 91 | inventory:write |
| GET | `/v1/inventory/movements` | `movements` | 99 | inventory:read |
| POST | `/v1/inventory/movements` | `recordMovement` | 107 | inventory:write |
| GET | `/v1/inventory/balances` | `balances` | 115 | inventory:read |
| GET | `/v1/inventory/reservations` | `reservations` | 123 | inventory:read |
| GET | `/v1/inventory/reservations/:reservationId` | `reservation` | 131 | inventory:read |
| POST | `/v1/inventory/reservations` | `createReservation` | 139 | inventory:write |
| POST | `/v1/inventory/reservations/:reservationId/release` | `releaseReservation` | 147 | inventory:write |
| GET | `/v1/inventory/transfers` | `transfers` | 163 | inventory:read |
| GET | `/v1/inventory/transfers/:transferId` | `transfer` | 171 | inventory:read |
| POST | `/v1/inventory/transfers` | `createTransfer` | 179 | inventory:write |
| POST | `/v1/inventory/transfers/:transferId/dispatch` | `dispatchTransfer` | 187 | inventory:write |
| POST | `/v1/inventory/transfers/:transferId/receive` | `receiveTransfer` | 203 | inventory:write |
| POST | `/v1/inventory/transfers/:transferId/cancel` | `cancelTransfer` | 219 | inventory:write |
| POST | `/v1/inventory/projections/rebuild` | `rebuildProjection` | 235 | inventory:write |

## JobEventsController

源码：[apps/api/src/jobs/job-events.controller.ts](../../../apps/api/src/jobs/job-events.controller.ts)；AppModule 注册：**否**。

| 方法 | 路径 | 处理方法 | 行号 | 方法级权限 |
| --- | --- | --- | --- | --- |
| SSE | `/v1/job-events` | `stream` | 18 | job:read |

## ListingController

源码：[apps/api/src/listings/listing.controller.ts](../../../apps/api/src/listings/listing.controller.ts)；AppModule 注册：**是**。

| 方法 | 路径 | 处理方法 | 行号 | 方法级权限 |
| --- | --- | --- | --- | --- |
| GET | `/v1/listings` | `list` | 15 | listing:read |
| GET | `/v1/listings/catalog` | `catalog` | 19 | listing:read |
| GET | `/v1/listings/:id` | `get` | 26 | listing:read |
| POST | `/v1/listings` | `create` | 30 | listing:write |
| GET | `/v1/listings/:id/versions` | `versions` | 38 | listing:read |
| POST | `/v1/listings/:id/versions` | `save` | 42 | listing:write |
| POST | `/v1/listings/:id/ai-versions` | `ai` | 46 | listing:write |
| POST | `/v1/listings/:id/versions/:versionId/approve` | `approve` | 50 | listing:review |
| GET | `/v1/listings/:id/replications` | `replications` | 54 | listing:read |
| POST | `/v1/listings/:id/replications` | `replicate` | 58 | listing:write |

## MarketplaceAccountController

源码：[apps/api/src/marketplaces/marketplace-account.controller.ts](../../../apps/api/src/marketplaces/marketplace-account.controller.ts)；AppModule 注册：**是**。

| 方法 | 路径 | 处理方法 | 行号 | 方法级权限 |
| --- | --- | --- | --- | --- |
| GET | `/v1/marketplace-accounts` | `list` | 26 | store:read |
| GET | `/v1/marketplace-accounts/:id` | `get` | 34 | store:read |
| POST | `/v1/marketplace-accounts` | `create` | 42 | store:manage |
| PATCH | `/v1/marketplace-accounts/:id` | `update` | 50 | store:manage |
| POST | `/v1/marketplace-accounts/:id/authorization/private` | `authorizePrivate` | 58 | store:authorize |
| POST | `/v1/marketplace-accounts/:id/authorization/oauth/start` | `startOAuth` | 70 | store:authorize |
| POST | `/v1/marketplace-accounts/:id/authorization/oauth/complete` | `completeOAuth` | 78 | store:authorize |
| DELETE | `/v1/marketplace-accounts/:id/authorization` | `revokeAuthorization` | 90 | store:authorize |
| GET | `/v1/marketplace-accounts/:id/capabilities` | `latestCapabilities` | 98 | store:read |
| POST | `/v1/marketplace-accounts/:id/capabilities/sync` | `syncCapabilities` | 106 | store:manage |

## MarketplaceAutomationController

源码：[apps/api/src/marketplaces/marketplace-automation.controller.ts](../../../apps/api/src/marketplaces/marketplace-automation.controller.ts)；AppModule 注册：**是**。

| 方法 | 路径 | 处理方法 | 行号 | 方法级权限 |
| --- | --- | --- | --- | --- |
| POST | `/v1/marketplace-automation-rules` | `create` | 14 | listing:publish |
| GET | `/v1/marketplace-automation-rules` | `list` | 21 | listing:read |
| PATCH | `/v1/marketplace-automation-rules/:id` | `update` | 28 | listing:publish |
| GET | `/v1/marketplace-automation-rules/:id/runs` | `runs` | 35 | listing:read |

## MarketplaceListingSyncController

源码：[apps/api/src/marketplaces/marketplace-listing-sync.controller.ts](../../../apps/api/src/marketplaces/marketplace-listing-sync.controller.ts)；AppModule 注册：**是**。

| 方法 | 路径 | 处理方法 | 行号 | 方法级权限 |
| --- | --- | --- | --- | --- |
| POST | `/v1/marketplace-listing-syncs` | `create` | 14 | listing:publish |
| GET | `/v1/marketplace-listing-syncs` | `list` | 18 | listing:read |
| GET | `/v1/marketplace-listing-syncs/:id` | `get` | 22 | listing:read |
| GET | `/v1/marketplace-listing-syncs/:id/events` | `events` | 26 | listing:read |

## MarketplacePublicationBatchController

源码：[apps/api/src/marketplaces/marketplace-publication-batch.controller.ts](../../../apps/api/src/marketplaces/marketplace-publication-batch.controller.ts)；AppModule 注册：**是**。

| 方法 | 路径 | 处理方法 | 行号 | 方法级权限 |
| --- | --- | --- | --- | --- |
| POST | `/v1/marketplace-publication-batches` | `create` | 18 | listing:publish |
| POST | `/v1/marketplace-publication-batches/:id/continue` | `continue` | 26 | listing:publish |
| POST | `/v1/marketplace-publication-batches/:id/cancel` | `cancel` | 34 | listing:publish |
| GET | `/v1/marketplace-publication-batches` | `list` | 42 | listing:read |
| GET | `/v1/marketplace-publication-batches/:id` | `get` | 50 | listing:read |

## MarketplacePublicationController

源码：[apps/api/src/marketplaces/marketplace-publication.controller.ts](../../../apps/api/src/marketplaces/marketplace-publication.controller.ts)；AppModule 注册：**是**。

| 方法 | 路径 | 处理方法 | 行号 | 方法级权限 |
| --- | --- | --- | --- | --- |
| POST | `/v1/marketplace-publications` | `create` | 20 | listing:publish |
| POST | `/v1/marketplace-publications/:id/continue` | `continue` | 28 | listing:publish |
| POST | `/v1/marketplace-publications/:id/cancel` | `cancel` | 36 | listing:publish |
| GET | `/v1/marketplace-publications` | `list` | 48 | listing:read |
| GET | `/v1/marketplace-publications/:id` | `get` | 56 | listing:read |
| GET | `/v1/marketplace-publications/:id/events` | `events` | 64 | listing:read |

## NotificationController

源码：[apps/api/src/notifications/notification.controller.ts](../../../apps/api/src/notifications/notification.controller.ts)；AppModule 注册：**是**。

| 方法 | 路径 | 处理方法 | 行号 | 方法级权限 |
| --- | --- | --- | --- | --- |
| GET | `/v1/notifications` | `list` | 11 | notification:read |
| PATCH | `/v1/notifications/read-all` | `markAll` | 13 | notification:read |
| PATCH | `/v1/notifications/:id/read` | `markOne` | 15 | notification:read |

## AmazonOrderReportController

源码：[apps/api/src/orders/amazon-order-report.controller.ts](../../../apps/api/src/orders/amazon-order-report.controller.ts)；AppModule 注册：**是**。

| 方法 | 路径 | 处理方法 | 行号 | 方法级权限 |
| --- | --- | --- | --- | --- |
| GET | `/v1/orders/reports/workspace` | `workspace` | 20 | order:read |
| POST | `/v1/orders/reports/import` | `importReport` | 25 | order:write |
| GET | `/v1/orders/reports/lines/:id` | `detail` | 30 | order:pii:read |
| POST | `/v1/orders/reports/lines/:id/process` | `process` | 35 | order:write |
| POST | `/v1/orders/reports/lines/:id/upload` | `upload` | 40 | order:write |
| POST | `/v1/orders/reports/lines/:id/review` | `review` | 50 | order:write |
| GET | `/v1/orders/reports/lines/:id/files/:key` | `file` | 55 | order:pii:read |

## FulfillmentAutomationController

源码：[apps/api/src/orders/fulfillment-automation.controller.ts](../../../apps/api/src/orders/fulfillment-automation.controller.ts)；AppModule 注册：**是**。

| 方法 | 路径 | 处理方法 | 行号 | 方法级权限 |
| --- | --- | --- | --- | --- |
| GET | `/v1/fulfillment-automations` | `list` | 16 | order:read |
| GET | `/v1/fulfillment-automations/:taskId` | `get` | 18 | order:read |
| POST | `/v1/fulfillment-automations` | `schedule` | 20 | order:write |
| POST | `/v1/fulfillment-automations/:taskId/cancel` | `cancel` | 22 | order:write |
| POST | `/v1/fulfillment-automations/:taskId/reconcile` | `reconcile` | 24 | order:write |
| PATCH | `/v1/fulfillment-automations/policy` | `policy` | 26 | order:write |

## OrderAfterSalesController

源码：[apps/api/src/orders/order-after-sales.controller.ts](../../../apps/api/src/orders/order-after-sales.controller.ts)；AppModule 注册：**是**。

| 方法 | 路径 | 处理方法 | 行号 | 方法级权限 |
| --- | --- | --- | --- | --- |
| GET | `/v1/after-sales-cases` | `list` | 18 | order:read |
| GET | `/v1/after-sales-cases/:caseId` | `get` | 25 | order:read |
| POST | `/v1/after-sales-cases/:caseId/contacts` | `contact` | 32 | order:write |
| POST | `/v1/after-sales-cases/:caseId/decisions` | `decide` | 39 | order:write |
| POST | `/v1/after-sales-cases/:caseId/return-shipments` | `createReturn` | 46 | order:write |
| POST | `/v1/after-sales-cases/:caseId/return-shipments/:returnShipmentId/events` | `returnEvent` | 53 | order:write |
| POST | `/v1/after-sales-cases/:caseId/replacements` | `replacement` | 60 | order:write |
| POST | `/v1/after-sales-cases/:caseId/responsibility-evidence` | `evidence` | 67 | order:write |

## OrderAfterSalesCommandController

源码：[apps/api/src/orders/order-after-sales.controller.ts](../../../apps/api/src/orders/order-after-sales.controller.ts)；AppModule 注册：**是**。

| 方法 | 路径 | 处理方法 | 行号 | 方法级权限 |
| --- | --- | --- | --- | --- |
| POST | `/v1/orders/:id/after-sales-cases` | `create` | 79 | order:write |

## OrderProductionController

源码：[apps/api/src/orders/order-production.controller.ts](../../../apps/api/src/orders/order-production.controller.ts)；AppModule 注册：**是**。

| 方法 | 路径 | 处理方法 | 行号 | 方法级权限 |
| --- | --- | --- | --- | --- |
| GET | `/v1/production/orders` | `list` | 18 | order:read |
| GET | `/v1/production/orders/:productionOrderId` | `get` | 22 | order:read |
| POST | `/v1/production/orders/:productionOrderId/milestones` | `milestone` | 26 | order:write |
| POST | `/v1/production/orders/:productionOrderId/inspections` | `inspect` | 30 | order:write |
| POST | `/v1/production/batches` | `createBatch` | 34 | order:write |
| GET | `/v1/production/batches/:batchId` | `getBatch` | 38 | order:read |
| POST | `/v1/production/batches/:batchId/events` | `batchEvent` | 42 | order:write |
| POST | `/v1/production/quality-standards` | `standard` | 46 | order:write |
| POST | `/v1/production/recoveries` | `recover` | 50 | order:write |
| GET | `/v1/production/recoveries/:recoveryCaseId` | `getRecovery` | 54 | order:read |
| POST | `/v1/production/recoveries/:recoveryCaseId/events` | `recoveryEvent` | 58 | order:write |

## OrderProductionCommandController

源码：[apps/api/src/orders/order-production.controller.ts](../../../apps/api/src/orders/order-production.controller.ts)；AppModule 注册：**是**。

| 方法 | 路径 | 处理方法 | 行号 | 方法级权限 |
| --- | --- | --- | --- | --- |
| POST | `/v1/orders/:id/production` | `create` | 67 | order:write |

## OrderShipmentController

源码：[apps/api/src/orders/order-shipment.controller.ts](../../../apps/api/src/orders/order-shipment.controller.ts)；AppModule 注册：**是**。

| 方法 | 路径 | 处理方法 | 行号 | 方法级权限 |
| --- | --- | --- | --- | --- |
| GET | `/v1/shipments` | `list` | 17 | order:read |
| GET | `/v1/shipments/writebacks/:requestId` | `getWriteback` | 21 | order:read |
| POST | `/v1/shipments/writebacks/:requestId/events` | `writebackEvent` | 25 | order:write |
| GET | `/v1/shipments/:shipmentId` | `get` | 29 | order:read |
| POST | `/v1/shipments/:shipmentId/versions` | `version` | 33 | order:write |
| POST | `/v1/shipments/:shipmentId/versions/:versionId/reviews` | `review` | 37 | order:write |
| POST | `/v1/shipments/:shipmentId/writebacks` | `writeback` | 41 | order:write |
| POST | `/v1/shipments/:shipmentId/tracking-events` | `tracking` | 45 | order:write |

## OrderShipmentCommandController

源码：[apps/api/src/orders/order-shipment.controller.ts](../../../apps/api/src/orders/order-shipment.controller.ts)；AppModule 注册：**是**。

| 方法 | 路径 | 处理方法 | 行号 | 方法级权限 |
| --- | --- | --- | --- | --- |
| POST | `/v1/orders/:id/shipments` | `create` | 54 | order:write |

## OrderController

源码：[apps/api/src/orders/order.controller.ts](../../../apps/api/src/orders/order.controller.ts)；AppModule 注册：**是**。

| 方法 | 路径 | 处理方法 | 行号 | 方法级权限 |
| --- | --- | --- | --- | --- |
| GET | `/v1/orders` | `list` | 30 | order:read |
| GET | `/v1/orders/ingestion/runs` | `ingestionRuns` | 34 | order:read |
| GET | `/v1/orders/customizations` | `customizationRequirements` | 38 | order:read |
| GET | `/v1/orders/routing` | `routingDecisions` | 42 | order:read |
| GET | `/v1/orders/exceptions` | `exceptionQueue` | 46 | order:read |
| GET | `/v1/orders/:id/customizations/:requirementId` | `customizationRequirement` | 53 | order:read |
| POST | `/v1/orders/:id/customizations` | `initializeCustomization` | 57 | order:write |
| POST | `/v1/orders/:id/customizations/:requirementId/versions` | `remapCustomization` | 61 | order:write |
| POST | `/v1/orders/:id/customizations/:requirementId/versions/:versionId/files` | `registerCustomizationFile` | 65 | order:write |
| POST | `/v1/orders/:id/customizations/:requirementId/files/:intakeId/scan` | `queueCustomizationFileScan` | 69 | order:write |
| POST | `/v1/orders/:id/customizations/:requirementId/files/:intakeId/promote` | `promoteCustomizationFile` | 73 | order:write |
| POST | `/v1/orders/:id/customizations/:requirementId/proofs` | `createProof` | 77 | order:write |
| POST | `/v1/orders/:id/proofs/:proofId/decisions` | `recordProofDecision` | 81 | order:write |
| POST | `/v1/orders/:id/routing` | `route` | 85 | order:write |
| GET | `/v1/orders/:id` | `get` | 89 | order:read |
| GET | `/v1/orders/:id/events` | `events` | 93 | order:read |
| GET | `/v1/orders/:id/exceptions` | `exceptions` | 97 | order:read |
| GET | `/v1/orders/:id/fulfillment` | `fulfillment` | 101 | order:pii:read |
| POST | `/v1/orders/:id/protected-details/anonymize` | `anonymizeProtectedDetails` | 105 | order:pii:anonymize |
| POST | `/v1/orders/:id/transitions` | `transition` | 109 | order:write |
| POST | `/v1/orders/:id/side-state` | `sideState` | 113 | order:write |
| POST | `/v1/orders/:id/exceptions` | `openException` | 117 | order:write |
| POST | `/v1/orders/:id/exceptions/:exceptionId/resolve` | `resolveException` | 121 | order:write |

## SupplierRoutingController

源码：[apps/api/src/orders/supplier-routing.controller.ts](../../../apps/api/src/orders/supplier-routing.controller.ts)；AppModule 注册：**是**。

| 方法 | 路径 | 处理方法 | 行号 | 方法级权限 |
| --- | --- | --- | --- | --- |
| GET | `/v1/sourcing/suppliers` | `suppliers` | 18 | order:read |
| POST | `/v1/sourcing/suppliers` | `createSupplier` | 22 | order:write |
| POST | `/v1/sourcing/capability-snapshots` | `capability` | 26 | order:write |
| POST | `/v1/sourcing/quotes` | `quote` | 30 | order:write |
| POST | `/v1/sourcing/capacity-windows` | `capacity` | 34 | order:write |
| POST | `/v1/sourcing/routing-policies` | `policy` | 38 | order:write |
| GET | `/v1/sourcing/routing-decisions/:decisionId` | `decision` | 42 | order:read |
| POST | `/v1/sourcing/routing-decisions/:decisionId/override` | `override` | 46 | order:write |
| POST | `/v1/sourcing/routing-decisions/:decisionId/review` | `review` | 50 | order:write |

## PlanningController

源码：[apps/api/src/planning/planning.controller.ts](../../../apps/api/src/planning/planning.controller.ts)；AppModule 注册：**是**。

| 方法 | 路径 | 处理方法 | 行号 | 方法级权限 |
| --- | --- | --- | --- | --- |
| GET | `/v1/planning/workspace` | `workspace` | 13 | operations:read |
| POST | `/v1/planning/forecasts` | `createForecast` | 14 | forecast:write |
| POST | `/v1/planning/forecasts/:runId/evaluations` | `evaluateForecast` | 15 | forecast:review |
| POST | `/v1/planning/forecasts/:runId/overrides` | `overrideForecast` | 16 | forecast:review |
| POST | `/v1/planning/metric-definitions` | `upsertMetricDefinition` | 17 | operations:write |
| POST | `/v1/planning/metric-snapshots` | `recordMetricSnapshot` | 18 | operations:write |
| POST | `/v1/planning/reconciliations` | `openReconciliation` | 19 | operations:reconcile |
| POST | `/v1/planning/reconciliations/:reconciliationId/resolve` | `resolveReconciliation` | 20 | operations:reconcile |
| POST | `/v1/planning/projections/rebuild` | `rebuildProjections` | 21 | operations:reconcile |

## ProcurementController

源码：[apps/api/src/procurement/procurement.controller.ts](../../../apps/api/src/procurement/procurement.controller.ts)；AppModule 注册：**是**。

| 方法 | 路径 | 处理方法 | 行号 | 方法级权限 |
| --- | --- | --- | --- | --- |
| GET | `/v1/procurement/workspace` | `workspace` | 25 | procurement:read |
| POST | `/v1/procurement/requisitions` | `createRequisition` | 33 | procurement:write |
| POST | `/v1/procurement/requisitions/:requisitionId/rfqs` | `createRfq` | 41 | procurement:write |
| POST | `/v1/procurement/rfqs/:rfqId/quotes` | `recordQuote` | 57 | procurement:write |
| POST | `/v1/procurement/purchase-orders` | `createPurchaseOrder` | 73 | procurement:write |
| POST | `/v1/procurement/purchase-orders/:purchaseOrderId/revisions` | `revisePurchaseOrder` | 81 | procurement:write |
| POST | `/v1/procurement/purchase-orders/:purchaseOrderId/reviews` | `reviewPurchaseOrder` | 97 | procurement:approve |
| POST | `/v1/procurement/purchase-orders/:purchaseOrderId/receipts` | `recordReceipt` | 113 | procurement:write |
| POST | `/v1/procurement/purchase-orders/:purchaseOrderId/invoices` | `recordInvoice` | 129 | procurement:write |
| POST | `/v1/procurement/replenishment-policies` | `upsertPolicy` | 145 | procurement:write |
| POST | `/v1/procurement/replenishment-policies/:policyId/suggestions` | `createSuggestion` | 156 | procurement:write |

## ResearchController

源码：[apps/api/src/research/research.controller.ts](../../../apps/api/src/research/research.controller.ts)；AppModule 注册：**是**。

| 方法 | 路径 | 处理方法 | 行号 | 方法级权限 |
| --- | --- | --- | --- | --- |
| GET | `/v1/research-items` | `list` | 29 | research:read |
| GET | `/v1/research-items/product-types` | `productTypes` | 37 | research:read |
| PATCH | `/v1/research-items/product-type` | `assignProductType` | 45 | research:write |
| GET | `/v1/research-items/:id/snapshots` | `timeline` | 56 | research:read |

## ReviewController

源码：[apps/api/src/reviews/review.controller.ts](../../../apps/api/src/reviews/review.controller.ts)；AppModule 注册：**否**。

| 方法 | 路径 | 处理方法 | 行号 | 方法级权限 |
| --- | --- | --- | --- | --- |
| POST | `/v1/listings/:listingId/reviews` | `submit` | 14 | listing:review |
| POST | `/v1/reviews/:reviewId/decision` | `decide` | 22 | listing:review |
| POST | `/v1/reviews/:reviewId/export` | `export` | 29 | listing:review |
| GET | `/v1/exports/:exportId/download` | `download` | 36 | listing:read |

## SupplierPerformanceController

源码：[apps/api/src/supplier-performance/supplier-performance.controller.ts](../../../apps/api/src/supplier-performance/supplier-performance.controller.ts)；AppModule 注册：**是**。

| 方法 | 路径 | 处理方法 | 行号 | 方法级权限 |
| --- | --- | --- | --- | --- |
| GET | `/v1/supplier-performance/workspace` | `workspace` | 19 | supplier_performance:read |
| GET | `/v1/supplier-performance/scorecards/:runId` | `scorecard` | 27 | supplier_performance:read |
| POST | `/v1/supplier-performance/definitions` | `upsertDefinition` | 35 | supplier_performance:review |
| POST | `/v1/supplier-performance/scorecards` | `calculate` | 46 | supplier_performance:review |

## WorkflowDefinitionController

源码：[apps/api/src/workflows/workflow.controller.ts](../../../apps/api/src/workflows/workflow.controller.ts)；AppModule 注册：**是**。

| 方法 | 路径 | 处理方法 | 行号 | 方法级权限 |
| --- | --- | --- | --- | --- |
| GET | `/v1/workflows/definitions` | `list` | 26 | workflow:read |
| POST | `/v1/workflows/definitions` | `create` | 34 | workflow:manage |
| GET | `/v1/workflows/definitions/:id/draft` | `get` | 42 | workflow:read |
| PATCH | `/v1/workflows/definitions/:id/draft` | `updateDraft` | 50 | workflow:manage |
| POST | `/v1/workflows/definitions/:id/clone` | `clone` | 66 | workflow:manage |
| POST | `/v1/workflows/definitions/:id/publish` | `publish` | 82 | workflow:manage |

## WorkflowRunController

源码：[apps/api/src/workflows/workflow.controller.ts](../../../apps/api/src/workflows/workflow.controller.ts)；AppModule 注册：**是**。

| 方法 | 路径 | 处理方法 | 行号 | 方法级权限 |
| --- | --- | --- | --- | --- |
| GET | `/v1/workflow-runs` | `list` | 100 | workflow:read |
| POST | `/v1/workflow-runs` | `start` | 108 | workflow:run |
| GET | `/v1/workflow-runs/by-plan/:productPlanId` | `getByPlan` | 116 | workflow:read |
| GET | `/v1/workflow-runs/:id` | `get` | 127 | workflow:read |
| POST | `/v1/workflow-runs/:id/nodes/:nodeId/commands` | `command` | 135 | workflow:run |
