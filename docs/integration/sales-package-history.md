# 原方案资料包历史与原文件重现

本模块复用 SalesPlanDeliveryService、SalesPackageService、原不可变版本、JSZip与现有ERP组件。没有新增外部依赖、事实表或数据库迁移。

## 原方案与当前选择

`GET /v1/sales-plans/:id/launch/delivery?packagePage=1` 返回两种投影：

- `packages` 是原 Listing/方案下的可读历史，每页25条，按原创建时间及ID降序，`packageHistory`标明页码、页大小和是否还有下一页。
- `currentPackages` 独立按当前所选SKU、配方、刊登版本、交付指纹和实际资料可用性核对。翻历史页不会令当前包消失，也不会因此提示重复封存。

移除当前SKU、修改方案或建立新刊登版本，不会删除原历史。原SKU编码从封存快照读取，不用今天的编码冒充原记录。历史查询在分页之前应用实际原方案、当前ProductRead/DesignRead来源范围和原Listing的ListingRead范围；其他方案、租户或当前不可读来源不进入结果。缺失制造依据、审核或规则的旧记录不补造为当前可交付。

## 下载用途与文件

`GET :id/launch/delivery/packages/:packageId/export` 的共享查询契约只接受：

- `basis=current`（缺省）：前后复核当前方案及封存指纹，不适用于当前依据时拒绝。
- `basis=history`：按原方案与原包归属、原快照校验值和当前读取权重现文件，不要求原包成为今天的交付版本。文件名带historical前缀，界面明确显示历史封存。

两者均调用原生SalesPackageService：复核每个素材的当前权限、授权域、版本、对象键、大小及SHA-256，读取真实私有文件，再在返回前复核来源。源文件缺失、撤回或字节不同则停止，不能用今天的文件替换原文件。历史包不代表当前可发布、工厂接受或生产放行。旧封存流程仍按原通用包导出路径读取，不补造定制交付审核。

ZIP中的manifest、文案、定制配置、SKU映射和审核记录来自原快照。文件条目按原字节重现；ZIP传输容器的生成时间不作为业务事实或原包整体二进制一致性的证明。

## 个人工作台

界面按当前方案和身份权限指纹隔离。切换对象、收窄权限和卸载会取消旧读取及待下载响应，迟到的私有文件不能自动下载到另一上下文。定期及聚焦读取不提交模型或平台任务；确认失权清除旧核对输入，临时失败保留合法输入供重试。

历史分页保留同一指纹下的核对草稿。下载通过同源受权请求，确认ZIP响应后交给浏览器；失败留在原工作台的历史区，允许重试，不导航到错误JSON。Blob URL和临时下载节点及时撤销。原有白黑蓝、Lucide、View Transitions与reduced-motion约定保留。

BFF对分页和下载用途使用共享严格Schema，拒绝重复、未知及越界参数；保持个人服务端身份、private/no-store与nosniff。API/Web/contracts需共同采用，旧部署缺少新投影时不回退伪造当前包。

## 验证与边界

原生专项为 `apps/api/src/catalog/sales-package-history.integration.test.ts`：独立迁移和桶初始化，仅在严格一次性环境运行；历史关系夹具不带已审核制造依据，不用于证明当前制作或封存。真实完整的准备、审核、封存、下载、改版及再审核由个人浏览器复用已审核的合成上游fixture，通过原生业务API执行。

`pnpm test:e2e:order-daily --suite=sales-package-history` 包含新增历史流程及原双SKU交付回归；加 `--compiled-web` 验证同一BUILD_ID。证据与下载跟随Playwright输出目录，验收后按归属清理。当前本地技术检查、未完成项及清理见[交付记录](../project-control/SALES_PACKAGE_HISTORY_DELIVERY_20261018.md)，不代表正常库已迁移、真实提供方或完整平台验收。
