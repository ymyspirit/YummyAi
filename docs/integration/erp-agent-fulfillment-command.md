# 原履约的 Agent 命令桥

版本 1.1.116 状态 本机人工确认桥接局部验收并采用186 新模型提案未接通

原14类履约意图已有原拥有者、精确类型回执、租约和原键恢复；旧Agent目录及native-v3仍严格五域37类。本片建立独立的`erp-agent-fulfillment-command-v1`准备与逐项确认边界，复用原意图身份和保留期，不新建业务事实表，不扩旧strict schema或旧pin。

## 选型与复用

先核对开源[LangGraph interrupts设计](https://github.com/langchain-ai/docs/blob/main/src/oss/langgraph/interrupts.mdx)：持久身份、等待人工输入和原检查点恢复。其恢复会重进节点，因此幂等与身份仍须业务拥有者保证。本项目已有PostgreSQL原履约意图和原owner fence；采用相同的准备后等待确认原则，直接复用现有Nest、Zod和业务服务，不引入第二套运行器或新依赖。这是实现选择，不是外部项目已完成本ERP集成的证据。

## 数据与确认

- 新请求固定父orderId与原14类Prepare DTO。原requestId、原requestChecksum与原kind/target/package/version一并核对。production_milestone继续用externalEventId，其余保留原幂等键。
- 原表单增加独立的只准备交接。该路径保存原意图后进入AI任务的履约核对页；不调用原execute，也不把模型建议当作批准。原正常提交路径保留。
- 原拥有者提供受权原文读取，校验原加密envelope、canonical hash、来源、出生权限和当前权限交集。过期、匿名化、归档、ack或清理后不重建正文；浏览器仅存不含正文/token的恢复索引。
- 新版本确认凭据绑定actor、tenant、原intent/request/checksum、原正文、出生权限摘要、当前会话、代际、prepared或uncertain状态及短有效期。uncertain采用单独的明确恢复决定，不改名prepared，不套用旧Agent token。
- 新准备将不可变contractVersion保存为`erp-agent-fulfillment-command-v1`。0186只扩原185 INSERT trigger协议白名单，其他来源、身份、原文、租约和保留期约束保持；不改旧185 SQL，不迁移旧v1意图。旧入口读取新协议只返回真实标量状态，不能通过execute/cancel/ack绕开新确认。退出登录清掉浏览器索引后，该限制仍保存在原记录。
- WorkflowRead/Run不能替代原逐kind的OrderRead/PII/Write及Design/Asset权限。原prepare、confirm claim和原业务事务的fence核对Workflow权限；只在适配器外先检查一次不够。原service和控制器保持受权原路径，不复制事实表SQL。
- 201丢响应或执行丢响应后，仅GET查询原request或原intent并恢复原拥有者回执，禁止自动重复POST。取消、确认已读、租约代际与原业务历史保持原职责。
- 执行中撤销WorkflowRead时，收尾事务也受权限门约束，不为清租约绕过撤权。无原业务回执且仍在原120秒租约内时不允许取消；恢复权限后只读核对，等待真实租约到期再按原决定处理。权限变化后旧确认凭据失效，重新GET生成当前本人凭据也不能扩大出生权限。

## 接口与页面

新API前缀`/v1/agent-fulfillment-commands`，BFF前缀`/api/agent-fulfillment-commands`。有限路由为workspace、prepare、receipts、requests查询及单项读取/confirm/cancel/acknowledge。所有入口使用现有本人租户上下文，no-store，不接收调用者指定的tenant或授权header。

新能力目录版本组合旧37项与14项履约descriptor；目录不代表原资源可执行，实际准备仍核原来源。页面在原数据、完整原文及当前确认有效时才允许逐项操作，保留失败、未知、到期、撤权和清理状态。身份变化、关闭或刷新清掉原文和内存凭据，迟到响应不能重新出现。界面沿用既有密集ERP、Lucide和交互/动效规范。

新命令桥只是完整Agent接入中的一层。当前native-v3仍不能输出14类新提案；新模型协议、工具发现/MCP、新任务选择及实际模型质量必须继续单独接通并验证。不得以目录、人工准备或本机接口通过宣称模型到执行闭环、工厂生产、实物交运或平台发送已经完成。

原日常表单目前可达13类操作。独立`shipment_create`有原API和共享契约，日常界面目前使用整单包裹创建；本片保留实际13个表单入口，不将整单创建当作单独创建的界面证据。新协议API的14类分别验证。

## 验收与清理

14类逐kind走新准备→确认前零业务事实→人工明确确认→精确原回执；另核旧37/native-v3兼容、原键及版本/actor混淆、prepare/execute丢响应只GET、出生缺位与撤权、清文晚返回、并发/审计/租约与裸业务入口fence。个人编译页面覆盖原表单只准备交接、原文核对、逐项确认和未知结果恢复，1440/390查看实际渲染。

使用一次性数据库/桶/Redis及本人OIDC夹具，隔离缺项连接前拒绝。主控串行验收，已过的无关整套不重复。验后删除本批日志、截图、trace、下载、缓存、未采用候选与隔离资源；保留源测试、简洁结论、清理记录、运行图、原账户/业务数据、原23业务备份及本轮新增1份业务备份、1036积压和885历史冻结路径。全平台及精确提交CI仍未完成。

## 升级与运行

本片需要185→186。隔离验收必须从保留的真实185源码图读取185份实际迁移及旧拥有者，验证旧记录仍按v1处理、新记录不可通过旧入口执行；不能用当前源码截前缀代替旧图。日用185在验收和备份恢复核验前保持原样。正式采用时配对186源码图与Web候选，先备份并恢复核验，再升级数据库和启动配对进程；仅旧185源码回退不能作为新协议的降级方案。

本轮结果：8单元、31唯一服务、1真实185升级及2条同编译个人页面，共42项定向检查通过；14种连接前隔离拒绝另记。实际日用185完成停写备份、恢复演练及186升级，原列投影与旧迁移前缀保留，配对进程已恢复。原账户页面只读核验通过。本批临时输出、未采用候选和隔离资源已清理，24份业务备份和原1036积压保持；历次失败未计入通过数。详见[本轮结论](../project-control/checkpoints/2026-10-23-agent-fulfillment-command-d6b2f901-final.json)。完整平台、模型新提案及真实生产交运仍未验收。
