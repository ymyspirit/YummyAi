# Daily order operations runbook

本说明面向部署和接口维护人员。运营步骤见[用户指南 7.0](../user-guide.md#70-每天导入亚马逊订单报告)，原始报告与附件规则见 [Amazon order reports](amazon-order-reports.md)，订单工作台边界见 [Order centers](order-centers.md)。

## 接口与证据口径

以下路径均以 `/v1/order-centers` 为前缀，租户由认证会员关系确定。新增交期、客户确认和人工平台确认操作要求 `order:write` 与 `order:pii:read`。

| 操作 | POST 路径 | 必要字段及行为 |
| --- | --- | --- |
| 核对平台发货截止 | `/lines/:id/platform-deadline` | `expectedProjectionVersion`、`shipByAt`（ISO 时间或 `null`）、`evidenceReference`、`idempotencyKey`。保存平台截止与核对时间；`null` 表示仍未知。内部 `dueAt` 不替代平台截止。 |
| 记录客户校样结论 | `/lines/:id/actions` | `action=approve_proof/reject_proof`、`expectedRevision`、`expectedProjectionVersion`、`expectedEditorVersionId`、`reason`、`idempotencyKey`。稿件须已审核，指定版本须同时为已审核版本与编辑器当前版本。 |
| 记录人工平台确认 | `/shipments/:id/platform-confirmation` | `expectedVersion`、`confirmedAt`、`evidenceReference`、`idempotencyKey`。仅接受当前已审核且所有包裹已实际交运的发货版本；确认时间不得超过当前时间一分钟。 |

平台确认记录适用于运营已在 Seller Central 等平台后台完成操作并核对凭证的场景。凭证引用应足以定位该次核对；该接口只保存人工证据，不发送平台 API、不创建 API writeback 成功记录，也不验证外部后台是否实际完成。自动 writeback 仍使用原授权连接器及其回执。

客户确认绑定 `proofEditorVersionId`。改稿、退回或重新审核不同版本后，旧确认不能授权生产。历史 `proof=approved` 但未绑定版本的记录保留历史，`proofVersionCurrent=false`；运营须核对客户对当前稿件的回复并重新确认。禁止批量补填旧确认的版本。生产放行还会核对当前稿、审核稿、正式渲染版本与客户确认版本。

## 实际交运与平台确认分开核验

`physicalHandover` 依据已审核发货版本的逐包 tracking 事件计算，返回 `shipmentVersionId`、`packageCount`、`dispatchedPackageCount`、`allDispatched`。有效实物证据状态为 `picked_up`、`in_transit`、`out_for_delivery`、`delivered`、`returned`；面单、平台回执或仅创建发货单不会增加实际交运数量。

实际交运可经 `/shipments/:id/dispatch` 登记整单交运，或 `/shipments/:id/tracking` 登记逐包物流证据。只交运部分包裹时 `allDispatched=false`，不得记录整单人工平台确认。已有实际交运证据的包裹版本不能随意重审或改写。

`platformConfirmationPending` 独立检查已实际交运版本是否存在人工确认，或 API `accepted` / 已对账接受的证据。不得用它替代 `physicalHandover`；平台先接受回传也不能被解释为已实际交运。

## 迁移与部署

在目标环境确认备份及迁移凭证后，使用项目迁移器按 journal 顺序执行全部待执行迁移：

```powershell
pnpm --filter @yummyai/database db:migrate
```

本轮顺序为：

1. `0085_order_daily_operations`：平台截止、客户确认版本字段及不可变 `shipment_manual_confirmations` 历史。
2. `0086_amazon_report_processing`：租户隔离的附件处理请求，固定来源与版本、执行状态及最多三次尝试。
3. `0087_ai_budget_settlement_permissions`：仅授予预算账本 `state` / `amount_usd` 更新，允许 `reserved → committed/released`；相同终态和金额可幂等重放，其他身份/来源字段保持不可变。

先完成迁移，再将 API、Web、Worker 同步到同一代码版本并重启。保持 Redis、Worker、ClamAV 可用；仅启动 Web/API 不会完成后台 ZIP 下载扫描。沿用现有订单 PII 加密配置，不新增或轮换密钥。环境启动及正式发布要求分别见[本地运行说明](../operations/local-development.md)和[部署说明](../operations/deployment.md)。

## 数据保护、并发与恢复

- 所有租户数据操作使用 `withTenant()` 和非 owner 应用角色；保留 FORCE RLS。迁移角色不得用于业务请求。
- 交期依据、客户确认理由、人工平台凭证写入订单工作历史的加密理由字段，使用该工作项可到期的数据密钥。确认索引表只保存版本、时间、操作者、幂等键和请求摘要；审计不保存明文凭证。
- 历史事件、报告版本及平台人工确认不可改写。纠正操作追加新证据；到期清理按既有密钥/密文擦除策略执行，不恢复已到期客户资料。
- 重试保留同一 `idempotencyKey` 和完整原请求。相同键但不同内容、旧 revision / projection / editor / shipment 版本会被拒绝；收到冲突后刷新并重新核对，再提交新的业务操作。
- 附件队列只携带标识符，客户内容和下载链接留在加密数据域。报告导入成功后附件可脱离浏览器继续执行；已持久化附件请求可通过报告恢复入口重新调度。逐单报告导入本身若在 API 完成前中断，仍应核对批次并重新导入原报告，不能把附件恢复当作完整报告重放。

## 验证状态（2026-09-17）

本轮工作区检查结果：

- 全仓 lint、17 项 typecheck 任务、1088 项单元测试及 4 项 build 任务通过；项目规则镜像检查与工具测试通过。
- 隔离订单集成共 57 项通过：订单工作台 16、原发货集成 3、实际交运 4、Amazon 报告 34。报告覆盖超过 1000 行的恢复、锁冲突后恢复、第三次执行的并发保护和人工附件版本保护。报告增强后独立复跑 34 项，其余订单集成保留同轮通过证据。
- 隔离财务、广告与经营 AI 集成 22 项通过；本轮相关集成合计 79 项。
- `pnpm test:e2e:order-daily` 的 4 项浏览器验收通过，覆盖日常订单全路径、报告刷新与后台进度展示、财务广告空态，以及混合统计口径和不完整成本的非空态。桌面和手机尺寸均有截图。

订单与财务广告页面使用真实认证 API、数据库及租户权限。报告 UI 首例使用明确的浏览器 API fixture，附件下载与持久化由报告集成验证；制图模型使用隔离的合成 gateway，不代表真实模型图像质量验收。具体运行和隔离边界见[日常路径验收说明](../operations/order-daily-acceptance.md)。

临时数据库、私有 bucket 和浏览器验收 Redis 均已验证删除，无清理错误。本地日志及清理 manifest 在 `tmp/order-daily-*.log`、`tmp/order-daily-e2e-55d5bf1e5c5440a7be9e71d5979e0e57.json`、`tmp/order-intake-integration-resources.json` 和 `tmp/finance-ads-integration-a48e9082258d4d3ba98ba82314bc6a46.json`。

这些结果对应当前未提交的工作区变更，尚未部署到业务数据库或执行真实店铺操作，不构成正式发布或阶段完成结论。正式候选仍须按项目发布要求绑定提交、CI 与备份恢复证据。
