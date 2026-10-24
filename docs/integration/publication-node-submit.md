# 原预览后的正式节点提交与状态核对

PRD 1.1.107 · B21 · 74c2e8b1 · 本批局部技术验证通过 完整 B21 继续

公开或私有 Amazon 店铺完成原节点校验预览后，用户读取准确原预览与批准版本、店铺、Marketplace、SKU、载荷及素材摘要、能力版本、节点与授权代次，再明确确认正式提交。沿原 Publication owner 的父请求到子请求幂等关系保存 `amazon_submit`；不创建第二份 Listing 或发布事实，不把预览常量改名作为正式操作。

## 开源依据

已检查 [Amazon 官方 Apache-2.0 SDK](https://github.com/amzn/selling-partner-api-sdk)、[正式创建或完整更新](https://developer-docs.amazon/sp-api/docs/create-a-listing)及[读取 Listing 状态](https://developer-docs.amazon/sp-api/docs/retrieve-details-about-a-listing)。继续复用现有 `HttpMarketplaceDraftGateway.submit/getStatus`、原 parser、Node24、NestJS、Zod 和 React，不增加绕过有界 transport 的 SDK 通道。

正式 `putListingsItem` 创建或替换相同 SKU 的现有内容。确认页必须显示准确 SKU、批准版本和替换含义，不能用“只保存本地”描述正式提交。校验预览仍严格保留 `VALIDATION_PREVIEW`，不得自动触发写入。

## 操作与事实归属

正式提交和状态读取使用不同操作常量及租约。提交只允许一次原 LWA 请求和一次固定 region、seller、SKU、Marketplace、locale、Product Type 及完整属性的正式 PUT。状态读取只允许原 LWA 请求和同 SKU 的 `GET includedData=summaries,issues`；不能经状态操作发 PUT。每次 HTTP 仍须当前中央 permit、出生权限上限与当前成员及对象权限、原节点/cert/binding/授权代次/凭据版本和准确输入摘要。

提交接受时保存原 submissionId、SKU、平台问题、时间和不可变结果并释放租约。接受不等于实际可售。后续状态核对是独立有界操作，不延长原写租约，不自动重发正式 PUT。保留原 Publication 当前状态与事件；节点操作意图及结果只记录执行来源和原事实引用。

节点正式提交沿原父子幂等键。新协议另固定本人原 requestKey 和 requestChecksum；丢保存响应后仅以原键查只读 receipt。已经存在的旧 central 子请求不重写路线、不重新分派节点。新正式流程不能回退中央 Worker。

每次状态核对固定原提交请求、写执行、提交目标摘要、源事件及已知 submissionId。无已知成功写回执时，状态查询仅是 SKU 观察；看到已有 `BUYABLE` 或 `DISCOVERABLE` 不能证明本次未知载荷、版本或提交成功，原请求保持需要核对。即使已知提交被接受，状态 GET 也不提供完整属性版本一致性证明，界面不能把观察包装成该证明。

状态查询有自己的出生权限上限。创建、领取、每次 HTTP 和采用结果时，都将该上限、原正式请求上限、当前成员与对象权限求交；后续提权不扩大旧操作。工作区的 `context.authority` 只表示当前登录身份摘要，用于拒绝晚到正文；不能将它误作原任务出生权限，也不能回填旧意图。

## 私有接口

以下路径相对于 `/v1/marketplace-publication-submissions`，只读接口支持 GET/HEAD 并禁止缓存。

| 路径 | 方法 | 返回 |
| --- | --- | --- |
| `workspace?previewRequestId` | GET / HEAD | 当前身份、原预览及明确可提交目标 |
| `requests` | POST | 201 原正式请求视图 |
| `requests/:requestId` | GET / HEAD | 原正式请求及近期独立查询 |
| `receipt?requestKey&requestChecksum` | GET / HEAD | 本人同键提交回执 |
| `requests/:requestId/status` | POST | 201 独立状态查询 |
| `status-receipt?requestKey&requestChecksum` | GET / HEAD | 本人同键查询回执 |
| `requests/:requestId/cancel` | POST | 200 原请求取消视图 |

所有路径要求当前 ListingRead 和 StoreRead；三个 POST 另要求 ListingPublish，并由原 owner 再核对象与出生上限。旧 central 请求在核当前真实读权后返回新节点视图不可用，不迁移路线。取消只关闭尚未被节点领取的原请求。两个创建共用 actor/requestKey 锁，跨店复用冲突键也不能额外派发。

## 中断与不确定结果

复用私有加密 journal、原响应、原 parser 和 sealed completion。已收到响应可在不访问平台的情况下重建原结果；completion 丢 ACK 只重放同一密文，中央先核对已保存 checksum。已提交但响应未知的 PUT、5xx 或无法解析的写响应保留原 `outcomeUncertain`，不能因为本地记录是 received 就当作安全可重发失败。

当前权限、owner、节点绑定、应用身份或版本变化后，旧 lease 不取得新平台请求许可，迟到结果不能恢复失效权限。公开应用继续固定原 clientId，节点使用匹配本地应用 secret；秘密不进入模型、页面、原键、日志或结果。不存在授权时不伪造真实卖家会话。

正式操作的原身份仍能进入许可检查、但业务权限已经失效时，先在同一事务关闭原执行、释放原凭据 use 并保存拒绝事件，再在事务外返回拒绝。不能因为在事务内抛错回滚这些记录，使任务永久显示执行中；该处理不授予新的 HTTP 许可或采用迟到成功。

此终态处理覆盖已进入正式操作回调的业务权限拒绝。若成员或店铺权限先在身份层拒绝，回调不会执行，原 use 可能等待既有 300 秒租约回收；不会因此获得平台 I/O。原授权撤销或店铺变更会按既有 owner 旋转代次并清 use。本批不宣称身份层所有撤权路径都已即时持久结案。

## 兼容与验证

新183迁移只添加明确正式操作、原意图路线与操作/结果记录，保留旧182原 preview、central、事件和旧列值，不回填历史授权或重写旧 AAD/journal。必须在当前一次性数据库及真正封存182来源上验证。旧节点仅声明原操作时，不领取新操作。

最小验收覆盖实际 public/private、真实 CLI/mTLS、原能力与预览、明确正式提交及后续状态；同键并发、丢201、丢ACK、未知PUT、已BUYABLE不冒充成功、当前失权和源变化、离线/排空/取消、RLS/不可变性及秘密输出。个人编译页面覆盖明确确认和跨刷新原键恢复，桌面及手机布局如实记录。

外部 Marketplace 使用原允许 URL 校验后的合成 HTTPS 提供方；这不等于真实卖家正式发布验收。普通148及其运行 API/Web保持，开发183不自动采用；Feed、Etsy写入、真正店铺试点、普通版本采用及完整 B21 继续。检查后清理本批自有日志、截图、候选和一次性资源，885历史冻结路径不重试。

## 本批验证结论

51 项定向单元、10 项当前隔离接口、1 项真正旧182来源到183升级及2项同一编译候选的个人浏览器场景，共64项去重通过。沿原批准版本明确确认后只产生一次正式PUT；后续独立GET、未知写不重发、原键并发及丢201/ACK恢复、权限与出生上限、RLS及不可变性均有本批证据。原182的3663文件和389个依赖链接单独封存运行，15表原列的驱动规范化摘要保持，旧central路线、原队列与旧reader兼容。首轮实际失败已保留，修复后仅补相关叶。1440与390的四张实图已目视。

8 组一次性数据库、私有桶和Redis经独立审计查无；7948个本批临时文件、10个目标及392个链接已清，共享依赖保留。日常148原API/Web、原存储与扫描器保持。开发183未采用，没有真实卖家发布或付费模型调用。身份层在正式回调前拒绝仍受既有300秒回收边界约束，本批没有扩大即时结案主张。Feed、Etsy写入、真实店铺试点、普通采用及完整B21继续。

详见[交付结论](../project-control/checkpoints/2026-10-23-publication-node-submit-74c2e8b1-delivery-validation.json)。
