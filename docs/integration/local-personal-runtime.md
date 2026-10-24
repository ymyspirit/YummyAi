# 本地个人身份与后台队列检查

本契约复用现有 Keycloak、OIDC/S256、服务端加密会话、BullMQ 和应用启动器。没有新增开源依赖、数据库迁移或业务权限。它补齐已有本地环境的个人登录配置，不代替全模块权限、正式部署或真实业务验收。

## 已有身份的配置对齐

先配置 `WEB_AUTH_MODE=personal`、`WEB_ORIGIN=http://localhost:3000` 和独立的 32 字节 base64url `ERP_SESSION_ENCRYPTION_KEY`。保留原有 API、OIDC、Redis 配置；会话密钥生成一次后保存，不在每次启动时轮换，不与工厂密钥共用。

默认检查不会修改身份服务。报告路径必须是工作区内尚不存在的路径，不能指向符号链接。

~~~powershell
pnpm identity:setup:local --report docs/project-control/checkpoints/personal-identity-inspection.json
~~~

工具只连接回环身份服务和数据库，使用单独的本地管理凭据读取配置及已有有效成员关系。它要求已有的公开 Web 客户端、S256、授权码流程、关闭密码授权、字符串租户声明进入两类令牌，以及匹配的 API audience。身份与数据库的关联依据是原 `oidc_subject`，不能根据邮箱或用户名猜测成员。

检查结果可以明确应用时，再使用新的报告路径：

~~~powershell
pnpm identity:setup:local --apply --report docs/project-control/checkpoints/personal-identity-alignment.json
~~~

应用仅允许以下变更：

- 在原回调集合中追加精确的 `/api/erp-auth/callback`，保留旧回调。
- 注册只有管理员可查看和编辑的单值 `tenant_id` 属性，保留其他用户资料配置；已有不安全定义直接拒绝。
- 为缺少声明且恰有一个现有有效 ERP 成员关系的个人账号补充对应声明。多工作区且无选择、已有未授权声明或不兼容标识直接拒绝；无成员、停用和服务账号不获得新声明。

工具不创建成员、角色或账号，不修改密码；保留其他用户属性及基本资料，应用前重新读取成员和配置，应用后回读核验。管理会话在结束时注销，数据库连接关闭。普通请求仍经 `withTenant()` 和非拥有者 RLS；此命令属于 ADR-002 的独立离线运维路径，不能暴露为 BFF 或租户可调用接口。

应用前在 `.artifacts/identity-adoption/<operation>/operation.json` 写入最小配置意图，供部分失败后回读核对；报告不包含账号名、邮件、令牌、密码或租户标识。该私有运维回执须保留并纳入运维保管，排除于 PRD 资料包和测试清理。未知提交结果先回读，不盲目重复变更。

## 个人运行环境

按本地运行手册启动基础设施，并确认数据库迁移及现有编译 Web 对应当前应用源码。分别在两个终端运行：

~~~powershell
pnpm start:personal:api
pnpm start:personal:web
~~~

这两个入口只运行已有 API 或编译 Web，均绑定回环；Web 执行生产模式个人身份预检。打开 `http://localhost:3000/login` 后，由本人完成真实身份服务登录。没有本人登录成功的证据时，只能记录“配置与登录入口通过”，不能记录“个人会话验收完成”。

旧 `pnpm start:local` 保持其显式开发服务身份及整套开发进程语义，不能用于替代本契约的个人运行入口。以上个人入口不启动 Worker、扩展或 Docker，不自动恢复积压业务。

## 后台队列只读盘点

~~~powershell
pnpm worker:inspect
pnpm worker:inspect --include-durable
pnpm worker:inspect --report docs/project-control/checkpoints/worker-queue-inspection.json
~~~

工具复用当前声明的 32 个队列名和共享连接设置，仅执行队列状态键的 `LLEN` / `ZCARD`，不构造 Queue/Worker、不读作业正文、不清队列或投递任务。报告区分待处理与已完成/失败历史，包含采样时间；跨键采样不是原子快照。即使待处理为零，也不代表数据库无可恢复任务或调度器无待派发工作。

本地工具仅支持回环 Redis 和当前 Worker 实际使用的数据库 0；配置其他数据库、非默认 ACL 用户或 TLS 时明确拒绝，避免检查一个命名空间却启动另一个。其余连接能力需在共享连接层另行实现与验收，不能静默降级。

加上 `--include-durable` 时，工具通过独立离线运维连接，在可重复读的只读事务中聚合执行域的状态列，不读取正文。它不判定每个拥有者的实际派发资格；Redis 与数据库不是共同原子快照。

报告始终不授予 Worker 启动权限。正常环境启动消费者前，还须复核持久执行状态、调度器可能恢复的工作、原申请人的当前权限、付费/对外动作和未知提交边界；未评审的积压任务原样保留。按队列和调度器选择运行已单独接通，见[Worker 运行契约](worker-runtime.md)；它不自动批准或重放旧任务。

## 可复跑验证

`pnpm test:tools` 覆盖身份计划和个人启动入口。`tools/testing/worker-queue-inspection-acceptance.mts --report <新路径>` 通过现有 tsx 加载器运行，在独立 Redis 容器中先制作合成状态，再收紧为只读 ACL，验证真实统计、数据库不匹配及认证错误脱敏；最终停止且独立核实容器不存在。正常 Redis、业务订单和真实提供方不作为测试夹具。

实际正常环境的对齐、回读、HTTP、浏览器和清理结论见[本批交付](../project-control/NORMAL_IDENTITY_RUNTIME_DELIVERY_20261019.md)。

独立候选使用相同个人生产预检，start:personal:web 可明确选择已校验候选；隔离编译验收保留精确 BUILD_ID。操作与当前普通采用的策略拒绝见[候选契约](local-web-candidates.md)。

2026-10-20已完成新的实际业务恢复/升级及普通Web/API采用，真实Keycloak表单已显示；本人会话仍待用户反馈。上述旧候选的历史策略拒绝未重试，当前新候选与恢复证据见[运行采用](normal-runtime-adoption.md)。队列前后计数一致，普通Worker仍停止。
