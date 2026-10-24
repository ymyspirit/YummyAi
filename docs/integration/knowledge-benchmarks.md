# 固定数据集、规则基线与完全成本

2026-10-21，a7d9e6c2，PRD1.1.82。本批37项去重定向检查通过并清理自有临时产物及9组资源，普通未采用。延续[原生评测可信执行](knowledge-evaluation-execution.md)，不替代完整48需求、54工作包、8阶段及真实角色、模型和业务验收。

## 复用与范围

先核对开源 [Promptfoo 测试样本与断言](https://www.promptfoo.dev/docs/configuration/test-cases/)和[Langfuse 固定数据集](https://langfuse.com/docs/evaluation/experiments/datasets)，采用输入、独立预期、执行、评分和实验分离的结构。继续使用已安装 PostgreSQL/Drizzle/Zod/React、原Assist、BullMQ和账单补证拥有者，不另起一套任务、预算或模型事实库。

本批真实执行适配器为 knowledge_answer，包含确定性来源摘录与精确算术基线、同样本原生候选。其他Agent角色仍需所属业务拥有者适配及真实验收，不能将知识问答伪装成所有角色已接入。

## 发布版本和同样本

草稿内联1—50题，发布须2—50题。每题包含稳定key、原问题/范围/断言、独立数值预期及角色。发布由有WorkflowRead/Manage/Run/Approve的本人明确执行，核对当前各权限与最窄范围；不是市场发布或模型调用。

发布创建不可变版本和逐题专用case，固定题序、case快照、实际来源顺序/版本/checksum、方法与执行契约、任务指纹和basis指纹。原来源/执行上下文以AI_ASSIST_VAULT域封套加密，最长30天且不延长原来源期限。专用case不能编辑、进入旧题额或通过旧公开start绕开实验。正文到期后保留manifest和原评分，停止新的执行；原来源或方法撤回只阻断，绝不换今日检索结果。

实验固定一个发布版本、注册规则版本extractive-arithmetic-v1、实际候选路由及每题最多5次尝试。规则基线只读取原实际输入和来源，不能读取expectedFacts或expectedValue生成答案。算术只允许sum/difference/product/quotient与明确十进制、舍入位数、单位和币种，不执行任意表达式或代码。

候选沿原Assist拥有者的内部admission使用原prepared basis，重建本人请求/模型运输身份与当前权限；公开HTTP无法提供prepared或hook。新评测、预算、执行意图、协议和实验attempt同事务出生，提交后才派发。原Worker成功采用结果的事务同时封存新增结构化评分。GET只读取，不补写分数或创建尝试。

## 结构化硬失败和人工核验

新版评测独立登记assist-benchmark-2026-10-21-v1工具/Skill及erp-benchmark-2026-10-21-v1提示版本，以加密上下文里的knowledge-benchmark-execution-v1选择；公开请求不能指定。新版AssistResult增加无默认值的可选typedAnswers。旧任务保持原输出schema、提示、工具、方法和执行策略指纹，旧结果及checksum保持原语义。数值答案包含key、精确十进制字符串、单位、币种及原来源引用。数值、精度、单位/币种、缺字段、重复键、除零、越界和实际引用错误均是硬失败；答案其他正文包含正确短语也不能掩盖。

每次人工核验固定原assessment、decision、实际分钟、当次小时费率或未知、依据及前次核验ID，追加保留。人工pass不能覆盖硬失败。每题候选以最新实际出生尝试为最终结果；新尝试queued/failed/uncertain不回退采用更早通过项。固定全题分母保留not_started和待人工项。

## 全部尝试与完全成本

所有基线和候选尝试均保留。模型费用按最新原账单补证优先原usage估算再unknown，每次只选一项；不与预算预留相加。本地处理重试与已收到/可能提交的提供方请求分开，失败但已付费的尝试也计成本。

人工分钟与费率逐条累积，USD沿八位精度以整数运算。每arm的存储/维护声明是覆盖已知活动的累计替代值，带期间、分摊依据、previous/CAS及活动指纹，不作delta重复相加。新增尝试或人审使旧声明覆盖失效，需要重新核对。

费用状态complete/estimated/incomplete分开；operator_attested只代表人工补证，不代表渠道API验真。未知费用不记零，已通过硬检查但尚待人工核验的题目也保留incomplete。确定单位合格成本只在成本完整、无未决提交且合格数量大于零时提供；估算值单列，零合格为null。

报告明确封存截止、原dataset/version/checksum、全部attempt/assessment/review/expense/billing receipt IDs、规则/评分/成本版本及摘要。后续补证只能新建报告版本，不改旧报告。列表及尝试历史提供稳定有界完整分页和原ID。

## 接口、权限与运行

API前缀为/v1/knowledge-governance/benchmarks，个人BFF为/api/knowledge-governance/benchmarks。datasets负责create/save/publish/page/versions，versions原ID读取；experiments负责create/page/原ID、attempts/start、costs/expenses及reports；attempts原ID和review、reports原ID分别授权。严格请求/响应/父子ID与当前authority，private-no-store，撤权清空私文并阻止迟到响应回填。新表强制私有本人RLS，沿withTenant非owner应用角色。

0168增量新增记录，不改变001—167，不补造旧dataset/experiment。发布case、原命令、审计、实际attempt和评分双向约束同事务出生；清除过期依据或基线正文须同事务完成原retention job并记录benchmark.body.purged，评分和原报告继续保留。维护任务沿原AiAssistScheduler逐租户调用expireKnowledgeBenchmarkBodiesInTenant，只有不含正文的job元数据用于路由，实际清除继续本人RLS，不因撤权延长隐私正文期限。

0169追加采购与经营两类业务固定评测，使用原生业务任务关联和独立业务基线／检查版本；本知识 v1 的 case、算术检查、执行、命令和历史报告保持。业务与知识分别发布，细节见[采购与经营固定评测](business-benchmarks.md)。其他六类业务角色尚未接入固定评测。

一次性验收使用现有runner的--suite=knowledge-benchmark-integration、--suite=knowledge-benchmark-upgrade-integration（E2E_KNOWLEDGE_BENCHMARK_LEGACY_SOURCE须指向本次逐hash保全的真实167源码）和--suite=knowledge-benchmark-browser --compiled-web --candidate=<本次候选ID>。分别设置E2E_KNOWLEDGE_BENCHMARK_ISOLATED与E2E_KNOWLEDGE_EVALUATION_ISOLATED，并在连接前核对原nonce数据库、桶与current/pre-0168目标；普通单元排除集成文件。TSX关闭默认缓存，所有输出写本批新目录。

普通库148和六应用保持停止，不自动受控采用或执行真实模型/市场/工厂动作。真实167副本用于独立升级验证；所有本批资源验收后删除并独立复核，保留源码测试及精简结论，见[本批进度](../project-control/KNOWLEDGE_BENCHMARK_PROGRESS_20261021.md)。
