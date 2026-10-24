# 本地 Responses 模型渠道

2026-10-21 a64d29f1再次只读实测：由已验证OIDC服务成员，复用普通148源及原加密凭据回读“本地 Responses”渠道；`http://localhost:8080/v1`、Responses、`gpt-6.1-sol`与启用状态保持。实际鉴权目录仍返回19个模型，含该文字模型；渠道、路由和全部可见偏好逐表摘要前后相同。没有重存凭据、改变默认值、生成内容或启动普通应用。匿名模型目录401，普通Web3000/API8000不可达；原普通Web启动被自动审批以`blocked by policy`拒绝，未重试。配置与鉴权当前有效，实际生成继续引用9ce4b210单次证据，服务成员验证不冒充本人页面验收。[本次精简结果](../project-control/checkpoints/2026-10-21-factory-capacity-a64d29f1-responses-readback.json)。

2026-10-21 04:48（Asia/Shanghai）7d312a60只读复核：现有“本地 Responses”渠道及`gpt-6.1-sol`回读通过，复用库内加密凭据实际鉴权目录仍返回19个模型。渠道、路由和个人偏好的摘要前后相同；没有重存密钥、更改默认值、生成内容或创建测试资源。普通库仍148，OIDC发现200、网关匿名目录401，普通Web3000与API8000当前不可达；没有重试此前被自动审批拒绝的普通Web启动。当前结论为配置和网关鉴权有效，普通工作台尚未恢复；实际生成仍引用下方02:41的单次证据。见[本次精简记录](../project-control/checkpoints/2026-10-21-responses-status-7d312a60.json)。

2026-10-21 02:41（Asia/Shanghai）9ce4b210最新实测：复用已有“本地 Responses”加密凭据和当前真实OIDC服务成员权限，配置原拥有者回读通过，鉴权目录返回19个模型；`gpt-6.1-sol`通过一次实际`/v1/responses`结构化请求，输入117、输出18 tokens，费用未知。渠道、路由和全部可见偏好摘要前后相同，没有重存凭据或改默认值。普通库仍148，Web3000/API8000/Canvas4177当前不可达，未启动任何Worker或发送业务数据；服务成员验证不等于本人浏览器验收。见[本次结果](../project-control/checkpoints/2026-10-21-responses-recheck-9ce4b210-result.json)和[续做记录](../project-control/RESPONSES_RECHECK_PROGRESS_20261021.md)。下方145运行、97/13 tokens及截图描述均为历史证据。

2026-10-21较早观察（传输状态已由上方最新核对更新）：原加密渠道及8份私有备份逐字节保持，此前普通API/AI/维护/Canvas六进程已退出，当时本地模型代理容器未启动。仅恢复基础设施，未重新鉴权或生成；下文连通证据是2026-10-20历史结果。见[当时运行观察](../project-control/INVOICE_RECONCILIATION_PROGRESS_20261021.md)。

2026-10-20本轮从运行中ERP授权配置接口再次回读“本地 Responses”启用/已存凭据/gpt-6.1-sol，并用库内密钥实际鉴权模型目录成功19项。未回显密钥、修改默认模型或新增生成调用；此前严格Responses实际调用证据继续有效。普通后端仍148，3000原启动审批限制未重试；见[本轮记录](../project-control/checkpoints/2026-10-20-invoice-command-d7a8e0c2-responses-readback.json)。

采购计量149仅在新隔离资源实施验收；普通148原API/AI及本地Responses加密渠道保持，本批没有新增实际模型调用。新采购/发票页面的编译验收使用合成个人身份，不代表普通Web已恢复；原3000启动审批拒绝未重试，见[采购精度进度](../project-control/PROCUREMENT_PRECISION_PROGRESS_20261020.md)。

当前148后端沿用本地Responses原加密配置，API及仅ai-assist消费者已在第8份新业务备份/独立恢复/受控采用后运行，原模型配置和默认值逐表核验保持。本批未新增模型调用。Web启动被自动审批拒绝，当前3000不可用；本页下方145运行、调用及浏览器为当时证据，不能冒称本次页面通过。最新结果见[普通148采用](../project-control/PROCUREMENT_ADOPTION_PROGRESS_20261020.md)。

