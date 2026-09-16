# YummyAI 项目地图与模块文档

这套文档用于回答三个问题：**现在系统实际由什么组成、一次业务如何穿过这些模块、重构应该先解决哪些问题。** 它记录现状，并给出待讨论的重构方向；本次没有修改 ERP 功能。

基线日期：2026-09-12。代码提交：`81fa57402451b3812a87a6dd05738473dbe545c8`；分支：`codex/design-system-snapshot-2026-09-12`。开始梳理时工作树干净。

## 从这里阅读

| 你的目的 | 文档 |
| --- | --- |
| 先用浏览器看全貌 | [可离线打开的项目地图](index.html) |
| 看系统组成、页面与技术边界 | [系统地图](system-map.md) |
| 理解业务怎么走、在哪里断开 | [核心业务流程](business-flows.md) |
| 弄清数据由谁拥有、哪些不能丢 | [数据与状态地图](data-map.md) |
| 讨论哪里不满意、怎样重构 | [重构评估与决策清单](refactor-assessment.md) |
| 确认哪些有代码、哪些还需验收 | [验证范围与验收矩阵](acceptance-matrix.md) |
| 定位具体接口和数据库表 | [API](generated/api.md) · [页面/代理](generated/routes.md) · [表目录](generated/tables.md) · [队列](generated/queues.md) |
| 给下一位开发者或 AI 接手 | [机器可读清单](generated/inventory.json) · [文档维护说明](maintenance.md) |

## 当前规模

| 统计项 | 静态结果 | 口径 |
| --- | ---: | --- |
| 工作区包 | 15 | 4 个应用 + 11 个共享包 |
| API 一级目录 | 27 | 代码目录，不等于业务模块或独立服务 |
| Web 页面 | 30 | `page.tsx`，含兼容跳转和详情页 |
| Web 路由处理器 | 11 | `route.ts`，主要是本地代理与回调 |
| API 控制器 | 50 | 46 个在当前 AppModule 中注册 |
| API 接口定义 | 352 | 341 个属于已注册控制器；包括 SSE 装饰器 |
| 数据库表声明 | 222 | Drizzle `pgTable()`，不是在线数据库探测结果 |
| SQL 迁移文件 | 67 | 文件数，不用最大编号替代文件数 |
| 队列常量 | 26 | 标准 Worker 入口有 19 个启动调用，部分受配置开关控制 |
| 测试文件 | 241 | apps/packages 中的 test/spec 文件，不是通过的测试用例数；不含 tools/tests、Python 测试 |

完整统计由 [generate-inventory.mjs](scripts/generate-inventory.mjs) 从源码生成。业务上的 **20 个模块** 是这次为理解和重构划分的阅读单元，并非已经实施的代码拆分。

## 20 个业务与支撑模块

| 编号 | 模块 | 主要入口或作用 |
| --- | --- | --- |
| M01 | [平台、身份与资产](modules/01-platform.md) | 租户、权限、私有文件、审计、通知、任务基础设施 |
| M02 | [采集与研究](modules/02-research.md) | 浏览器扩展、研究资料库、竞争店铺 |
| M03 | [AI 分析与模型路由](modules/03-ai.md) | 分析报告、模型配置、预算与来源 |
| M04 | [产品目录与产品事实](modules/04-catalog.md) | 企划、SPU、SKU、定制规格、资料包 |
| M05 | [工作流中心](modules/05-workflows.md) | 模板、版本、人工节点、内部任务 |
| M06 | [创意画布](modules/06-canvas.md) | SKU 前的创作项目、方案审核、生产交接 |
| M07 | [设计版本与 POD 工具](modules/07-design-pod.md) | 设计任务、权利审核、图片处理、POD 导出 |
| M08 | [批量设计与商品套图](modules/08-batch-mockup.md) | 创意候选、SKU 绑定、受控 PSD 模板、套图 |
| M09 | [定制模板与订单渲染](modules/09-personalization.md) | 槽位、SKU 模板绑定、订单字段映射与渲染 |
| M10 | [生产编辑器](modules/10-production-editor.md) | 生产项目、版本、轮廓与排版、预检、出图 |
| M11 | [刊登、审核与导出](modules/11-listings.md) | Listing 版本、平台校验、审核与多种资料包 |
| M12 | [店铺与平台连接](modules/12-marketplaces.md) | 店铺授权、能力快照、发布、批量发布与回读 |
| M13 | [订单与 Amazon 报告](modules/13-orders.md) | 统一订单、TXT 导入、ZIP 定制核对、PII |
| M14 | [生产履约与售后](modules/14-fulfillment.md) | 派单、生产、质检、发货、回传、售后 |
| M15 | [库存与渠道库存](modules/15-inventory.md) | 台账、预占、调拨、渠道分配与对账 |
| M16 | [采购与供应商](modules/16-procurement.md) | 库存采购、收货、发票、补货建议与绩效 |
| M17 | [财务利润](modules/17-finance.md) | 财务事实、汇率、口径版本、利润计算 |
| M18 | [广告与 VOC](modules/18-customer-intelligence.md) | 广告报告、客户信号、分析与建议审核 |
| M19 | [经营总览与预测](modules/19-planning.md) | 首页、预测、指标快照、经营对账 |
| M20 | [开放集成](modules/20-integrations.md) | API 客户端、Webhook、重放与保留策略 |

## 当前最值得先讨论的事实

1. **范围已经超过早期选品与刊登 ERP。** 同一个产品承载了创作软件、生产文件编辑、订单履约、库存采购和经营分析，需要重新确定每天最重要的工作。
2. **入口整理不等于业务打通。** 创意项目工作流、产品工作流、订单状态机同时存在；各自适用对象不同，交接关系需要明确。
3. **存在启动装配缺口。** AI 分析/模型配置、通用审核、任务 SSE 控制器未注册；部分队列未在标准 Worker 入口启动。具体证据见重构评估。
4. **订单主流程仍以定制生产为中心。** 普通 FBM、定制 FBM、FBA 销售与 FBA 备货不宜共用一个强制经过设计生产的状态图。
5. **已有值得保留的底座。** 租户隔离、不可变版本、原始证据、私有文件、幂等与对账机制应纳入新系统迁移要求。

以上是本次源码审查结论；没有据此宣布系统不可用，也没有执行真实店铺授权、平台写操作、数据清理或重构迁移。用户具体不满意的操作场景尚待补充，重构优先级因此是建议。
