# 生产个人会话创作 Studio

本片属于原 CAP01—CAP08 创作迁移，不新增独立 ERP。2026-10-23 本机日用已采用 `6e8c4a19` 最终 R6 源码与编译配对；数据库继续使用 current187，无新增迁移。以下是已采用的局部边界，不代表全平台验收。

## 原业务所有者与个人入口

复用 Infinite Canvas v0.20.0，以及原 `CreativeStudioService`、`CanvasBridgeService` 和 `StudioGenerationService`。当前 adapter 为 2.3.0，上一套为 2.2.0，初始归组的 2.1.2 是历史版本；具体产物以固定部署记录为准。184 个 vendor 文件保持原字节。Canvas、图片、视频、提示词和素材继续共用原创作入口，模型设置保持独立。

个人入口是 `GET /v1/creative-studio/workspace?scope=...` 和 `POST /v1/creative-studio/invoke`。后者采用 `version/contextAuthority/request` 严格封套；返回绑定 `version/scope/contextAuthority/operation/data`，每一原操作有独立结果 schema。authority 是当前会员的 ERP 权限投影 canonical 串，不是认证凭据；真正业务授权始终使用完整本人 context 与当前会员交集、原项目和素材所有者。

`workspace` 返回当前 scope 的 read/save/mediaWrite/review/submit/configure 能力。用户已要求暂不启用真实付费调用，因此 `generation` 明确为 `enabled:false/code:operator_paused`；服务端拒绝新 generate，不创建预算占用或队列任务，运行时同时禁止生成控件。模型列表成功不表示渠道、报价或消费者可执行。付费恢复仍需原 Harness 的报价、预算、当前路由、消费者与原键恢复验收，不能通过改前端状态开通。

个人 BFF 仅接固定路径。请求带当前 authority，先认证再读取大正文，严格匹配 JSON MIME，并限制正文时间、大小及取消；完整读取并验证上游正文后，再核个人会话、原 authority 和操作/scope 回显。媒体允许原 20 MiB 文件对应的 base64 结果，错误与元数据有各自上限。不得把未知保存结果当失败后自动重写；先只读原 key/revision 核对。未授权请求不能占用上传读取。

项目选择保留原有最新200条摘要和原 ID 精确恢复。选中但不在近期列表的历史项目仍按原 ID 读取，不回落到空白 unassigned。原 revision CAS、不可变历史、扫描、private authorized 存储、来源及读后重核继续由原 owner 负责。

## 本人清理与恢复

### 模型配置的删除拒绝与原配置核对

渠道和模型删除继续由原 `ModelConfigurationService` 执行版本核对、业务路由引用、同租户排队/执行任务检查与软删除。任务时间已过期不等于状态已终结；仍为 `queued/running` 的任务继续阻止丢弃其渠道密钥。历史终态任务、生成文件与原模型快照保留。

删除拒绝使用 `model_configuration_*` 的固定公开 code 与精确 HTTP 状态配对，经个人 BFF 再核当前身份后转成固定文案。只有 `ai/configuration` 可以采用这些配置错误，个人客户端还须核对响应 authority；任意后端 message、路由标签和提供方诊断不透传。配置目标不存在的明确 404 与本人撤权分别处理，后者继续清除旧 iframe 和填写。

收到明确拒绝时，弹窗展示未删除的具体原因。超时、网络中断、无效回执等仍保持结果未知，核对前禁止再次提交删除。弹窗内的核对只执行 `configuration.get`：原目标已不在时告知当前配置事实；仍在时采用原 ID 的最新版本并要求用户重新确认。不能自动重放删除、按同名替换目标、取消原任务或绕过任务保护。

客户端从 `useErpAccess` 取得当前 authority 和本人范围，在请求发出、正文解析、iframe reply、Blob/UI 写回前校验本人/scope/epoch。退出或 CLEAR 必须同步停止新 RPC、取消在途读取、销毁 iframe、清预览和项目记忆；隐藏另一路由仍保留同本人同 scope 的正常画布。自然侧栏切换未带 `brief` 时不等于清空当前项目；明确更换项目或选择未分配才重新核权。短暂网络故障保留草稿；真正撤权、本人变化及已不可访问项目清私文。`generation.get` 可能提交待审方案，不能列为无副作用重试或末核。