2026-10-20 按用户提供的回环服务接入，复用 ERP 原有模型配置、OpenAiProvider、SecretVault、BullMQ 和个人 OIDC，没有增加依赖或数据库迁移。当前渠道名为“本地 Responses”，基础地址为 `http://localhost:8080/v1`，登记的文字模型为 `gpt-6.1-sol`。目录实际鉴权返回 19 个模型；目录列出不代表每个模型或图像、视频能力都已验证。

## 配置与权限

`channel.save` 增加可选 `textProtocol: responses | chat_completions`。Responses 使用既有 `provider=openai`，Chat Completions 使用 `provider=openai-compatible`；旧调用不传该字段时保留原地址推断。已有渠道不能原地换协议，须新建渠道，避免改变原任务的执行协议。编辑、目录查询、默认值和删除继续经过 `model:configure`、当前成员权限和租户 RLS。

模型设置位于 `/settings/ai`。在编译运行的个人模式下，仅渠道和配置 BFF 接通现有个人会话链；未登录返回 401，生产模式不能回落统一服务身份。其他创作接口保留原有部署边界。设置 iframe 仍限回环来源、窗口、随机通信通道及允许的 RPC。

密钥只进入既有模型专用 AES-256-GCM Vault，保存在数据库加密凭据列。不写入源码、`.env`、浏览器存储、iframe URL、队列或本文件；公共读取仅返回已保存标记。实际配置通过运行中 API 写入并回读核验，没有修改其他渠道、价格或用户默认值。用户可在默认模型页选择新模型；不猜测用户身份或替其他成员重写偏好。

## 实际请求与恢复

业务助手通过既有 OpenAiProvider 请求 `/v1/responses`；创作台的文字网关也按实际提供商传入该协议。图片和视频继续使用各自接口，不能由本次文字连通推断可用。

请求明确设置 `store:false` 和 `stream:false`。本地服务仍实际返回 SSE，因此共享 `readResponsesPayload()` 同时接受有界 JSON 和 SSE，默认总字节上限 8 MiB。SSE 只接收完整 `response.completed.response` 作为结果，不以已到达的 delta 或 `[DONE]` 判定成功；显式状态必须完成，嵌套未完成、错误或拒答同样拒绝。完成后关闭流，断流不重发、不切换 Chat 接口。

原响应检查点、任务提交/未知结果、预算占用与人工核对仍由既有 Harness 管理。本次真实连接检查使用合成输入，未读取订单图片或改变真实业务状态。费用没有确认单价，保持未知；不登记虚构的零元价格或账单。

