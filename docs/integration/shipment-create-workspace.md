# 独立包裹装箱工作区

2026-10-23，PRD 1.1.118，本片 `0c7e35a1` 已完成定向验证及本机日用应用采用，数据库仍187。原整单单包裹入口及其他13类原履约表单保留；完整平台和用户业务验收继续。

## 原业务边界

`shipment_create` 的 target 固定为原订单ID，复用 `OrderShipmentService.create`、`CreateShipmentInputSchema`、原 durable fulfillment command 和同一 AFC 核对抽屉。创建只产生待审核包裹草稿；不表示已审核、占用数量、实际交运、工厂发货或平台确认。不新增业务写接口、表或迁移。部分数量、多个包裹及同商品分包使用原创建契约，不能替换成 `whole_shipment_create`。

## 完整只读依据

原API `GET /v1/orders/:id/shipment-create-workspace`，本人BFF `GET /api/order-centers/orders/:id/shipment-create-workspace`。两者拒绝查询参数。原拥有者以当前会员权限与请求权限上限相交，在非owner、forced RLS的同一只读可重复读事务内取得订单、真实商品行及原生产/质检来源。需要tenant级OrderRead及OrderPiiRead；写权限只影响canCreate，读取不授权写入。

共享 `ShipmentCreateWorkspaceSchema` 严格返回 `orderId/orderNumber/orderSequence/contextAuthority/lines/sources/canCreate/blockers`。最多100条商品、1000个来源组，超过时明确拒绝，不截断后宣称完整。原来源数组保持生产版本、检验ID、实物组、检验投影、当前占用及可用量，页面不推算未展示的可发库存。BFF要求本人authority stamp，在上游完整正文读取后再次核对当前会话，严格校验同订单及同authority，仅返回私有no-store响应。

展示印章统一取 `erpSessionAuthority(erpPermissionContext(current))`，与本人ERP会话一致。工厂专属权限继续保留在完整current中用于原授权和canCreate；不能直接用完整current生成页面印章，也不能为解决标识差异而放宽BFF会话核验。

## 本人装箱

原发货区提供按包裹分配本次发货。每包裹选择真实同单商品和本次数量，填写原契约的物流字段，分别核对生产批次和实物组。跨包裹商品合计不得超过原订购数量，同一生产批次/实物组合计不得超过原可用量；服务端原owner继续最终裁决。修改商品或数量会清除对应实物确认，模型不能预勾本人确认。

来源刷新保留本人编辑及旧来源pin，变化时明确要求重核，不能静默绑定今日版本。非空面单资产需要真实授权选择流程；尚无可用选择器时明确阻断该建议，不丢字段或让操作者手填业务UUID。只在内存保留完整表单，URL与sessionStorage不存私文、token或完整建议。CLEAR、退出及authority变化先禁用并中止读取，再清空私文和确认；旧200不得恢复正文或发起新业务GET。

## Agent衔接与恢复

V4第14类建议链接固定原来源订单、商品、父run与item。本人补完后仅准备原AFC，逐项核对后使用原确认流程。父request、固定item与原AFC意图是三层独立恢复坐标，未知准备结果只GET原item回执，未知确认只GET/恢复同一原意图，不另造POST键或重购模型响应。模型给出的来源pin继续固定，操作者独立补充依据由原表单和原owner核验。

分组质检来源使用原实物组记录的 `productionProjectionVersion`。记录检验会推进生产当前projection，两者不要求相等；无实物组来源仍使用生产当前projection。生产版本、检验、组归属和原owner有效性门保持。

新包裹的 `packageReferenceId` 是本次草稿的显示编号，在严格packages结构内校验，不要求它已经是ERP实体。生产、质检、实物组和资产等真正实体ID仍只能使用原保存观察中的允许来源。本人补项继续固定原提案的行与来源关联。

## 定向验收与续做

本片仅对新增装箱、来源校验差异、原键恢复和晚清理执行定向单元、隔离API与本人编译浏览器验收，不重复上一批33项完整矩阵。`shipment-create-integration` 与 `shipment-create-browser` 沿原disposable runner，新增 `E2E_SHIPMENT_CREATE_ISOLATED=1` 并保留V4所有隔离门，当前187、同nonce数据库/私有桶/Redis；浏览器必须同编译候选及本人3130/8130。运行前拒绝非隔离目标。仅模型HTTP使用回环合成端，不启用真实付费，不启动普通Worker，不对外发送工厂、承运商或平台业务写入。

验收后查看截图和关键结论，清理本批资源、日志、图片、trace、缓存及未采用候选，保留源码测试、简短证据和恢复记录。885历史及Docker4个冻结文件不重试。当前日用3894源图已独立配对，423表/1834私有对象完成当前187的停写备份及原样恢复/readiness，无数据库升级；27个业务备份目录保留。本片及开发树不等于全平台已交付。

48项纯检查、5去重接口和2条最终同源本人页面通过，接口组合证据及早期失败见[本片交付](../project-control/SHIPMENT_CREATE_PROGRESS_20261023.md)。两包裹A2+B1只新增1草稿，真实prepare201失响应后原item GET与同AFC明确确认；原注销处理器CLEAR使旧200实际AbortError/0读/无EOF且0新业务GET。20最终实图已查看；8批隔离或恢复资源独立查无，raw与unused构建已清，原账户46单及1036/34队列保持。
