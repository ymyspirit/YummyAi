# 原发布请求与店铺节点校验预览

PRD 1.1.104 · B21 · 操作 a6f4c2d9 · 本片段局部技术验证通过，完整B21与日常版本采用尚未验收

## 用户行为与事实归属

从原 Agent 任务的 Listing 来源进入明确的 Listing 版本，在原发布区域选择店铺和站点，读取当前可用目标后，由本人点击校验预览。Amazon 校验使用原 Listing Items adapter 的 `mode=VALIDATION_PREVIEW`；正式提交和 Etsy 创建草稿仍是不同业务动作。不得因进入页面、刷新或恢复意图自动执行。

Publication 继续拥有不可变 payload、素材清单、能力快照和全部发布事件。节点记录仅保存协调状态、出生权限及原请求引用。新182迁移增加不可变 `marketplace_publication_intents`，记录原操作者、membership、逐权限出生上限、授权代次，以及唯一执行路线。旧181请求没有该记录，明确作为旧记录读取，不以今天权限补造历史授权。

## 当前授权与固定目标

所有原 get/list/events/cancel/continue、prepare、batch 子请求与新预览都必须重新加载当前有效成员，与请求上限按逐权限范围相交。`ListingRead` / `ListingPublish` 作用于真实 Listing owner；`StoreRead` 单独作用于真实店铺 owner。宽读不扩大窄写，租户RLS不能代替对象范围。恢复还必须保持原 membership，不接受移除后重新加入的成员作为原授权。

新预览固定 account、listing、listingVersion、marketplace、可选variant、capabilitySnapshot、payloadChecksum、assetManifestChecksum、node、certificateGeneration、authorizationGeneration、bindingRevision。共享 `publicationPreviewRequestText` 定义唯一标量校验文本。payload 沿用原 Publication 的递归 `localeCompare` 排序，不能替换成不同摘要算法。

POST 在同一租户事务内复核目标，保存原 Publication、原事件、出生意图和节点协调引用；不得同时排中央队列。中央 Worker 仅接收明确 central 路线，并在外部动作与结果采用前核出生授权与当前对象权限；旧无出生授权请求不能获得新的执行权。Amazon 节点预览只能走指定节点，不能回退中央执行。

## 原回执与页面恢复

API：

- GET `/v1/marketplace-publications/preview/workspace`，参数为准确 listingId、listingVersionId 和可选variantSkuId
- POST `/v1/marketplace-publications/preview`
- GET `/v1/marketplace-publications/preview/receipt`，只接原 requestKey 和 requestChecksum
- GET `/v1/marketplace-publications/preview/:id`
- POST `/v1/marketplace-publications/preview/:id/cancel`
- GET 原 `/v1/marketplace-publications/:id/events`

个人BFF位于 `/api/erp-publication-preview`，对应 workspace、requests、receipt、requests/:id、requests/:id/events 和 requests/:id/cancel。正文返回前后均复核个人会话摘要。浏览器只持有原意图的标量，不保存凭据、正文或权限。POST响应丢失后只GET同一原回执；不同checksum冲突，不生成新键、不重算今天目标。403、换人或权限变化清除旧正文并拒绝迟到响应；退出同时清理该意图prefix。

原 Listing 页保留 listingVersionId、publicationRequestId、agentNativeV3 和安全 returnTo；登录往返不能丢弃原上下文。历史版本只读，不能静默改用当前版本或从当前编辑草稿生成预览。回到原Agent任务，不创建第二套发布事实。

## 节点执行与恢复

复用现有mTLS、中央在线permit、密封凭据与加密journal。新operation为 `marketplace.publication.validation-preview.v1`，旧节点未广告支持时只接能力同步。新lease的外层account/node/cert/auth/binding必须与原target一致。

受限transport只允许一次原LWA请求及一次精准seller/SKU/站点/语言/payload的Amazon预览PUT。禁止任意URL、重定向、正式提交、额外请求和凭据输出。每次实际HTTP前复核出生权限、对象、授权代次、绑定、证书和credential use/version。LWA不是重新授予原业务权限。

已submitted但没有响应的HTTP保持unknown，重启不能重新发送。已缓存原响应、step或completion只用原字节恢复。原owner采用结果时再次核准全部pins、当前能力/素材和原成员；结果、quota及审计在同事务写入原Publication事件。失权或未知结果不能伪装校验通过。

节点证书或身份失效后，mTLS执行RPC的401/403固定返回已有 `store_node_authority_changed`，不把身份所有者的私有码泄露或误译为通用执行失败。心跳使用原 `store_node_authority_rejected`；先返回哪条拒绝取决于实际响应顺序，两者都要求停止并核对原任务。

## 验收与运行保护

定向验证包含合同反例、具体对象与撤权、丢201原键恢复、真实节点CLI/mTLS与受限HTTP、断连重启、迟到completion、真正181源升级182，以及编译个人页面在1440/390宽度的精确往返。隔离门在数据库连接前检查一次性数据库、专用flag、私有桶和Redis命名空间。

原 `marketplace-publication.integration.test.ts` 与 `marketplace-publication-batch.integration.test.ts` 的Amazon预览正向用例也经过真实节点登记、绑定、心跳和能力采用。这两文件改由 `publication-node-preview-integration` 专用隔离家族串行运行，普通API配置排除，避免没有专用隔离标志或并发争抢节点端口；原Amazon后续提交、Feed、Etsy和队列恢复覆盖继续保留。

日常148运行环境继续使用原2598文件快照和原编译候选，不由测试停掉或升级。2026-10-22外部进程重启后的恢复身份记录见 `2026-10-22-publication-node-preview-a6f4c2d9-ordinary-runtime-preservation-r2.json`；当前API80212/8000、Web67340/3000及启动器59196应按创建时间和命令摘要核对。日常启停使用 `pnpm daily:status` / `pnpm daily:start`，存储使用经校验的19000覆盖配置。测试资源和临时日志、截图、下载、旧源副本及候选在检查后按精确自有范围删除，核对共享链接目标和清理后资源；保留测试源码、简明结论与清理记录。历史885冻结路径继续受保护。

以上为实现与验收要求，实际结果以对应交付记录为准。完整48需求、54工作包、8阶段、真实店铺/提供方业务验收、日常版本采用和正式发布条件保持原范围。

## 2026-10-22 局部验证结果

本片段去重通过101项：81个单位测试、17个当前原发布集成（包含9个既有正向用例）、1个真正181→182升级用例，以及2个同编译候选上的个人浏览器用例。原Agent的准确Listing版本往返、丢201后只GET恢复、存储不可用时不POST、撤权清空和迟到结果拒绝均有实际路径证据。1440和390宽度画面已检查；浏览器还断言无横向溢出并等待有限动画完成。键盘单独操作和降低动态效果的浏览器验收尚未独立执行。

节点使用真实CLI、mTLS和受限HTTP，外部模型及Amazon响应由隔离HTTPS夹具提供，无真实刊登提交或模型消费。旧181执行/步骤表为空，不能据升级通过推断旧节点执行重放已经覆盖；ListingRead与StoreRead分别撤权，以及同权限摘要下team对象移动的迟到响应还需补充。

14组测试DB、桶和Redis已在清理前后分别确认不存在；17个精确自有目标中的9672文件已删除，403个链接仅解除自身，167个共享目标保留，885个历史冻结路径未重试。原始日志、截图和测试编译候选已退役；保留测试源码、失败历史摘要、静态检查和清理结论。普通148继续复用原API和Web，不自动采用182。参见[交付验证](../project-control/checkpoints/2026-10-22-publication-node-preview-a6f4c2d9-delivery-validation.json)。
