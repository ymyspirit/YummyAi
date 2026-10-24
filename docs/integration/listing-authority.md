# Listing 对象范围、当前审核版与草稿保持

2026-10-18 · PRD 1.1.6 · R01/R03/R10/R13/R14，关联 B19/B20。

## 当前拥有者与权限

复用原生 listings、listing_versions、listing_replications 和强制租户 RLS。
Listing 的归属以 listings.created_by 为准；目前没有 Listing 团队列，不从 SPU
归属推导团队共享。读取、内容写入与审核分别使用 ListingRead、ListingWrite、
ListingReview 的当前逐项范围。宽商品或刊登读取不能扩大窄写入/审核范围。
历史记录可能因原成员删除而缺少拥有者，保留合法的租户范围读取；缺失归属不能
推断为当前用户拥有，也不能取得 self 写入权。
直接调用服务或仓库同样检查能力；事务内重新读取当前成员和角色。

创建和复制还核对源 SPU 的 ProductRead。列表、单条、历史、归档、保存和审批
核对各自实际父对象。单条工作区在同一事务共享锁定父 Listing 后读取版本历史。
读取返回 ownerUserId。目录返回 productAccess：Listing 可读但当前 SPU 不可读时，
保留其自身的已保存文案，隐藏实时 SPU 名称和编码并显示不可读原因。

## 审批和复制

保存持有父行锁并核对原 expectedVersionId；旧稿冲突，不覆盖后来的版本。
审批在所属事务重新核对父对象、归档状态、当前最新版本、草稿状态及阻断项，
更新同时约束 listingId 和 versionId，不能批准另一条 Listing 或旧草稿。
撤回审核权不能从旧调用上下文派发审批自动化。

站点复制在写事务重新核对来源当前批准版及 SPU/款式/销售方案/平台关系，
创建调用者拥有的新草稿。历史读取同时过滤源与目标 Listing 的当前读取范围，
不能借来源的宽读取拿到私人目标的 overrides。重复目标的唯一性错误返回可核对
的冲突，不泄漏不可读目标的内容。

## 销售方案来源与幂等

销售方案原有 assertReadReferences 继续拥有来源规则，不重复定义跨域 Schema。
create/save 通过 mutateDevelopment 的 validateSources 在返回既有幂等结果前复核
原请求的研究、印花、素材、SKU 配方、创意项目和账户读取范围。原结果并不授予
来源权限。真正写入仍运行原业务及结构检查，已有模式/履约限制不变。

## 界面与部署

GET /api/listings/:id 仅代理合法 UUIDv7 单条读取，复用本人服务端身份、受限超时
与 private/no-store；不转发浏览器自带授权头，不增加写入接口。配置的部署 API
可使用同一路径，仍须通过原身份认证和后端权限边界。

编辑器按当前身份、Listing 及归属隔离状态，定期及重新聚焦时复核实际对象。
临时读取失败隐藏并禁用正文，重试成功恢复同一草稿；确认失权则卸载并清除，
取消及请求代次阻止旧成功响应复活。内容只读时禁止编辑和采用 AI 建议。
媒体 ID 仅显示“已关联”，不由引用 ID 推断已经过授权审核。

编辑固定最初版本；后台发现新版本时给出提示，不重置草稿或并发依据。
保存冲突保留输入，重新载入由用户明确选择。旧对象保存完成后的响应不能修改
新对象状态。新稿保存后按草稿状态展示，不延续旧批准状态。

## 可复跑验证与剩余范围

- API：apps/api/src/listings/listing-authority.integration.test.ts、listing-catalog.integration.test.ts。
- 浏览器：apps/web/e2e/listing-authority.spec.ts；运行 pnpm test:e2e:order-daily --suite=listing-authority，最终编译使用 --compiled-web。
- BFF：apps/web/src/app/api/listings/[listingId]/route.test.ts。

测试使用隔离数据库、存储桶、Redis 和合成个人 OIDC；每次 runner finally 清理
外部资源。本地原始日志、截图、trace 与本批临时文件验后删除，必要结论与清理
记录保留。完整验证见本批交付及检查点。

本批合成媒体/SKU 引用只验证本地授权与版本，不证明真实素材权利、生产可用或
平台发布资格。销售工作台其他状态、店铺映射和发布/同步的逐对象范围继续核验，
销售方案同步草稿的幂等结果还需补具体 Listing/原来源检查，独立审核/导出入口
仍须分别核验，不能由本批原生 Listing 服务的结果代替。
完整 B19/B20、真实账户/模型、CI、正常部署与业务验收仍需完成。
