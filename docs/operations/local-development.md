# 本地运行与阶段发布

日用冒烟入口 `pnpm test:e2e`（或 `pnpm test:e2e:order-daily --suite=order-daily`）使用一次性数据库、对象桶、Redis 和本人 OIDC 测试会话，隔离 Web/API 默认为 3130/8130。订单需求、审单提示和图片上传验收由同一 runner 自动分配独立空闲 API 端口，通过 `E2E_FACTORY_PORTAL_API_PORT` 同步 API、Web 代理、健康检查及测试请求；它仍要求原有一次性数据库与对象桶校验，不接受日用端口。Windows 保留端口导致的 EACCES 应通过隔离端口分配处理，不修改系统保留范围或安全设置。原五项日用页面检查全部保留。生产步骤须具备已审核制造版本、工厂当地时间和真实产能预览，并逐次核对原履约回执；财务测试使用新版来源标识与来源内唯一事件编号，缺失成本和不可归属收入仍明确显示。

工具链：Node24.17.x与pnpm11.10.x。安装使用pnpm install --frozen-lockfile。不要把开发分支或未验收的迁移直接绑定到日用业务库。

已有本机日用先运行pnpm daily:status。健康时保留进程；缺少已固定服务时用pnpm daily:start恢复。日用指针、环境和业务备份属于本机私有配置，不随GitHub检出自动产生。发布切换使用新的固定源码和构建、备份恢复与原子绑定；不能覆盖正在运行的旧快照。

在新机器开发时，将.env.example复制为.env，明确填写本机数据库、Redis、对象存储、OIDC及加密域配置。密码及每个加密域使用独立随机值，外部模型密钥留空。配置本机基础设施后，先在专用开发库执行数据库迁移和本机身份初始化，再按package.json的个人API/Web入口启动；不要对已有日用库重复初始化。完整身份与基础设施约定见[身份契约](../integration/erp-identity.md)和[部署威胁模型](../security/threat-model.md)。

CI使用一次性账户、数据库和密钥；不会连接本机业务库或付费渠道。Windows专用节点锁测试在Windows job执行；Linux保留纯测试及可移植流程。普通Web smoke使用明确的默认文件列表；每个个人/历史/互斥验收仍使用自己的配置及disposable runner，不能绕开隔离旗标运行。P1的本人配置页另在Windows实际编译候选上验证。

Linux P2三类编译候选验收及其Playwright安装在身份初始化、Drizzle检查之后，完整集成之前执行。GitHub Ubuntu的[镜像脚本](https://github.com/actions/runner-images/blob/main/images/ubuntu/scripts/build/install-google-chrome.sh)默认设置`CHROME_BIN=/usr/bin/google-chrome`，因此仅P2启动命令使用`env -u CHROME_BIN node ...`移除该宿主浏览器路径。严格browser guard保持不变：官方registry SHA、固定revision/version、默认缓存中的精确可执行路径及实际binary SHA读取与复核全部保留；其余集成、E2E、构建和扩展门继续完整执行。

发布租约的定向集成使用 `pnpm test:e2e:order-daily --suite=publication-lease-integration`。它复用同一一次性数据库、对象桶和Redis生命周期，仅运行Worker的发布租约配置；完整CI仍运行全部集成检查。个人Studio验收由入口固定单连接池，普通Worker集成保留正常连接池以验证真实账户锁。

原生PSD检查需要ImageMagick 7。Windows固定快照应包含 `packages/mockup-renderer/runtime-lock.json` 所列的本机工具文件；Linux CI按固定官方AppImage的SHA256校验、解包并验证真实透视运算，通过绝对可执行路径传给后续检查。版本及像素探针通过后仍须运行真实PSD集成检查。

每阶段先冻结范围，通过相关检查和对应commit的CI，清理自有验收输出，完成备份、部署和日用核对后，才进入下一阶段。详见[阶段计划](../project-control/PHASE_RELEASE_PLAN.md)。
