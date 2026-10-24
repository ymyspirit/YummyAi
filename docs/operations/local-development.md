# 本地运行与阶段发布

工具链：Node24.17.x与pnpm11.10.x。安装使用pnpm install --frozen-lockfile。不要把开发分支或未验收的迁移直接绑定到日用业务库。

已有本机日用先运行pnpm daily:status。健康时保留进程；缺少已固定服务时用pnpm daily:start恢复。日用指针、环境和业务备份属于本机私有配置，不随GitHub检出自动产生。发布切换使用新的固定源码和构建、备份恢复与原子绑定；不能覆盖正在运行的旧快照。

在新机器开发时，将.env.example复制为.env，明确填写本机数据库、Redis、对象存储、OIDC及加密域配置。密码及每个加密域使用独立随机值，外部模型密钥留空。配置本机基础设施后，先在专用开发库执行数据库迁移和本机身份初始化，再按package.json的个人API/Web入口启动；不要对已有日用库重复初始化。完整身份与基础设施约定见[身份契约](../integration/erp-identity.md)和[部署威胁模型](../security/threat-model.md)。

CI使用一次性账户、数据库和密钥；不会连接本机业务库或付费渠道。Windows专用节点锁测试在Windows job执行；Linux保留纯测试及可移植流程。普通Web smoke使用明确的默认文件列表；每个个人/历史/互斥验收仍使用自己的配置及disposable runner，不能绕开隔离旗标运行。P1的本人配置页另在Windows实际编译候选上验证。

每阶段先冻结范围，通过相关检查和对应commit的CI，清理自有验收输出，完成备份、部署和日用核对后，才进入下一阶段。详见[阶段计划](../project-control/PHASE_RELEASE_PLAN.md)。
