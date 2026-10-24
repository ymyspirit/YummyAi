# Listing 同步原意图与回执

PRD 1.1.103 · B21 前置 · 本批 b7d3e8f2 局部验证和清理通过

新协议 `erp-listing-sync-intent-v1` 复用原 ListingSync 请求、事件、快照和 Worker 结果。新增表只把本人原请求键关联到原请求，没有另一套 Listing 或发布状态。旧 v1 idempotency 摘要、业务历史和节点能力同步协议保持。

同一租户、本人和 requestKey 只有一个不可变定位。摘要固定店铺、Listing、版本、原发布请求和动作，排除会随时间变化的能力有效期与今天的价格。新建任务在同一事务完成原业务检查、原请求、初始事件和定位；同键相同目标只读取原回执，异目标拒绝。旧任务不会被今天的主版本替代。

180 的旧请求没有新定位。旧客户端重试原合法键时，新服务以原 v1 算法、当时保存的 desiredChecksum、原本人及全部目标核对，命中仅建立恢复关联，不改旧摘要、事件或再次派发。按100行分页核对同目标旧记录，达到10000行仍无法确认扫描完整时拒绝新建；不会把未扫完当未找到。新建前另核 v1 摘要碰撞，撞到其他本人或目标即拒绝。原已知ID一直沿原读权读取；未建立关联的旧请求不能伪称新 receipt 已存在。

新增读取为 `GET /v1/marketplace-listing-syncs/workspace?listingId=...` 和 `GET /v1/marketplace-listing-syncs/receipt?requestKey=...&requestChecksum=...`。原创建输入和原请求输出保留，Web 明确必传 UUIDv7 requestKey。原 get/list/events 同样重核当前会员、Listing 对象及 StoreRead 店铺范围。新建仍要求 ListingPublish，读取仍要求 ListingRead，原有范围不会被扩大。

Web 使用有限 BFF，提交前可靠保存纯标量恢复标记，只有本人/租户/当前范围一致才采用响应。标记不保存 Listing 正文、凭据或平台响应。断线、丢201或超时后只查询原键和摘要；注销、失权和上下文变化会清文并拦住迟到响应。最近记录明确为有限列表，已知原ID可准确读取，不把最近20条称为完整历史。

原任务保存与队列派发有不同语义。目前没有 transactional outbox，提交事务后进程若在 enqueue 前中断，原任务可能仍为 queued。回执只能证明原记录存在，不证明队列、平台接受或平台发布成功；重复同键请求不重新 enqueue。失败或未知任务不能通过自动换键重放。这一派发缺口继续登记，不能把本批恢复当作已解决。

本批不增加节点操作，不接通真实发布或订单轮询。Etsy 未适配 Worker 仍关闭。下一节点切片优先原 Amazon VALIDATION_PREVIEW，独立完成凭据、逐HTTP许可、原结果采用和未知恢复后才开放；不可从已有能力同步推断全部平台操作可用。

验收采用一次性数据库、私有桶和 Redis、真实应用权限及编译个人页面。发布前置可使用明确的合成历史样本，仅用于原任务定位测试，不作为真实发布或店铺节点闭环证据。真正180升级使用改源前封存的3570文件与400依赖链接，比较全部原记录。临时产物验后精确清理。

- [全ERP Agent规格](../erp-blueprint/18-erp-agent-integration-specification.md)
- [本批进度](../project-control/LISTING_SYNC_INTENT_PROGRESS_20261022.md)
- [节点能力执行](store-node-execution.md)

<!-- b7d3e8f2-validation -->
本批38项去重检查通过：3合同、5服务编排单元、16前端/BFF单元、11当前接口与原回归、1真正180升级、2编译个人浏览器；另4隔离门组覆盖21种连接前拒绝。原保存回执丢失后实际刷新仅GET恢复，只有一个原请求和一个Redis任务；撤回当前权限后原读取和提交均403，迟到正文不能重新出现。四张1440/390截图已目视检查，原始截图与日志验后清理。10组数据库/桶/Redis前后独立查无，12个本批自有目标已清。完整原发布/节点预览、派发可靠性及普通采用继续，不能解释为完整B21或全ERP通过。详见[简明验收](../project-control/checkpoints/2026-10-22-listing-sync-intent-b7d3e8f2-evidence.json)。
<!-- /b7d3e8f2-validation -->
