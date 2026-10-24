# 实际生产数量与部分停单

2026-10-21 · b72e8c4a · PRD1.1.74定向技术验证与自有清理完成，普通148环境尚未采用0160。

## 数量口径

原生产版本数量保持不变。清点报告分列未开工、在制、已完工和实际报废，允许明确未知。已完工包含已交运实物；已分配、已交运是其去向子集，不能再加进清点合计。已核准停做量来自独立账本，不从cancelled、started、工厂文件回执、BOM耗料或产能承诺推算。

核准时四桶必须全部已知，满足“本次清点合计＋此前已核准停做＝原版本数量”。新增停做量只能从报告中的未开工量扣除，且操作员必须明确确认这些实物对全部原绑定资源都未投入。核准后新四桶加累积停做量仍等于原数量。0新增停做可登记后续清点，不能伪造容量退款。

当前有效质检实物、已审核或真实交运包裹形成不可降低的下界。已审核和真实交运使用并集，每条原allocation只计一次，另展示其中真实交运数。picked_up、in_transit、out_for_delivery、delivered、returned均保留实物去向；标签或市场API接受不等于实际交运。旧包裹未固定生产来源时明确阻核准。实际已投入总量、已完成加报废量、报废量不能被后续报告改回未开工。

报废量本批是清点事实，不是库存报废执行，也没有逐失败组报废归属。存在实际报废而未固定原组时，相关失败组复检和补做明确受阻，不能将报废实物再次变成通过组。实际返料、库存处置、费用、退款、工厂接受和生产放行继续由各自原owner处理。

## 接口与恢复

- `GET /v1/production/orders/:id/quantity` 读取原版本、制造单位、真实来源下界、原产能及数量历史。`reportsBefore`、`reviewsBefore`分别定位本生产单的历史；limit默认20、最大50。
- `POST /v1/production/orders/:id/quantity/reports` 保存不可变清点报告。保存不改生产投影、不释放资源。
- `POST /v1/production/orders/:id/quantity/reviews` 运营核准原报告，追加实际数量和原资源效果，同事务递增一次生产投影并写成功审计。不会自动修改生产状态。

每个新请求固定原生产版本、原投影、此前核准ID、数据库生成的basis fingerprint、实际时间及原幂等键。服务先按当前真实membership核验tenant范围的order:read/order:write，再查原键；同操作者、同对象、同完整正文才回放原回执，不新增审计。新请求才执行当前版本和来源CAS，不盲目刷新旧正文重做。

同页写入结果未知时保留原正文和键，可关闭对话框再恢复；重新读取不改写该原请求。当前权限、操作者或生产对象变化清除私有状态，晚到响应作废。数量报告目前没有独立跨会话原请求保管服务，不将同页恢复称作跨会话恢复。原生产下达继续使用既有durable command。

个人BFF为`/api/production-quantity/orders/:id/quantity`及其reports/reviews子路由。它复查请求前后本人身份、逐权限scope、Origin、父对象、原正文和返回authority，限制请求及响应体，私有响应no-store。不接受caller选租户或服务身份替代本人。

## 原生产与下游

部分停做核准不登记整批cancelled。原cancel_requested可由操作员凭实际证据显式登记剩余生产继续；登记剩余完工前，最新核准必须没有未开工、在制，且实际完工量大于0。原工厂接受和文件版本门仍有效。已有部分停做凭据时，整批cancelled会被服务和数据库共同拒绝，保留剩余实物供后续检验和交付。

initial原覆盖只减当前原版本已核准的停做量。取消状态不再整笔返还未知数量。直接生产新输入可显式指定`quantity`；省略仍表示原订单完整数量，旧正文不会自动改成剩余量，旧原键回原生产回执。新UI要求明确本次数量，同一数值用于工厂查询、制造绑定、产能预览及实际版本。原采购单仍固定完整订单，原生产版本不改写。

补做的净占用按原实物组固定的child版本减其已核准停做量，不按child今日status或后来version猜数量。这只返还原组的补做余量，不产生initial空额。已有实际数量核准后，新的补做必须选原缺陷实物组，不能借整批取消状态重复覆盖已重新安排的订单量。

新根质检只覆盖当时已核准完工量；0完工实物不创建检验。复检仍完整覆盖所选原组。检验recordedAt由数据库实际INSERT时点固定，旧整批质检按其录入时点前的数量凭据覆盖；后续完工数增加不会扩大旧通过检验的范围。原质检、实物组和交运历史不回写。

## 数据库与产能

0160新增`production_quantity_reports`、`production_quantity_reviews`、`factory_capacity_stop_effects`三张forced-RLS追加表；应用角色仅SELECT/INSERT。无历史回填。报告/核准规范正文的SHA、actor、原版本、来源fingerprint、数量守恒、全池效果、原投影和同事务审计由独立SQL守卫校验，实际核准行由数据库记录完整出生事务ID。复制已提交的review或caller marker不能产生新资源效果。

每张原reservation按固定unitsPerItem计算新增停做用量。同一效果行保存releasedUnits及commitReductionUnits：已承诺部分追加等额承诺扣减和释放，原gross commit保留；尚未承诺部分只释放。实际已产、在制和报废不自动退资源。净占用＝原总用量−原release−新stop release；净承诺＝原gross commit−stop commit reduction。预览、预约SQL及回执采用同一净口径。原pool版本即使今天修订、停用或日期已过去，也不会被拿来重算旧预约的单位比例。

锁顺序沿原请求键、父订单、排序work/production/inspection、排序shipment、factory、排序pool及pool/day。写入锁后重读全部依据。读取没有业务写锁。旧无制造或预留账、已按旧取消里程碑释放而缺实际数量凭据的记录保持明确历史未知，可留报告，不能自动核准数量信用；不把已释放的历史容量再次退还。

开源核对参考[ERPNext工单状态与实际数量服务](https://github.com/frappe/erpnext/blob/develop/erpnext/manufacturing/doctype/work_order/work_order.py)和[Odoo生产拆分与剩余量](https://github.com/odoo/odoo/blob/19.0/addons/mrp/models/mrp_production.py)。本实现复用项目既有Drizzle、Zod、个人身份和原owner；没有引入另一套制造系统或复制上述项目代码。

## 隔离验收

runner suites为`production-quantity-integration`、`production-quantity-upgrade-integration`、`production-stop-browser`。必须专用isolation标记、同nonce一次性DB/私有桶，升级必须pre-0160真实159源码；所有config连接前拒绝普通库。个人浏览器使用编译候选、Web3130和独立动态loopback API，要求真实扫描前置及合成业务夹具。

验收后的本批DB、桶、Redis及日志、截图、trace、下载、缓存、旧159副本和候选构建按确切归属清理。保留源测试、精简结论、清理记录、PRD及原始业务备份。普通环境采用、人员业务验收与全平台交付仍是独立工作。
