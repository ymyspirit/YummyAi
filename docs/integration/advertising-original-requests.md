# 广告原提交与跨会话恢复

2026-10-21，e3a58d70，PRD1.1.71。本批定向技术验收和自有清理完成，完整业务继续。

复用现有强制RLS、AdvertisingService业务门禁、财务原提交状态机和独立加密vault，参考[Medusa持久执行](https://docs.medusajs.com/learn/fundamentals/workflows)的步骤、状态与补偿设计，不新增框架或第二套业务事实。

七类原提交为import_commit、goal_save、observation_record、analysis_run、action_transition、import_archive、export_seal。完整原文固定账户、目标、原输入和原幂等键。准备只留存填写，不能形成导入、目标、分析或执行事件。操作者明确核对后执行；恢复、列表、原文读取均不执行。

`POST /v1/advertising/commands`准备，`GET`按accountId及可选kind/targetId/before/view读取本人小摘要。`GET /:id`、`GET /:id/original`及`POST /:id/execute|cancel|acknowledge`都必须绑定accountId查询；动作正文严格为`{}`。原文只在明确单笔读取时解密，不进入列表、浏览器持久缓存或日志。Web BFF严格同源、受限UTF-8和private/no-store。

当前Read或该操作的Write/Review允许本人窄读，仍须实际账户范围。执行取准备权限快照、当前请求及数据库成员的交集；后加角色不能扩大旧准备。本人Read不能遍历他人的原命令。已知对象失权、404、切账户和迟到响应须清除旧私有投影。

原提交使用独立ADVERTISING_COMMAND_ENCRYPTION_KEY及advertising-command-v1域，生产要求32字节base64url独立密钥。规范化完整正文最多32MiB、密文45MiB；现有每文件5MiB、批20MiB和HTTP边界继续有效，不截断CSV或修改原previewChecksum。原填写七天按数据库时钟过期；取消/确认/到期清正文但保技术凭据、原事实和原键，不撤销广告动作、不执行外部Ads写入。

实际写入仍由七个原owner入口负责。原版本、测量依据、预览、来源和观察期执行前再核，不自动修正陈旧expectedRevision。真实owner INSERT铸造完整事务ID与结果证明；命令成功、实际业务、原owner审计和命令审计须同事务成立，应用标记不能代替实际写入。延迟数据库检查从实际列核对预期投影；历史事实、换键命中的同业务及旧NULL不追认为新命令成功。

导入的ClamAV扫描与对象存储在SQL事务外。每段前后重核当前权利，最终SQL事务重锁原命令并验证状态、期限、固定原文和当前权限。另一个执行者完成或取消时，迟到请求只能读取原状态或拒绝，不能重复业务；失败清理本请求未引用的对象。不得跨扫描/存储持有成员或命令数据库锁。

页面保留原结构化表单，七类写入均先准备、再读原文核对、明确执行。丢准备响应用同一原文/键重试；执行结果不确定按原commandID核对，不能换键掩盖未知结果。独立入口为`/advertising/originals?account=<ID>&detail=command:<ID>`，只写和只审核者也可恢复本人操作。

本批专项验收覆盖七类真实owner、幂等/丢响应/并发、权限快照和跨账户父对象、陈旧原依据、数据库伪造、原CSV完整扫描与对象清理、原事实兼容、期限及独立密钥。仅使用一次性DB/私有桶/Redis和个人OIDC；普通148不升级、不启动，模型、外部Ads和发布不参与。测试输出验收后清理，保源码和必要结论。


1.1.71实现广告七类完整原填写、原幂等键和跨会话恢复。准备、列表和原文读取不执行，操作者明确核对后由原owner同事务产生实际不可变结果、fullxid证明及双审计。独立密钥、七天数据库时钟留存，取消/确认/到期只清原文，原事实和键保留。99项单元/规则、39项去重集成、同编译3条个人OIDC页面验证通过；本批输出已清理，普通148未采用158，完整平台与业务验收继续。

真实owner和当前账户是最终写入门，Prepare可执行不承诺执行时业务条件不会变化。不可表示的非零亚毫秒executedAt在新Prepare返回400，raw新写返回422；零尾微秒保原字符串，旧saved回放先按原hash核对。明显非法状态迁移在准备阶段409，原状态机不复制。

实际157→158旧列/原正文/hash/审计与原raw回放、无命令回填已核验；普通148不迁移。个人OIDC是隔离真实应用路径，不冒充真人业务试点。1440/390截图逐张查看后清理；减少动态效果未专项执行。精确清理包括old157源副本及310依赖junction，删除不跟随共享源和依赖。旧冻结输出保持。
