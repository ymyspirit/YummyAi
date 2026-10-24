# 同单履约原提交与恢复

版本 fulfillment-command-v1 · PRD 1.1.114 · 状态 局部定向技术验收通过 日用185已采用 全平台继续推进

本契约补足现有日常履约在刷新、断线和响应丢失后的原请求恢复。原 ProductionCommand v1 的三种生产下达、Agent native-v3、依赖计划和历史交付 manifest 保持各自格式。

## 原业务拥有者

交付包/提交回执仍归 OrderProductionDeliveryService；进度、质检和补做归 OrderProductionService；包裹、审核、实际交运与平台人工核对归 OrderShipmentService。新意图表不保存新的生产、数量、库存、质检、交运或财务事实。成功只能由原拥有者的原键、操作员、目标、正文摘要和版本回执重建。

十四类固定操作为 delivery_create、delivery_feedback、production_milestone、quality_inspection、quality_group_inspection、production_recovery、whole_production_milestone、whole_quality_inspection、shipment_create、whole_shipment_create、shipment_version、shipment_review、shipment_dispatch、shipment_platform_confirmation。没有任意 URL、SQL、工具名、队列或模型执行入口。原表单明确确认的内容先 prepare，随后 execute 只接受返回的意图 ID。

## 持久与恢复

意图固定本人租户、单个订单、原商品引用、操作种类、目标、业务原键、规范化正文摘要、出生权限、加密原正文和最早保留截止。命令最多保留七天，不能延长原订单或制作资料期限。浏览器不保存私人正文；首次 prepare 响应丢失也可从本人订单待核对列表找回。

列表和 GET 仅查询原回执，不 prepare、不 execute、不产生业务写入或队列。原业务已提交而返回失败时，刷新重建成功回执；确未提交且保留来源有效时，由用户明确按原确认恢复。不同正文、目标、操作员、版本或业务键冲突不能转换为成功。旧无正文摘要的进度不补造新摘要或出生证据。

执行使用短租约及代次 CAS，原业务事务在写前锁定并核对意图与租约。撤销未提交意图不得越过已经准入的业务事务。原业务写和成功审计在同一事务；只读回执不通过新意图状态制造事实。

## 权限和隐私

每次读取和执行使用当前认证成员权限与出生上限交集、普通应用角色及 forced RLS；跨租户、非原操作员、离开原对象范围均拒绝。交付操作保留设计与素材读取权限门。期限到达、归档、订单匿名化和原工作项密钥清除后，隐藏并清除加密输入，停止恢复私人说明；只保留有权访问的最小状态索引及原业务引用。不可用来源不采用今天的新规则或密钥补写。

## 业务区分

正式文件交给工厂后默认预计排产；Excel 已审核映射已排产、已出库映射工厂已发货、已作废独立核对。工厂状态不等于内部质检通过、合格实物数量或承运交运，不把额外清点/报废流程设为普通订单必经步骤。用户审核、工厂接收、实际生产放行仍分别记录。

合法非抱枕 approved_design 生产暂仍缺独立交付来源闭包，另需原设计/素材字节、制造与供应规范、密钥归属及新版 manifest，不能删除 pillow 筛选后宣称已支持。

## 本批验收与交付

定向验证十四类操作映射、原回执精确性、提交后丢响应和刷新 GET 恢复、当前与出生权限、跨租户/操作员、正文及版本冲突、租约并发和取消、审计失败回滚、隐私清除、真正184源码到185升级及个人编译页面。原184全量备份恢复演练与185采用已验证，原环境与1036积压保持，未启动消费者或真实模型调用。验收输出检查后按已登记绝对自有路径清理；885历史策略拒绝路径保持冻结。

开源参考：[Medusa 长运行工作流](https://docs.medusajs.com/learn/fundamentals/workflows/long-running-workflow)将原事务身份持久化后恢复外部等待。项目复用现有 PostgreSQL/Nest/Zod 与原业务拥有者，避免再引入一个 ERP 或工作流引擎。

本批15单元、28接口、真184→185升级1叶及编译个人页2叶通过，共46个不同功能叶。浏览器含交运原200丢响应后刷新只读同一事件、撤回PII后的晚到响应清隐私及恢复同一回执，均核1440/390和减少动态效果。空POST请求流误判403已修，零字节与非JSON/跨站反例有回归。120秒有效来源租约接管未覆盖；合成实物声明不代表真实工厂验收。具体证据和中断恢复见 PROJECT_STATUS.md、PROJECT_HANDOFF.md 与本批检查点。
