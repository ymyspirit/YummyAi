# 页面与 Web 代理路由清单

自动生成于代码基线 `81fa57402451b3812a87a6dd05738473dbe545c8`。这是静态清单，不表示运行时可用或验收通过。更新命令：`node docs/project-map/scripts/generate-inventory.mjs`。

[返回项目地图](../README.md)

## 页面

| 路径 | 源码 | 静态重定向 |
| --- | --- | --- |
| `/amazon-custom-sop` | [apps/web/src/app/(erp)/amazon-custom-sop/page.tsx](../../../apps/web/src/app/(erp)/amazon-custom-sop/page.tsx) | `/workflows/runs/${runId}`, "/workflows" |
| `/analysis/[reportId]` | [apps/web/src/app/(erp)/analysis/[reportId]/page.tsx](../../../apps/web/src/app/(erp)/analysis/[reportId]/page.tsx) | — |
| `/channel-inventory` | [apps/web/src/app/(erp)/channel-inventory/page.tsx](../../../apps/web/src/app/(erp)/channel-inventory/page.tsx) | — |
| `/competitors` | [apps/web/src/app/(erp)/competitors/page.tsx](../../../apps/web/src/app/(erp)/competitors/page.tsx) | — |
| `/creative-designs/canvas` | [apps/web/src/app/(erp)/creative-designs/canvas/page.tsx](../../../apps/web/src/app/(erp)/creative-designs/canvas/page.tsx) | — |
| `/creative-designs` | [apps/web/src/app/(erp)/creative-designs/page.tsx](../../../apps/web/src/app/(erp)/creative-designs/page.tsx) | `/creative-designs/canvas?brief=${loaded.batch.id}` |
| `/customer-intelligence` | [apps/web/src/app/(erp)/customer-intelligence/page.tsx](../../../apps/web/src/app/(erp)/customer-intelligence/page.tsx) | — |
| `/design` | [apps/web/src/app/(erp)/design/page.tsx](../../../apps/web/src/app/(erp)/design/page.tsx) | — |
| `/finance` | [apps/web/src/app/(erp)/finance/page.tsx](../../../apps/web/src/app/(erp)/finance/page.tsx) | — |
| `/inventory` | [apps/web/src/app/(erp)/inventory/page.tsx](../../../apps/web/src/app/(erp)/inventory/page.tsx) | — |
| `/listings/[listingId]` | [apps/web/src/app/(erp)/listings/[listingId]/page.tsx](../../../apps/web/src/app/(erp)/listings/[listingId]/page.tsx) | — |
| `/listings` | [apps/web/src/app/(erp)/listings/page.tsx](../../../apps/web/src/app/(erp)/listings/page.tsx) | — |
| `/navigation` | [apps/web/src/app/(erp)/navigation/page.tsx](../../../apps/web/src/app/(erp)/navigation/page.tsx) | — |
| `/operating-cockpit` | [apps/web/src/app/(erp)/operating-cockpit/page.tsx](../../../apps/web/src/app/(erp)/operating-cockpit/page.tsx) | — |
| `/orders/import` | [apps/web/src/app/(erp)/orders/import/page.tsx](../../../apps/web/src/app/(erp)/orders/import/page.tsx) | "/orders?view=reports" |
| `/orders` | [apps/web/src/app/(erp)/orders/page.tsx](../../../apps/web/src/app/(erp)/orders/page.tsx) | — |
| `/` | [apps/web/src/app/(erp)/page.tsx](../../../apps/web/src/app/(erp)/page.tsx) | — |
| `/pod-workbench/batch-designs` | [apps/web/src/app/(erp)/pod-workbench/batch-designs/page.tsx](../../../apps/web/src/app/(erp)/pod-workbench/batch-designs/page.tsx) | `/creative-designs${query.size ? `?${query.toString()}` : ""}` |
| `/pod-workbench/mockup-batches` | [apps/web/src/app/(erp)/pod-workbench/mockup-batches/page.tsx](../../../apps/web/src/app/(erp)/pod-workbench/mockup-batches/page.tsx) | — |
| `/pod-workbench` | [apps/web/src/app/(erp)/pod-workbench/page.tsx](../../../apps/web/src/app/(erp)/pod-workbench/page.tsx) | — |
| `/pod-workbench/production-editor` | [apps/web/src/app/(erp)/pod-workbench/production-editor/page.tsx](../../../apps/web/src/app/(erp)/pod-workbench/production-editor/page.tsx) | — |
| `/procurement` | [apps/web/src/app/(erp)/procurement/page.tsx](../../../apps/web/src/app/(erp)/procurement/page.tsx) | — |
| `/products` | [apps/web/src/app/(erp)/products/page.tsx](../../../apps/web/src/app/(erp)/products/page.tsx) | — |
| `/research` | [apps/web/src/app/(erp)/research/page.tsx](../../../apps/web/src/app/(erp)/research/page.tsx) | — |
| `/stores/[accountId]` | [apps/web/src/app/(erp)/stores/[accountId]/page.tsx](../../../apps/web/src/app/(erp)/stores/[accountId]/page.tsx) | — |
| `/stores` | [apps/web/src/app/(erp)/stores/page.tsx](../../../apps/web/src/app/(erp)/stores/page.tsx) | — |
| `/supplier-performance` | [apps/web/src/app/(erp)/supplier-performance/page.tsx](../../../apps/web/src/app/(erp)/supplier-performance/page.tsx) | — |
| `/workflows` | [apps/web/src/app/(erp)/workflows/page.tsx](../../../apps/web/src/app/(erp)/workflows/page.tsx) | — |
| `/workflows/runs/[id]` | [apps/web/src/app/(erp)/workflows/runs/[id]/page.tsx](../../../apps/web/src/app/(erp)/workflows/runs/[id]/page.tsx) | — |
| `/workflows/templates/[id]/edit` | [apps/web/src/app/(erp)/workflows/templates/[id]/edit/page.tsx](../../../apps/web/src/app/(erp)/workflows/templates/[id]/edit/page.tsx) | — |