## 固定运行产物与升级

ERP 集成静态 runtime 与旧独立画布分开。生产服务从已固定源码构建，记录 bundle 文件/hash、上游锁和 adapter；运行时不从可变开发目录重新构建。独立 origin、受限 iframe 消息来源、精确 frame ancestor、私有 API 与服务端密钥边界继续保留。单 `yummyai` 项目组现有12个独立容器，包含原10个容器和下面两个静态服务；Web/API继续运行于宿主机。

固定产物位于 `.artifacts/studio-runtime-releases/<bundleId>`，仅包含静态文件、独立 server 与 hash 清单。`studio-runtime` 使用固定 Node 镜像 digest、非 root、只读根、无业务挂载，只接专属 internal/isolated 网络，无宿主端口、默认路由或 IPv6。`studio-runtime-entry` 接该网络与自己的入口网络，只发布 `127.0.0.1:4176`，只向固定 runtime 转发 GET/HEAD，丢弃凭据头，并限制响应体与总时限。两服务均不持有 ERP、模型或存储密钥；iframe只接受固定父 origin。

首次单 internal 服务部署实际没有发布所需宿主端口，健康检查拒绝后自动清理了本次 stateless 容器与网络，原服务未改变。随后采用上述双容器方案，保留 runtime 的网络隔离。正式采用时逐个比对了实际入口的57个公共文件字节和健康签章；不能仅凭 Compose 声明的端口认定可访问。隔离和端口语义见 [Docker bridge](https://docs.docker.com/engine/network/drivers/bridge/) 与 [端口发布说明](https://docs.docker.com/engine/network/port-publishing/)。

部署记录使用独立 `deploymentId`，位于 `.artifacts/studio-runtime-deployments/<deploymentId>/`。相同 bundle 更换镜像或入口程序会产生新的部署身份，不覆盖旧记录；不能用 bundleId 拼接当前 Compose/恢复路径。

采用前校验旧部署完整 pin、实际容器配置/绑定和健康。持久 transition 先于替换；失败自动恢复旧容器并核原 baseline/current hash，首次失败只删除本次精确 stateless container/network。中断遗留 transition 时 `status/start` 拒绝隐式重建，使用 `pnpm studio:recover` 恢复。恢复不依赖失败候选仍完好，第三版本 current 变动必须拒绝覆盖。普通日用 manifest v2 同时固定 bundle 和部署记录 hash，旧 v1 保持不启生产 Studio。

Compose 的同项目多文件及服务独立运行遵循 [Docker 官方说明](https://docs.docker.com/compose/how-tos/multiple-compose-files/)。上游升级仍走 [创作升级规程](../operations/creative-studio-upgrades.md)，保存上一套 runtime/adapter/lock 及业务备份，验证历史文档后再采用。

## 本片验收与清理

使用独立 current187 数据库、桶、Redis namespace、专属 guard 和真实个人会话；生产编译候选与被验源码一致。覆盖文档/合成媒体保存恢复、revision冲突、跨租户/同租户其他本人/当前权限交集、真实 storage I/O 后撤权，以及退出后迟到200不能回填。真实 iframe 与1440/390布局必须检查，不能沿用旧 dev/local-service 或 mocked 配置结果冒充。

最终同源码编译浏览器三项通过，覆盖真实个人文档/合成媒体持久化、丢保存响应后的原键只读核对、实际注销后迟到200不能回填，以及五工具和1440/390布局；最终16张原图逐张审阅。日用采用前完成187的423表/1834对象备份及独立恢复演练，原账户采用后仍有46单；真实五工具入口均显示自动保存和生成暂停。原34队列1036项有序摘要保持，无普通 Worker、模型调用或外部业务写入。素材目录未知尺寸仍显示0×0，初始画布可能需要手动缩放；这些未作为制造参数或完整无人设计能力通过。

验收后核对并清理本批资源、原始截图/日志和未采用候选，保留源测试、精简结论、当前与上一套日用产物及业务备份。既有885历史路径和Docker4冻结文件不重试；当前28业务备份保持。精确清理结果见本片检查点，不把计划删除写成已经删除。
