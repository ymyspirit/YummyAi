# 财务来源身份与拥有者权限（0154）

本轮继续复用现有 FinanceService、共享 Zod、Drizzle、非拥有者租户事务和审计拥有者。没有新增线上接口、模型渠道或正式环境变量。普通库仍为148，本轮154只在一次性环境验收；完整B44/B46及平台仍在建设。

## 当前权限与事务

九个公开方法均在事务内锁定并重读真实成员/角色，再与请求上下文权限取交集，按所需单项权限核对tenant范围。空订单ID的内部读取也鉴权；self/team或过期授权不能借其他权限扩大范围。写入者无需额外FinanceRead即可取得自己的写回执，当前读撤权后不能借旧上下文读取财务。

报表、汇率、口径版本和利润运行仅在首次成功时写同事务审计；审计失败整笔回滚，精确原请求重放不重复审计。原请求键绑定原操作者，换正文或换操作者返回409。来源外部单号的相同证据仍可由当前有权人员读取既有业务对象，不另建第二笔。

口径更新必须提供`expectedVersion`，按实际metricId锁与比较更新。新版本保留`requestIdentity`，同键不能换metricId、操作者或版本预期。重放返回原请求的原版本；后续版本不会冒充本次结果。数据库另核新规则摘要、版本审计metadata.version及当前投影，提前flush/defer约束也不能复用前一个版本的审计。

## 来源与费用标识

新报表必须提供`sourceIdentity`，`schemaVersion:2`：

| kind | 真实作用域 | 约束 |
| --- | --- | --- |
| marketplace_account | 顶层accountId | Amazon/Etsy或广告平台，账户必须存在且平台匹配 |
| supplier | 身份中的supplierId | provider=supplier、accountId=null，每项费用的supplierId必须一致 |
| named_source | 明确的稳定sourceName | 用于人工/承运/税务等，accountId=null，不能替代Amazon/Etsy/供应商身份 |

每行另给稳定`sourceEntryId`，代表提供方原费用事件或组成项。订单号、金额、文件名、行号不能代替经济事件身份。按tenant/provider/规范化来源scope/sourceEntryId跨单唯一；不同供应商可有同号账单，同金额但不同真实事件允许登记。UUID大小写只用于同一账户/供应商身份归一，不改写费用事件、具名来源或外部单号。

Amazon/Etsy归一化保留原transactionId为sourceEntryId，externalOrderId仍为externalReference。此输入的一项transaction必须已经是可独立识别的经济组成项；上游若一个交易含多种费用，连接器必须提供各组成项稳定ID，不能用订单号猜测。最多300个JS码元的原标识完整保留。实际提供方接入与源单真实性另验收。

新statement还在内部保存与原checksum对应的`sourceInput`，不向页面额外暴露原请求。SQL独立校验完整正文摘要、头部、逐行金额/归属/日期及全部声明行；成功审计的lineCount须相等，审计后即封口，禁止同事务提前flush后再追加。JS trim字符集、UTF16长度、ISO日期原文与毫秒精度和SQL一致，避免空文本或被舍入的原文进入后导致公共契约无法回读。

## 真实关系与更正

订单行必须属于给定订单；店铺费用与订单账户、平台一致。SKU/Listing/SPU和已知的订单目录映射必须相符。仅当实际映射或真实内部SKU code可证明关系时判错，未知外部SKU不猜映射。供应商费用可归属真实订单，仍不把该订单账户回填为供应商来源。

当前更正限定为原始事实根的一次精确冲销及可选替换，须保持来源scope、币种、方向、类型及全部原归属。不得冲销冲销行、换供应商或绕到另一来源；已改变的目录人工映射不能阻止对原固定维度的精确冲销。更长更正链和历史未知来源的补证工作台仍需后续实现。

## 历史与利润证据

迁移仅加nullable字段及未来写入约束，不修改旧金额、原正文摘要、贡献明细、时间或旧迁移账本。缺来源身份的旧报表只允许精确历史重放，不能用旧格式建立新报表；不能把旧lineKey自动认定为真实费用事件。

新利润运行固定`sourceIdentityVersion:1`，诊断含`sourceIdentity.schemaVersion:1`和完整`unidentifiedFactIds`。缺来源事实时保留明细、空总额和待核对原因。读取旧运行也撤回已验证总额和breakdown，原存储值/校验值/贡献继续保留。共享isFinanceProfitVerified同时要求金额、归属覆盖及来源依据，订单复盘与AI分析复用同一门禁。

页面显示实际来源scope、源标识覆盖及可折叠全量factId/sourceEntryId；旧记录明确未知，运行诊断只取其自身固定依据。ERP登记完整不证明银行或提供方已验真。分页/全量导入工作台、真实源单验真、持久跨会话财务命令、费用分摊及应付/付款更正仍需后续工作。

## 一次性验收与采用

`pnpm test:e2e:order-daily --suite=finance-authority-integration --cache=false`验证拥有者和原生SQL。真实升级用`--suite=finance-authority-upgrade-integration`，必须提供重新校验的`E2E_FINANCE_AUTHORITY_LEGACY_SOURCE`真实153副本，runner固定pre-0154且拒绝非一次性数据库。不能在临时副本清理后盲目重放旧路径。

个人身份编译浏览器使用`--suite=finance-authority-browser --compiled-web --candidate=<本批新ID>`，只连接该次数据库/桶/Redis及身份夹具。设置新的YUMMYAI_TEST_CACHE_DIR父目录，TSX_DISABLE_CACHE=1，Vitest关闭默认缓存。验收结束后移除本轮原始日志、图片、trace、旧源副本、候选和runner清单，再独立核对资源及保护文件。普通Web历史审批拒绝不重试，也不以隔离入口替代普通启动。

[本轮进度](../project-control/FINANCE_AUTHORITY_PROGRESS_20261021.md) · [金额契约](finance.md) · [应付核销](finance-payables.md)

开源结构参考：[ERPNext Purchase Invoice](https://docs.frappe.io/erpnext/purchase-invoice)，借鉴供应商与单据身份/核对关系，继续使用本项目的租户、追加版本及权限边界。SQL延迟约束行为依据[PostgreSQL CREATE TRIGGER](https://www.postgresql.org/docs/current/sql-createtrigger.html)。