## Web 路由处理器

| 路径 | HTTP 方法 | 源码 |
| --- | --- | --- |
| `/stores/oauth/callback` | GET | [apps/web/src/app/(erp)/stores/oauth/callback/route.ts](../../../apps/web/src/app/(erp)/stores/oauth/callback/route.ts) |
| `/api/canvas-bridge/[...path]` | GET, POST | [apps/web/src/app/api/canvas-bridge/[...path]/route.ts](../../../apps/web/src/app/api/canvas-bridge/[...path]/route.ts) |
| `/api/orders/reports/[...path]` | GET, POST | [apps/web/src/app/api/orders/reports/[...path]/route.ts](../../../apps/web/src/app/api/orders/reports/[...path]/route.ts) |
| `/api/production-editor/[...path]` | GET, POST, DELETE | [apps/web/src/app/api/production-editor/[...path]/route.ts](../../../apps/web/src/app/api/production-editor/[...path]/route.ts) |
| `/v1/captures` | OPTIONS, POST | [apps/web/src/app/v1/captures/route.ts](../../../apps/web/src/app/v1/captures/route.ts) |
| `/v1/competitor-shops/captures` | OPTIONS, POST | [apps/web/src/app/v1/competitor-shops/captures/route.ts](../../../apps/web/src/app/v1/competitor-shops/captures/route.ts) |
| `/v1/products/[planId]/custom-package` | GET | [apps/web/src/app/v1/products/[planId]/custom-package/route.ts](../../../apps/web/src/app/v1/products/[planId]/custom-package/route.ts) |
| `/v1/products/[planId]/listing-materials/readiness` | GET | [apps/web/src/app/v1/products/[planId]/listing-materials/readiness/route.ts](../../../apps/web/src/app/v1/products/[planId]/listing-materials/readiness/route.ts) |
| `/v1/products/[planId]/listing-materials` | GET | [apps/web/src/app/v1/products/[planId]/listing-materials/route.ts](../../../apps/web/src/app/v1/products/[planId]/listing-materials/route.ts) |
| `/v1/research-items/[id]/snapshots` | GET | [apps/web/src/app/v1/research-items/[id]/snapshots/route.ts](../../../apps/web/src/app/v1/research-items/[id]/snapshots/route.ts) |
| `/v1/research-items/product-type` | PATCH | [apps/web/src/app/v1/research-items/product-type/route.ts](../../../apps/web/src/app/v1/research-items/product-type/route.ts) |
