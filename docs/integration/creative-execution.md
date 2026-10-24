# 创作原操作的持久执行与恢复

2026-10-19 · PRD 1.1.22 · R01/R08/R13/R18/R20/R39；关联 B08/B15/B25。
本页记录已接通的本地执行路径与剩余验收；普通本地库的 129 就绪另有备份/恢复证据，不代替其他环境部署或完整平台验收。

## 拥有者与执行记录

复用 PostgreSQL、BullMQ、现有方法/知识治理、原预算账本和私有存储。队列只传租户、原申请人及业务 ID，不携带权限、提示词、文件或模型密钥。

| 原操作 | 业务拥有者 | 持久步骤与实际处理器 |
| --- | --- | --- |
| 候选设计 | creative_design_candidates | generate；CreativeDesignCandidateProcessor |
| 印花规格适配 | creative_design_versions | spec 原步骤与按实际几何需要激活的 outpaint 子调用；CreativeDesignAdaptationProcessor |
| PSD 编译 | mockup_template_source_inspections | compile；MockupTemplateCompileProcessor |
| 套图渲染 | mockup_batch_items/outputs | 原槽位及明确的新重做次数；MockupRenderProcessor |
| 画布图像/文字/视频生成 | creative_studio_generations | generate；StudioGenerationProcessor |

0129 新增 creative_executions，通过同租户外键固定唯一原拥有者与步骤，并保留原权限上限、源指纹、代码契约、方法发布版、租约、提交、费用回执、加密响应、实际文件和完成交接。业务状态、审核及批准仍由原拥有者维护。旧任务缺失证据时不按今天的权限或方法补造。

## 当前权限和固定输入

创建原操作的事务固定权限上限、方法与知识引用以及实际输入指纹。执行、存储 I/O 前后和拥有者采用结果时，重新读取真实当前成员、逐权限对象范围与来源状态；后续扩权不能扩大原上限。原服务器适配器也必须有实际当前成员。

源指纹来自原业务输入、固定文件、规格和模型路由，不复制提示词到执行元数据。成员失权、来源撤回、规格改变或模型渠道停用时停止执行或采用；方法升级不静默替换仍有效的旧引用。并发锁只覆盖有相应写权限的真实表，不给不可变关联表增加 UPDATE 权限。

适配的 wrapMode 标签不能判断是否产生费用。原 spec 步骤负责确定性裁切/缩放；只有实际几何需要才激活有独立原提交和费用记录的 outpaint 子调用。子权限继承父上限和当下权限的交集，数据库拒绝扩大权限、换拥有者或换父任务。

## 提交、费用与响应

1. 数据库时钟分配五分钟 token 租约，心跳复核当前准入；同一执行最多三次本地处理，重复投递不能抢占活跃租约。
2. 外部提交前固定原预算与 submissionToken。Studio 已有的 generation 预算按原 request_id 复用；不能另建第二条预留。本地裁切、PSD 编译和套图没有伪造的付费回执。
3. 已知费用与最小响应凭据先保存，再保存加密原响应意图。失权、租约变化和后续本地失败不抹掉已发生费用。报告保留八位 USD 精度，原预算六位向上占用；未知费用保持未知，超原额度阻止后续同路由付费。
4. 原响应加密字节写入执行专属内容寻址位置。上传回执丢失可按已保存的原对象键恢复，不再次请求模型。默认七天原响应保留期不可重设延长。
5. 提交后无可恢复结果时进入 uncertain 核对，不重新 POST。视频已固定真实 provider task ID 时只查询原任务；未知 ID 不能推测或新建。

处理器报告及本地预算记录不是渠道发票验真。当前没有为这五类操作交付人工渠道对账或外部原请求自动查询接口。

## 产物和业务审核

实际产物在执行专属位置写入，经 ClamAV 扫描和字节回读校验后，由拥有者事务共同保存文件、来源关系、业务结果及 creative-completion-v1 交接。事务失败不留下成功业务回执，恢复复用原响应。完成状态要求真实原文件与交接校验值，不以界面字段代替。

