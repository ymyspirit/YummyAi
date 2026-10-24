# 原生知识评测的执行与历史依据

2026-10-21，e4c8a571，PRD1.1.81/state433。可信执行局部41项去重定向检查通过，本批临时产物及10组隔离资源已清理；普通148尚未采用。完整B27/H12、固定数据集、所有角色和真实模型质量仍待验收。复用现有开源PostgreSQL/Drizzle/Zod/React、原Knowledge与Assist拥有者，不引入另一套Agent或评测运行框架。

## 目标与当前缺口

原start先提交可付费Assist，再按tenant/request去重，两位操作者同键竞争可能新增两个Assist而只保存一条评测。页面已收到成功后读取失败却提示未启动，并清除原键。读取时重算评分会在原回答清理后将既往完成结果变成pending，最近两次也可能使用不同样本/来源版本。

本批先完成可信评测协议：原评测、实际Assist、预算/执行意图及评测出生审计同事务；提交后才派发。任何重放均核对本人、原case、model与request，不因case后续编辑或正文到期新建任务。当前权限与原上下文上限在服务及事务内复核，原有效问题版本在新任务出生时锁定。

## 固定ABI

原StartKnowledgeEvaluationSchema及成功{id}正文不变。原KnowledgeEvaluationCase与报告旧字段不变，新增可选protocol、assessment、assessmentState。旧数据没有协议或封存评分就明确legacy/unrecorded，不补造历史。

protocol包含version=knowledge-evaluation-v1、runId、caseRevision、caseChecksum、requestChecksum、basisFingerprint、inputFingerprint、modelId、dataScope、promptVersion、assertionVersion=knowledge-answer-assertions-v1和createdAt。caseChecksum采用canonicalJson原caseSnapshot的SHA256；requestChecksum采用canonicalJson({version:1,operation:'knowledge-evaluation-start',caseId,input:{modelId,requestId}})。basisFingerprint包含caseChecksum、原实际任务内容指纹、实际执行契约、提示词和断言版本；去除运输请求ID、模型选择和检索时间，保留原问题、断言、实际知识顺序/版本/checksum及方法。不同basis只能并列核对，不能计算同样本优劣。

assessment包含id、runId、basisFingerprint、outputChecksum、assertionVersion、retrievalRecall、citedRecall、checks及createdAt。checks沿用既有七项确定性断言，不声称字符串命中就是事实准确。它由原DurableAssistExecution在合法完成事务中保存，不由GET补写。私有回答按原保留期清理，原封存评分不重算；人审与完整成本仍独立，评分通过不等于批准或合格率。

新增只读GET evaluations/:id/run-page（cursor原run UUID、limit1—20）及GET evaluation-comparisons?baselineRunId=&candidateRunId=。原evaluation-runs/:id直读继续，完整历史可以逐页和原ID恢复。旧runs数组入口仍只表示最近20条。

比较返回baseline/candidate原报告、comparable及不兼容原因。只有两个协议均有效、同case和basis、两条实际封存评分且正文/依据仍可读时才可作同样本比较；不把最近两条或第三条正文混作一组，不自动换知识、模型或重跑。模型路由是实际快照，标签同名不代表相同。

## 0167与拥有者

新增knowledge_evaluation_protocols和knowledge_evaluation_assessments及必要原表tenant/id唯一键，不改0097/0098或其他旧迁移。ai_assist_runs只追加nullable creation_transaction_id xid8，旧行保持NULL不回填，未来INSERT由数据库强制真实fullxid且UPDATE不可改变。两协议表不可变、强制RLS、SELECT/INSERT。

protocols：runId主键、tenantId、dataScope、caseRevision、caseChecksum、requestChecksum、basisFingerprint、inputFingerprint、modelId、promptVersion、assertionVersion、proof、createdBy、creationTransactionId和createdAt。assessment：id、tenantId、runId唯一、basisFingerprint、outputChecksum、assertionVersion、retrievalRecall、citedRecall、checks、resultChecksum、proof、createdBy、creationTransactionId、createdAt。fullxid保存出生事务，不作为业务时间。

新run必须同事务有协议和evaluation.start治理事件，协议核对原case修订/完整快照、实际Assist owner/request/model/scope、原输入指纹与当前成员权限；新Assist与原评测同事务出生。新assessment同事务见实际Assist完成更新和evaluation.assessed事件。early-flush后不能把闭包拆到另一事务。旧run不回填，旧原键仍可按实际保留model身份恢复；旧未关联Assist不自动冒领为新评测。

proof使用既有AI_ASSIST_VAULT的AES-GCM封套，内容为上述非敏感身份及校验值；API/Worker认证原封套，SQL不能解密封套，不宣称数据库单独验证正文含义。Worker在评分保存前同时核验原协议与实际输入，保存阶段保留原租约/当前权限及方法检查。任何新评分失败回滚所属结果采用，实际已发生费用仍沿原响应账本保留。

## 界面和当前授权

评测专属BFF覆盖case新建/保存/归档及运行、原ID、历史分页、比较、人工核验，严格校验路径、父子身份、查询、输入和结果，当前本人/权限复核后输出private-no-store与authority标识。旧其他知识入口不由本批扩权。前端以当前authority及资源代次隔离请求，失权清结果/填写，拒绝迟到回填。运行需WorkflowRead/WorkflowManage/WorkflowRun，人工核验另需WorkflowApprove。

发送前持久保存当前本人/原case/model/request的意图。响应不明保留原键；收到成功保存原run回执，后续读取失败仅提示重读，不显示未启动或生成新键。新的付费尝试必须由操作者明确开始。到期只读原身份/封存评分，不重发模型。

## 后续完整B27及验收

固定多题数据集的发布版本、规则基线与候选实验、结构化算术硬失败、所有付费尝试及人工复核分钟/存储维护和单位合格成本仍沿本协议建设。本批不能替代这些要求，未知费用不得按零计算，本地处理重试次数不当作付费调用次数。

已定向验证并发同键/异人/异case/异model、事务回滚、提交后派发失败、真实166升级、过期原键、封存评分、不同来源不可比、当前权限/原上限/迟到响应、完整分页与原ID、SQL闭包及AEAD拒绝伪来源。仅提供方传输和身份账号为合成夹具，OIDC、数据库、原执行器、账本和浏览器路径真实；无实际付费模型调用。16单元、3规则、15新隔离、1真实升级、4旧回归及同编译2个人流程共41项通过，见[进度与清理](../project-control/KNOWLEDGE_EVALUATION_PROGRESS_20261021.md)。普通148不迁移、不启动；真实质量、业务和全平台另验。

原范围dataScope也随协议封存，回答正文清理后仍执行当前各Workflow权限范围及原请求上限的检查；不借其他权限的宽范围读取旧评分。新generic Assist评测请求必须来自内部拥有者admission，HTTP正文没有hook。旧已登记原键继续恢复，未关联旧任务不冒领。

最终读取逐报告检查当前Workflow各权限范围及原请求上限，并在返回前再次检查原任务拥有者、正文保留期和可读性。比较中任一正文在读取间隙到期时整组返回冲突，不返回部分可比结果；重读沿原拥有者清理正文，封存评分继续保留。API/Worker认证原AES-GCM输入与协议，SQL的事务闭包校验不替代解密认证。