协议依据：[OpenAI Responses 流式事件](https://developers.openai.com/api/reference/resources/responses/streaming-events)。实现复用本仓库原有适配器和固定版本依赖。

## 验证记录

- 配置专项一次性隔离集成 14 项通过，没有重跑完整集成。
- 契约 6、文字网关 34、配置 BFF 14、设置运行配置 1、共享解析与 OpenAI 适配器 26、原结构化输出 2 项通过。
- 验收输出保护另有 2 项定向断言通过：同时读取当前使用的字符串清理拒绝记录和旧对象格式，继续禁止复用被冻结路径。此修复只影响后续测试输出规划，没有改动已采用的运行源码。
- API、Worker、Web、Canvas 与 ai-core 的相关类型检查、定向 lint 通过。实际恢复 351 表、145 条迁移及 1,834 个私有对象的内容、RLS 和授权均通过；恢复副本上真实 API、编译个人 Web、未登录 401、配置回读、桌面和手机页面通过。个人登录使用明确合成身份，不代替用户本人会话验收。
- 真实目录鉴权成功，最终严格解析器从 ERP 加密配置完成 Responses 结构化连接检查，输入 97、输出 13 tokens，费用未知。旧解析器的两次受控连接检查失败后才修复；没有自动重试业务任务。

当前原始证据、采用、失败及清理分别保存在 `docs/project-control/checkpoints/2026-10-20-responses-provider-2fcea036-*.json`。旧 PRD 1.1.52 ZIP 为历史封存快照，不包含本次新增的运行记录。本切片不代表平台、工作包或真实账单完整验收。

## 当前本地采用

普通数据库仍为 145，没有执行 146/147。最新配对备份为 `.artifacts/backups/erp-responses-adoption-20261020-2fcea036`，备份及恢复后再次核对的 351 表、105,846 行和 1,834 个对象全部保持；备份为真实私有运维材料，不能按测试输出清理。

- API 与 AI Worker 使用独立 145 源码 `41a819959d1e0041aeb200f58156e572423d0348cb6ef7e742922acea8ac00bf`，目录 `.artifacts/ordinary-api-source-145-responses-2fcea036-r2`。
- Web 使用 145 源码 `0ffd1822bca8c270da0dedfa3f22e13d692317971cf4b681f9f730dfbf749a0d` 的编译产物，候选 `7f5c4d0e2e354fa9bb02f8b71c0d6b8a`、BUILD_ID `1DYs50S292YTs6jD_kgR0`、1,471 个产物逐字节核验。由原构建 `4b515c1ab6954b1d8c89bd2a78ca2646` 仅复制封存产物提升，未复制构建缓存。API R2 与 Web R1 仅相差 ai-core 完成判定，Web 不导入该包，所有 Web 与契约输入字节相同，配对证据单独保存。
- Canvas 设置静态服务使用 `.artifacts/ordinary-api-source-145-responses-2fcea036-r3`，源码 `38d03cdce18667ae5534e54dfcfbb583d057dff62ec7c904b91e105d69381db7`，地址 `http://127.0.0.1:4177`。该版本额外修复原 640px 抽屉在 390px 屏幕被裁切，真实复验左右边界为 0–390。
- API/Web/Canvas 健康检查均 200，生产配置 BFF 未登录 401，实际已授权配置读取 201。普通个人 Web 会话和加密域未轮换，不将合成验收认作用户本人重新登录。
- 开启且仅开启 `ai-assist` 消费者及其 `aiAssistScheduler`。开启前实际队列没有待处理项，持久 AI 执行为空，只有已完成/失败历史；开启后 32 队列的所有状态计数不变，其他 1,036 项待处理未消费。原两项物料/来料维护仍为零消费者。原全量 Worker 启动器不可用于替代这个选择。

恢复组合验收先后保留四次失败：首轮未记录具体失败阶段；第二、三轮记录到 Windows `--import` 绝对路径错误；第四轮为测试把 Antd“取 消”误按“取消”精确查找。第五轮完整通过；没有放宽业务、响应完成或数据保护断言。

## 清理与续做

本批 13 个自有临时目标、77 个文件及 643,840,441 字节已通过原生清理，随后独立确认全部不存在。范围包括验收截图、trace、测试日志、测试缓存、源码复制辅助目录和原构建候选的缓存；保留当前服务、封存构建、三份 145 源码、七份真实私有备份及必要验证记录。历史 879 个策略拒绝路径继续冻结，本次没有重试这些路径。

接入收尾时重新核对 69 个保护文件、三份各 2,556 项运行源码、当前 Web 的 1,471 个封存产物及三个服务健康状态，全部通过。当时完整工作树源码为 2,592 项，SHA256 `15faeda11617cbf1fdca47ffc312ca91f6af7ae9e1c16a775620e2aafe83c611`；其 146/147 采购增量没有混入普通 145 服务。后续 1.1.53 已增加隔离 148 与采购恢复修复，最新 2,598 项源码和验证见[采购恢复进度](../project-control/PROCUREMENT_RECOVERY_PROGRESS_20261020.md)，普通 Responses 运行仍为本节记录的 145 版本。

接入独立结论见[最终核验](../project-control/checkpoints/2026-10-20-responses-provider-2fcea036-final.json)。本次模型接入已完成；采购进程、隐私清除周期和 145 到 148 隔离升级已有后续证据，普通受控采用仍待进行，整体工作包与业务验收状态不变。