派生素材继承实际 PSD/图稿许可、期限和批准依据，不能把 licensed 改成 owned，也不能为历史资料补造批准时间。候选和套图仍需原业务审核；技术完成不等于操作员批准、工厂接受或生产放行。

到期维护删除原加密响应和未登记的临时产物，保留费用凭据、非敏感历史关系和已正式登记文件。正在持有租约的任务不由到期维护抢占。

## 派发、原生运行时与恢复验证

五个派发器跟随 Worker 的领域选择，只派发已有新执行记录；Redis 投递失败或丢失不生成新业务操作，不自动接管旧积压。并发派发通过数据库锁及计数隔离。普通 Worker 本批保持关闭。

PSD/套图继续使用 ag-psd、Sharp 和受控 ImageMagick，安装与锁定见[原生运行时](../operations/mockup-runtime.md)。Windows 便携运行时是产品依赖，应保留；下载归档、原始日志与渲染临时目录按交付约定清理。

可复跑源：

- [执行基础与数据库门禁](../../apps/api/src/design/creative-execution-foundation.integration.test.ts)
- [原预算、响应、到期及真实进程恢复](../../apps/api/src/design/creative-execution-recovery.integration.test.ts)
- [五类原生消费者与实际 PSD/套图](../../apps/api/src/design/creative-owner-consumers.integration.test.ts)
- [真实 Redis 的持久派发](../../apps/api/src/design/creative-execution-scheduler.integration.test.ts)
- [受隔离约束的 Worker 子进程](../../tools/testing/creative-recovery-worker.mts)

真实进程用例会结束并重启两个独立 PID，分别验证文件上传后复用原响应、提交结果未知不再请求、重启前撤权拒绝采用。数据库、Redis、MinIO、ClamAV 和原生渲染使用真实本地服务；模型服务为环回地址的合成传输，没有真实付费调用，也不证明视频播放或生成质量。

真实页面另暴露了两个共享 ESM 路径和一个后台自动保存拒绝问题。共享模块改用既有包导出；画布适配 2.1.2 在本地存储边界观察后台 Promise，仍保留失败状态、原草稿及显式重试，等待调用仍收到拒绝。6 条最终浏览器验证当前访问、撤权/迟到响应、跨工具恢复以及画布/提示词保存失败后原记录重试；184 份上游文件未改。桌面与窄屏已走查。最终代码与执行范围以本批 evidence/source-delivery 为准，不把较早源码快照当作当前界面证明。

## 继续完成的范围

本批工作区测试曾误包含数据库包的 17 项集成测试，通过普通 `.env` 应用了 0129，并写入六个确切合成租户的 36 行测试记录。原 303 表、102460 行在排除这些明确测试记录后与旧备份逐表摘要一致；清理事务被外键拒绝后整体回滚，未关闭 RLS、触发器或权限。测试历史单列保留，不宣称普通库完全未变或测试清理完成。普通 129 已完成独立业务备份、实际恢复、结构对照与非拥有者就绪核验；原 1834 个私有对象的全部字节/元数据、107 条原账本前缀及 1036 条普通队列记录已重新核验。具体证据见[普通库就绪](../project-control/checkpoints/2026-10-19-legacy-creative-harness-normal-ready-final.json)和[修正记录](../project-control/checkpoints/2026-10-19-legacy-creative-harness-ordinary-test-correction.json)。

数据库包默认单元配置排除集成文件；四套集成配置在连库前要求确切隔离标记与专属数据库名。根 `pnpm test:integration` 使用隔离运行器，工作区失败后仍等所有后续进程退出才清理资源。API 入口只读检查迁移，不在启动时应用迁移；`db:check` 与本地启动前检也沿用同一就绪判断。空库上的真实 API/CLI 进程验证要求明确失败、不创建表且不监听 HTTP。

五类执行的当前受权读取、原方法入口、续做申请和独立人工核对已接入源码，具体本地证据与仍待完成的终态恢复见[操作契约](creative-execution-operator.md)。旧套图管理 API 的完整拥有者范围与审核来源审计仍需继续，不能由 Worker 门禁代替。真实渠道/模型、工厂、人工业务、CI、完整发布候选与恢复演练分别验收。完整 48 需求/54 工作包/8 阶段保持。
