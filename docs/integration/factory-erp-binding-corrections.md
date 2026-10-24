# 工厂绑定解除与更正契约

2026-10-21，PRD1.1.79执行契约。**共享契约、0165、API及个人页面已通过38项定向检查，本批临时输出与隔离资源已清理；普通148环境未采用165，真实工厂和完整平台未验收。** 本操作c6b2e941的实际证据见[进度](../project-control/FACTORY_ERP_BINDING_PROGRESS_20261021.md)。

## 用户确认与原事实

用户确认“已审核→已排产、已出库→工厂已发货、已作废→异常核对”继续适用。纠正绑定不会取消原生产、质检、数量、产能、物料或物流事实。旧观察仍属于旧binding ID，不随新组迁移。

“仅解除”要求当前仍可读的原工厂导出行证明、旧binding ID/revision/itemsChecksum/最后观察sequence以及结构化原因，明确确认后释放整组当前关联。“更正并应用本行”还明确选择完整新组：按原交付owner校验当前工厂、版本、正式文件/制造hash和数量，然后同一事务登记旧组解除、新revision及一次本行新应用。新组只采用这次明确原行产生的新观察。新旧组可以部分重叠，完全相同组不算更正，不能藉此把已发货改回排产。

旧组即使已不是当前生产版本，也可凭新的有效同编号来源解除错误关联；新组选定必须仍满足当前实际交付门禁。原私文已清理时不恢复旧密文或猜外部号，另行核对有效新来源。原因固定为wrong_group、factory_number_reused、duplicate_binding、operator_confirmed_change，不允许私人自由文本进入永久原请求。

## 线性修订与旧意图

bindings仅新增revision、previousBindingId、releasedBy，原列保持；binding_items新增releasedBy。旧根默认第一修订，不回填更正事件。releasedBy是不可变change事件ID的投影，只允许一次null→本次事件，不改回、不换事件；全部原items必须同事件解除。

当前外部号、交付项及生产版本采用active部分唯一索引；历史仍完整。每工厂/外部号/revision唯一、每前驱最多一后继，新根必须接真实最新已释放前驱并revision+1。所有正常归属查询同时检查parent和item的releasedBy为空；历史与来源保留任务不筛active。

正常apply的每行新增可选association确认：expectedActiveBindingId、expectedRevision、expectedReleaseId、confirmed:true。新页面始终提供真实当前依据。旧缺pin正文仅可用于从未解除的初始关联；一旦出现释放历史，缺pin或旧pin必须拒绝。解除后重新绑定必须明确钉住最近释放事件与修订，不能让早先未提交的预览自动重建关联。已成功原键仍只返回原不可变结果。

## 已冻结共享ABI

共享文件为packages/contracts/src/order/factory-erp-binding.ts和factory-erp-association.ts，原apply/preview在factory-erp-import.ts向后兼容扩展。无新增依赖，复用现有Zod、Drizzle、PostgreSQL与个人会话组件。

ChangeFactoryErpBinding输入固定expectedRevision、expectedItemsChecksum、expectedObservationSequence、source(importId/fileChecksum/previewChecksum/rowNumber)、reasonCode、idempotencyKey、confirmed:true；action=correct时另需items与wholeGroupConfirmed:true，release不接收items。

结果固定id/bindingId/factoryId/action/reasonCode/source、originalRevision/originalItemsChecksum/originalObservationSequence、replacementBindingId/replacementRevision/application（release均null，correct必须是下一修订和一次单行新应用）、requestChecksum与createdAt。永久原请求及结果不含文件名、订单号、运单或原表单元格。

新表factory_erp_binding_changes字段：id/tenantId/factoryId/bindingId/sourceImportId/sourceRowNumber/action/replacementBindingId/replacementApplicationId/idempotencyKey/requestCanonical/requestChecksum/input/result/createdBy/creationTransactionId/createdAt。原意图规范化为canonicalJson({version:1,operation:"factory-erp-binding-change",bindingId,input})并计算SHA256。input/result分别按共享ChangeFactoryErpBinding/FactoryErpBindingChangeResult保存。replacement两个FK可延迟到提交校验，correct新application与binding必须真实出生于本次事务并与来源及结果一致。

## 数据库与Harness门禁

0165保留0163/0164字节。解除元数据与0164私文清除按精确列白名单分流；不能撤掉原维护actor、到期、outbox及source_redacted/source_purged闭包。解除产生factory_erp.binding_changed审计，entity_type=factory_erp_binding_change、entity_id=change ID、actor为当前本人，和原结果/整组标记同事务；correct另有原owner的factory_erp.import_applied审计。

source行锁先于binding更新；需要锁旧新来源时按source ID排序获取FOR SHARE，再获取既有factory-erp-apply:<tenant>:<factory> advisory槽及当前binding。外部文件读取/校验在事务之外，并在I/O前后重核当前五个tenant范围权限及请求权限上限。source到期、撤权或版本CAS失败不产生部分解除。正常apply、release和correct共享该序列化槽。

普通apply与correct在交付owner取供应商UPDATE锁之前，不得先通过factory()/record()取得该供应商SHARE；否则同工厂槽和共用供应商的不同工厂都可能互等。新组的原版本、文件、制造hash、完整数量和owner锁必须在insert更正头与解除旧组前完成，之后原apply路径重入核验。release没有新组owner升级，仍保留当前工厂的共享读取门。并发反例通过真实PG等待PID屏障复现，修复不靠重试或放宽业务冲突。

原键先查actor/target/完整body；成功原结果到期后仍可恢复，不执行新动作。新操作必须来源仍保留并通过真实原字节核对。GET只读且不做业务应用。当前权限变化清除页面私文与待确认意图；未知提交不改键、不换正文、不自动重做。

## API与页面

原factory-erp-import controller提供GET /bindings（factoryId/cursor/limit完整修订分页）、GET /bindings/:id（完整原组与前后继、原观察、release回执）、GET /bindings/:id/changes、GET /bindings/:id/changes/:changeId、POST /bindings/:id/changes。GET沿现有四项tenant读权限，POST另需OrderWrite，个人BFF严格DTO/响应/当前authority/no-store。

编辑器位于当前原表行之下，原绑定依据必须重新GET，不用本地假定revision1或sequence0。新候选可以保留当前旧binding的成员，其他活动binding成员禁选。先固定摘要再确认；未知原请求与回执由workspace外层持有，即使原行到期或原关联解除也可恢复。原文到期立即卸载私有候选编辑区，非私有原意图/历史继续按当前授权读取。

实际9项契约、15项Web单元、3项规则、9项current、1项真正164升级和1项编译个人页面共38项通过。更正与解除各一次已提交响应被中断后使用原键恢复；第二次在来源到期后恢复，18张实物事实前后保持。桌面和窄屏截图已查看，原始输出已清理，保留校验与结论。两种实际锁环已回归；全部跨模块并发、上游真实订单准入和真实工厂业务仍需各自验证。

普通148保持停止、不得盲迁。来源保留功能及测试清理仍遵循[保留契约](factory-erp-source-retention.md)。部分唯一索引与跨表约束沿[PostgreSQL官方定义](https://www.postgresql.org/docs/current/indexes-partial.html)和[约束规则](https://www.postgresql.org/docs/current/ddl-constraints.html)，不以跨表CHECK假装永久不变量。
