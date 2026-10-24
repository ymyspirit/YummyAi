# 采购、售后与独立订单异常的跟进

R36 / B26。沿用原业务模块、统一待办筛选、责任抽屉和通知服务。设计参考
[ERPNext 单据分配与到期安排](https://docs.frappe.io/erpnext/assignment-rule)，
实现复用现有 Next/React、Drizzle/PostgreSQL 和 Worker；未引入第二套任务引擎。

## 开通和权限

迁移 `0115_business_followups.sql` 只新增三个责任旁表，不回填历史、不修改原单据、
不自动扩充角色。`BUSINESS_FOLLOWUP_TENANT_IDS` 默认空，API/Worker 使用相同配置；
按明确租户 UUID 开通，隔离验收可使用 `*`。正常业务库迁移与开通须单独验证。

| 对象 | source | 查看 | 安排 | 可被分配的处理人 |
| --- | --- | --- | --- | --- |
| 采购单 | procurement_order | procurement:read | procurement:assign | procurement:read/write + notification:read |
| 售后问题 | after_sales_case | order:read + order:pii:read | order:assign | order:read/write + order:pii:read + notification:read |
| 独立订单异常 | order_exception | order:read + order:pii:read | order:assign | order:read/write + order:pii:read + notification:read |

均要求当前租户范围，当前成员和权限在租户事务中重读；只读人员可看自己的通知和
已安排责任。升级接收人需要查看及通知权限，不需要业务写权限。候选最多一百人，
可按名称字面搜索，已选名称单独保留；跨租户成员关系由组合外键和 RLS 双重约束。
本实现尚未支持工厂/团队/个人范围的对象级任务授权，不能用 tenant 范围替代它。

## 原业务决定当前任务

旁表仅存责任人、内部截止、升级、修订、枚举原因和技术提醒检查点。父单审核、
制造/平台/预计到货日期、版本、金额与完成事实继续归原模块所有。

- 采购草稿待审核，被退回仍可修订；收货完成但无完整匹配发票时继续待核对发票。
  当前采购版本存在、原单已收货、发票均匹配且逐行累计开票数量等于采购数量后，
  才结束跟进。先开部分累计发票再开完整累计发票不会因为最后一张匹配就结束。
  发票差异按原采购状态显示；旁表不能消除差异。归档/取消结束当前跟进，不代表履约成功。
- 售后 approved/rejected 都不等于结案；只有原单 resolved/cancelled 结束跟进。
  员工负责人不改责任归属 supplier/carrier/customer 等业务证据。原售后页继续登记
  联系、处理决定和带凭证的实际结案；批准方案不会在本功能中执行退款或发消息。
- 订单异常逐条读取原异常的最新不可变事件，未解决/已解决各自可筛选，不制造另一套
  异常完成状态。当前新待办可查看原订单依据，解决命令仍由既有异常 API 所有；
  原订单与具体异常待办复用实际登记/解决表单；操作须固定当前依据、重查权限并记录
  实际处理结论，不能把责任分配当作异常已处理。见 [异常处理契约](order-exception-operations.md)。

来源校验值固定实际业务版本及有关收货/发票/联系/决定/异常事件身份。责任更新同时
比较当前来源校验值和责任 revision；冲突 409 并保留表单。相同安排不产生新修订。
写入与审计同事务，原因仅允许 initial_assignment/handoff/deadline_update/correction。

## 接口与页面

`GET /v1/business-followups/:source/tasks` 使用 common/task-inbox 契约：我负责、未分配、
全部可见，open/closed/all，内部截止、字面搜索、分页、稳定排序与业务时区。完整筛选
计数与分页行使用同一个只读 repeatable-read 快照；asOf 来自数据库。统计按业务对象
计数，售后问题不是商品件数，独立异常也不是订单数；各摘要分类可以重叠。

`GET /v1/business-followups/:source/:id?q=...` 返回当前任务和责任安排；成员查询不超过
一百字符。`POST .../:id/responsibility` 保存安排，`POST .../:id/resume` 明确恢复提醒。
写入固定 expectedRevision、expectedSourceChecksum、负责人/时限/升级/原因。resume
只允许当前安排不变、已分配、提醒已停止且原资料重新可用的对象，恢复增加修订。

Web BFF `/api/business-followups` 只开放上述静态 source/路径，拒绝未知/重复参数、
调用者指定租户与任意状态写入；同源 JSON 写入最大 8 KiB，严格校验成功响应，
private/no-store，失败不自动重放写入。打开页面仅查询。

业务任务选择采购跟进、售后跟进或订单异常。打开任务保留筛选/页码；责任编辑使用
既有未保存保护与冲突抽屉，内部截止与原预计到货/平台交期分别展示。售后返回原页
固定具体 case，自动展开已结案记录并定位；不匹配显示明确诊断。通知仅从受信的
resourceType/resourceId 构造本地入口，忽略 metadata URL。

## 提醒、隐私和恢复

标准 Worker 启动 `BusinessFollowupScheduler`，每六十秒扫描，单实例不重叠，关闭时
等待当前轮。每租户三类对象合计最多一百个到期安排；逐项先尝试原服务相同的 advisory
锁和可变父行锁，锁忙跳过。售后同时保护父订单，异常使用原订单锁；不可变异常行不更新。

通知和检查点同事务/保存点，失败全部回滚，其他项继续，失败项五分钟后重试。持久
唯一键固定 source/id/责任修订/依据周期/提醒阶段；分配、到期及升级分别去重。依据
变化开启新技术周期。已结束但资料仍有效的安排最多五分钟再次核对，以观察原业务恢复。
这是有界轮询，不保证立即感知变化或宕机期间准时送达。

发送前重查接收人成员/范围/权限。订单匿名化、保护资料或任一关联制作资料到期时停止
提醒并登记 SOURCE_UNAVAILABLE；资料恢复后操作者明确核对当前依据再启用，不因读页面
自动恢复。普通撤权保留可重查的安排，当前权限恢复后重试。通知和列表不携带解密正文、
买家资料或异常 message；数据库当前事实保持在所属模块。

## 验证与清理

隔离后端：`pnpm test:e2e:order-daily --suite=business-followup-integration`。
真实浏览器：`pnpm test:e2e:order-daily --suite=business-followup`。沿用隔离数据库/私有桶/
Redis/Web 源码快照，demo flags 关闭，无真实外部交易或付费模型调用。
检查后删除临时日志、截图、trace、快照和本轮已识别测试缓存，保留测试源码、
紧凑结论/校验值及资源清理记录。整体 B26 与正式上线仍需其他对象、角色及发布准出验收。
