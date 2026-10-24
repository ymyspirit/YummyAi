# 销售方案上新任务

异形抱枕的「图稿与套图」现在可在此页完成固定需求、逐张候选、审核和配图采纳；
见[受控视觉交付](product-visual-delivery.md)。生产文件仍由原生产编辑器核验。

异形抱枕 Custom FBM 方案可继续在「刊登与定制交付核对」逐 SKU、逐图片核对，记录运营依据并封存附带定制配置的资料包；见[定制交付操作与修订](sales-plan-delivery.md)。

入口：**商品与刊登 → 上架工作台 → 选择销售方案 → 上新任务**。
页首的 **上架准备 Agent** 可持久记录准备计划，资料齐备后创建或同步本地草稿，再检查提交审核条件；中断恢复、单独确认分析及版本变化处理见[上架准备 Agent](sales-plan-agent.md)。
页面集中核对商品事实、竞品与定位、原创方向、图稿与套图、Listing 草稿与审核、封存资料包六个环节。
进度来自当前业务资料，显示缺项和下一步入口；现有四步方案编辑、商品图文项目、设计、套图、刊登和资料包服务继续负责各自工作。
本批以单个销售方案的一个目标站点验收，使用 Amazon Custom FBM。

## 操作

1. 保存方案，关联本商品规格、已确认事实及研究商品。
2. 选择「原创方向」，读取上新依据并核对来源、规格版本与缺项。这一步不调用模型。
3. 选择已启用的分析模型，显式开始分析。建议、固定依据与费用保留在同一记录中。
4. 比较当前字段与建议，勾选需要的字段并采纳。原创方向允许人群、场景和设计定位；Listing 分析允许标题、要点、描述与已有定制字段的说明。采纳创建销售方案新版本。
5. 在原工作台准备自己的设计、已审核制作版本、真实主图与授权套图，创建或同步本地 Listing 草稿。分析文案前须同步到当前方案版本；文案改动采纳后须再次同步。
6. 在刊登编辑器完成人工审核；本轮异形抱枕 Custom FBM 在交付核对区检查定制、图文与每个 SKU，记录四项核对依据，再分别封存及下载交付包。其他范围沿用商品开发封存入口。刷新进度确认所选 SKU 均有当前资料包。

定制说明先保存到方案。同步草稿保留刊登编辑器已有的 personalization 和平台字段，需在刊登编辑器核对实际定制配置。AI 建议不能修改材质、尺寸、工艺、SKU、权利或审核状态。设计方向不代表图稿已生成，齐套资料包不代表平台发布或工厂生产放行。

关页、中断或刷新后从历史读取同一任务，不自动重发模型请求。采纳重试保留所选字段和同一幂等编号，服务端只保存一个新版本；记录显示采纳所到达的方案版本。当前操作者只看自己的分析记录和费用。本页显示最近 100 次，超限明确提示费用统计范围。未计价费用继续显示未知；渠道计价、单次上限和组织预算沿用原服务。

## 接口、权限与版本

| 接口 | 行为 |
| --- | --- |
| `GET /v1/sales-plans/:id/launch` | 当前环节、缺项、下一步、自己的历史/费用/采纳事件和当前封存包 |
| `POST /v1/sales-plans/:id/launch/basis` | `{ kind, expectedRevision, taskGoal? }`，返回现有助手输入、来源、检查及指纹 |
| `POST /v1/sales-plans/:id/launch/adopt` | `{ kind, runId, directionIndex?, fields, expectedRevision, idempotencyKey }`，读取服务端结果并采纳所选字段 |

分析创建仍使用 `POST /v1/ai-assists/runs`。可选 `salesPlan: { id, revision }` 仅支持 creative/sku_package，绑定方案、规格、有效研究依据或 Listing 版本。创建前重读并比较预览指纹。规格、有效研究快照/结论、方案或刊登变化后，旧任务保留原内容并标记历史依据，不能直接采纳。封存包按制作/刊登版本、资产版本/校验值及权利核对；失效包退出当前齐套结果，原封存历史继续保留。

读取要求 ProductRead；分析沿用助手的研究/设计/刊登权限；采纳另需 ProductWrite。Worker 在调用模型前再次核对有效成员及绑定方案的 ProductRead。所有租户操作通过应用角色的 `withTenant()`，任务内容加密、私有图片及保留期沿用原服务。浏览器代理采用路径白名单、共享 Zod 契约、同源写入和 private/no-store，不接受调用方租户、任意字段值或执行路径。

无新增表、迁移、环境变量、任务队列或独立审批。事件与幂等复用 development events，字段写入由 SalesPlanService 负责；刊登审核和封存继续使用原服务、原校验。本批交付到审核后的不可变导出包，平台提交继续走正式授权/API 流程。

## 验收与清理

```powershell
pnpm lint
pnpm typecheck
pnpm test
pnpm test:e2e:order-daily --suite=ai-tasks-integration src/catalog/sales-plan.integration.test.ts src/catalog/product-development.integration.test.ts
pnpm test:e2e:order-daily --suite=sales-launch
pnpm test:e2e:order-daily --suite=ai-tasks
pnpm build
pnpm start:local
pnpm check:local-runtime
```

浏览器测试使用真实身份、API、RLS、私有存储、版本写入、助手处理器、人工审核、封存和 ZIP 导出。已批准设计/套图由隔离合成夹具提供，模型传输受控；测试不证明付费模型文案质量或实际产品图像质量。覆盖断网采纳重试、字段选择、刷新恢复、历史费用、来源失效、1440/390 px 和深色页面。测试数据库、桶和 Redis 由运行器在 finally 清理并核对不存在，不向市场或工厂提交。

截图和夹具 ID 在忽略目录 `tmp/sales-launch-e2e`，清理记录在 `tmp/order-daily-e2e-<token>.json`。命令日志放到其他目录，例如 `tmp/sales-launch-logs`，避免 Playwright 清空输出目录时删除日志。运行浏览器测试和构建前停止同工作区 Next 开发服务。
