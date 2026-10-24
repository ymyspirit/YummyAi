# 工厂作废观察的人工核对

2026-10-21，b8d4c307，PRD1.1.80。41单元、3规则、9当前隔离、真正165升级1、受影响原路径3及同编译个人页面2，共59项去重定向检查与本批清理通过。普通148六应用停止，尚未采用166；完整工作包和真实工厂业务另验。

用户确认已作废作为异常单独核对。现有投影只要曾有作废就持续提示，而且成功发货来源可能遮住真正作废来源。本实现为FactoryERP原观察追加人工核对事实；订单异常、取消/停做、质检、实物数量、产能、库存、退款及物流仍归各自原owner，不由核对按钮执行。

## 已冻结ABI

共享模块为factory-erp-source-pin.ts与factory-erp-void-review.ts。原binding source别名保留完全相同行为，旧apply/change成功正文不变。原绑定与交付摘要增加可选voidSummary，不将当前查询结果写进旧不可变回执。

ReviewFactoryErpVoid输入固定expectedBindingRevision/expectedItemsChecksum/expectedObservationSequence，observation（原id/sequence/importId/rowNumber/rowChecksum/fileChecksum/previewChecksum/recordedAt），expectedPreviousReviewId（该原观察的最新核对或null），source（明确选择仍保留的原导出行），outcome/reasonCode，provenance=operator_attested，confirmed=true与UUID幂等键。source可指原作废行或新有效同工厂/外部号/数量的行，不把新来源改写成旧观察。

结果固定id/bindingId/factoryId/observation/source、originalBindingRevision/originalItemsChecksum/originalObservationSequence、reviewRevision/previousReviewId、outcome/reasonCode/provenance、requestChecksum和createdAt。canonicalJson({version:1,operation:"factory-erp-void-review",bindingId,input})定义完整原请求。永久原文不含文件名、外部编号、运单、自由文本或原表私人列。

| outcome | reasonCode | 含义 |
| --- | --- | --- |
| confirmed_active | factory_contact或corrected_export | 操作者确认仍按正常生产跟进，不新增生产事实 |
| confirmed_voided | factory_contact或corrected_export | 本条已核对，仍提示通过原订单流程处理，不声称已取消/停做 |
| export_record_incorrect | factory_contact或corrected_export | 操作者确认原状态错误，原表/观察不改；关联错误另走165 |
| followup_required | conflicting_records、binding_mismatch或needs_factory_confirmation | 仍待跟进，不清除待核对 |

corrected_export必须与新明确行相符：confirmed_active/export_record_incorrect行状态为已审核或已出库，confirmed_voided为已作废。factory_contact是操作者声明已实际沟通，不冒充工厂API验真；私人沟通说明按原订单异常owner保管，不进入本事件。绑定错误只能登记followup_required/binding_mismatch并导向原165流程。

每条作废观察独立线性追加reviewRevision，前驱固定且不能分叉；不能只维护binding的一个全局已核对开关。重复原行复用旧观察，新作废始终重新待核对。全部作废均计数，早先未核对不能被后一次结论遮住。历史包括已解除绑定的旧核对，但新登记必须binding仍active且完整观察CAS不变。

## API、投影和个人页面

同一v1/factory-erp-imports下新增GET bindings/:id/void-observations（cursor为原sequence、limit≤100），GET bindings/:id/void-observations/:observationId，GET bindings/:id/void-reviews（可选observationId、UUID cursor、limit≤100），GET bindings/:id/void-reviews/:reviewId及POST bindings/:id/void-reviews。现有四项tenant读权限、写另需OrderWrite，含原上下文权限上限；BFF严格DTO/原父/同源/当前authority/private-no-store。

观察列表和详情返回basis（bindingId/factoryId/bindingRevision/itemsChecksum/state/observationSequence/summary）与完整原观察view，view含sourceReadable/latestReview/pending/requiresOrderHandling。summary包含total/pending/requiresOrderHandling计数、latest与nextPending；均为完整集合，不是当前页统计。旧成功状态的source字段保持自己的含义，异常链接使用独立作废身份。绑定/交付摘要的voidSummary沿用此结构。

观察证明查询先物化不超过101条选中记录，再按不同来源物化完整sourceClaims的数据库canonical SHA256。完整原AES-GCM封套仍认证version/tenant/import/factory/file/preview/claims摘要；同一数组中只取唯一目标claim，并核对原行、状态、外部key及数量。完整数组不随每条观察返回Node，不改旧封套或弱化认证。旧basis仍通过bindingSnapshots一次读取初始绑定来源的完整claims及密文；本次消除分页中多来源整表传输放大，并非承诺整个GET没有此一次开销。数据库仍需计算所选不同来源的全部claims，未声称CPU与表长无关。

页面由独立组件保管原核对意图和回执，即使来源到期也不挂在私人行编辑器下。先读取原完整组、准确作废观察和当前basis，再选择有效来源/结论，固定摘要后明确登记。未知响应保留本人/原对象/原键/全文，刷新明确恢复；不自动换键或重基。完整观察与核对历史可分页和原ID读取。来源到期卸载私文和新编辑器；当前失权/换本人清除保护内容并拒绝迟到响应。所有真实生产/发货已完成分支继续优先，confirmed_voided另显示业务待处理。

## SQL、锁与恢复

0166只新增factory_erp_void_reviews及必要索引、FK、强制RLS/权限与出生/审计闭包，不改0163/0164/0165字节。不回填旧作废或伪造已核对。表包含id/tenantId/factoryId/bindingId/observationId/reviewRevision/previousReviewId/sourceImportId/sourceRowNumber/outcome/reasonCode/idempotencyKey/requestCanonical/requestChecksum/input/result/createdBy/creationTransactionId/createdAt。

先当前五项tenant写权限与原上下文交集，原成功键先精确核对actor/target/body并恢复，不因后来的解除/到期执行新事。新写读取实际私有S3字节、解析和checksum在事务外；I/O前后重查权限与有效期。最终事务按UUID排序锁原binding出生来源/目标作废来源/明确新来源FOR SHARE，再取既有factory-erp-apply:<tenant>:<factory>槽、void-review请求槽、binding行，重新检查所有固定依据及原sourceProof。无供应商UPDATE升级，无订单锁。

SQL birth必须核对当前actor/五项tenant权限、同工厂活动binding、真实已作废父观察、sourceClaims/完整source pin/数量/外部key、原修订/全部max sequence与逐观察前驱。每tenant/fullxid只出生一次review，同事务审计action=factory_erp.void_reviewed、entity_type=factory_erp_void_review、entity_id=review ID，审计/结果/原请求一致。raw DML缺闭包、换父、伪观察、跨事务冒领或early-flush后再次追加均拒绝。保留已有清文/删除任务与审计门禁。权限或I/O失败不产生部分事实。

## 验收范围

九组当前隔离（含实际5000行中文/null来源的SQL摘要与旧封套对照）、一项真实165升级和两条个人OIDC页面；实际通过数以本批结果为准。覆盖跨订单整组、同一原观察连续核对、多个新作废/旧未核对不被遮、成功状态与异常来源分离、绑定解除/部分重叠更正、原键/到期新来源、失权/RLS/SQL/审计回滚、真实锁等待竞争。18张实物表前后不改。仅按受影响路径复跑旧检查；普通采用、真实工厂与完整54工作包单独验收。
