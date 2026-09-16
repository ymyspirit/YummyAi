# 异步队列目录

自动生成于代码基线 `81fa57402451b3812a87a6dd05738473dbe545c8`。这是静态清单，不表示运行时可用或验收通过。更新命令：`node docs/project-map/scripts/generate-inventory.mjs`。

[返回项目地图](../README.md)

启动引用只检查 `apps/worker/src/run.ts` 的 `createWorker()` 调用。配置开关可能阻止实际注册；队列常量、处理器文件、消费者启动是三个不同层次。

| 常量 | 队列名 | run.ts 中有启动调用 |
| --- | --- | --- |
| AiAnalysis | `ai-analysis` | 未发现 |
| Capture | `capture` | 未发现 |
| CustomizationFileScan | `customization-file-scan` | 是，需进一步检查条件 |
| CreativeDesign | `creative-design` | 是，需进一步检查条件 |
| CreativeDesignAdaptation | `creative-design-adaptation` | 是，需进一步检查条件 |
| Export | `export` | 未发现 |
| Media | `media` | 未发现 |
| Metrics | `metrics` | 未发现 |
| MockupRender | `mockup-render` | 是，需进一步检查条件 |
| MockupTemplateCompile | `mockup-template-compile` | 是，需进一步检查条件 |
| OrderIngestion | `order-ingestion` | 未发现 |
| AmazonOrderReportRetention | `amazon-order-report-retention` | 是，需进一步检查条件 |
| PodArtwork | `pod-artwork` | 是，需进一步检查条件 |
| PodExport | `pod-export` | 是，需进一步检查条件 |
| ProductionEditorRender | `production-editor-render` | 是，需进一步检查条件 |
| PersonalizationTemplateSourceInspection | `personalization-template-source-inspection` | 是，需进一步检查条件 |
| OrderPersonalizationBatch | `order-personalization-batch` | 是，需进一步检查条件 |
| OrderPersonalizationRender | `order-personalization-render` | 是，需进一步检查条件 |
| ListingSync | `listing-sync` | 是，需进一步检查条件 |
| Publication | `publication` | 是，需进一步检查条件 |
| PublicationBatch | `publication-batch` | 是，需进一步检查条件 |
| PublicationReconciliation | `publication-reconciliation` | 是，需进一步检查条件 |
| ShipmentWriteback | `shipment-writeback` | 是，需进一步检查条件 |
| FulfillmentAutomation | `fulfillment-automation` | 是，需进一步检查条件 |
| WebhookDelivery | `webhook-delivery` | 是，需进一步检查条件 |
| WorkflowNode | `workflow-node` | 未发现 |
