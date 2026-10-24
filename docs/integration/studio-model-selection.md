# Studio 模型用途与选择版本

2026-10-24，PRD1.1.124，操作 c5a8f4d1。属于 R13、R20 的创作与模型路由整改，沿用原 B18/B29/B32，不新增平台范围。7条不同隔离API及2条同源编译页面验收通过后，已完成同schema188日用采用：4040源`9cddfec79a3a33ff52e736c0bf358c4672d9bf5bcc2dfa50d615182e9b6b214e`、候选`272fcb1872d640b88c00bf3bbdf3047f`、BUILD `JSuA5LgaBR0ZA46gX7_Kt`与Studio adapter2.6.0／bundle dd7c7f77配对。当前采用已完成，本轮自有输出检查与独立证据终审通过；不计全平台、CI或真实业务验收。

本人原SSO/unassigned会话已只读走查生图、提示词、资产、画布目录和真实`video.preflight`返回`canOpen=true`、`view_only`、`paused`后的视频，五工具保持同一iframe。图片4个候选逐项核对精确route与完整模型名，当前未选；视频0个候选明确空态，两处配置按钮按当前configure权限可用，生成按钮禁用。没有编辑原稿或调用付费模型，普通Worker未启动。实际本人数据没有制造旧稿失效、非空视频历史或无权限状态，这些边界沿已通过的隔离验收记录。

本人网络观察有缓冲截断及一条过期响应未保留，不宣称完整network零写；另行全文保全证明424表106076行含receipts、188迁移、1834个私有对象399221779字节及元数据/tags保持，34队列1036的有序摘要一致。新备份完整恢复及临时资源查无通过，原31目录保留并新增一份，共32备份；896历史冻结清理边界保持。见[合格候选记录](../project-control/checkpoints/2026-10-24-studio-model-selection-c5a8f4d1-qualification-r5.json)、[本人走查](../project-control/checkpoints/2026-10-24-studio-model-selection-c5a8f4d1-adoption-browser-r5.json)、[采用后保全](../project-control/checkpoints/2026-10-24-studio-model-selection-c5a8f4d1-adoption-preservation-r5.json)、[独立复核](../project-control/checkpoints/2026-10-24-studio-model-selection-c5a8f4d1-adoption-independent-r5.json)及[本批进度](../project-control/STUDIO_MODEL_SELECTION_PROGRESS_20261024.md)。

## 用户行为

图片、视频和文字入口只显示对应用途的可用模型。没有配置视频模型时显示可操作的空态，允许进入原 ERP 模型配置，生成按钮不可用。不得以通用模型、上游示例模型或目录第一项代替用户的选择。

首次无选择时可以采用本人明确保存的对应默认模型。已有草稿中的选择若被移除、禁用、改用途或改名，应说明该选择不可用并让本人重新选择。保留原草稿和历史模型文字；单纯刷新目录、切换工具或打开旧稿不得回写这些业务原件。当前模型目录不代表提供方已验证可调用。

## 共享协议与服务端

- `models` 保持本人当前目录数组，每条 `StudioModelSchema` 增加必填 `selectionRevision`，为64位小写SHA-256。
- 新提交 `generate.input` 使用 `StudioGenerateRequestSchema`，必须明确 `capability=image|video|text` 与 `selectionRevision`，并保留原 `modelId`。运行时精确核对 `routeId::providerModel`，不能只接受ID或某渠道中恰好存在相应用途的其他模型。
- 历史 `StudioGenerateSchema` 的新增字段均可缺省且无默认值，原不可变记录继续原样读取。不得给旧任务推造用途、选择版本或今天的配置；旧记录可读不等于允许重新提交或自动恢复。
- 复用模型配置的渠道版本公式，由一个纯函数按route ID稳定排序。版本包含该渠道全部相关路由及提供方更新时间；修改同渠道其他路由也会保守地使旧选择过期。公开目录不返回凭据或完整提供方配置。
- 生成服务必须在原 `withTenant()`、当前本人权限和模型配置事务锁内核对路由、提供方启用状态、用途及选择版本，在任务创建、预算占用、执行分期和enqueue前拒绝不匹配。
- 格式错误返回 `studio_model_selection_invalid`（400）；用途不符返回 `studio_model_capability_mismatch`（400）；配置过期返回 `studio_model_selection_changed`（409）。提示刷新并重新选择，不自动重试付费提交。
- 同一请求键恢复只接受原范围、完整原输入和原模型快照一致；原提交已受理后不以当前配置改写其意图。队列重入次数与不同任务数量分开核对，不能靠测试stub去重冒称只派发一次。

受控商品视觉交付仍由原拥有者明确声明图片用途，核对精确模型并携带选择版本；原固定商品、槽位、图稿版本、提供方指纹和预算校验继续执行。

## 运行时与开源升级

复用已固定的 Infinite Canvas v0.20.0、原模型选择组件与 ERP 适配层，184个上游文件保持原字节，本批没有升级上游。创作目录和配置页使用不同的ID语义，必须隔离适配，不能破坏配置页的渠道选择。当前日用已采用adapter2.6.0及封存runtime；旧2.5.0／8cfc09fb配对保留为同schema188历史回退原件，回退仍须核对整套固定产物与当前业务数据，不能自动恢复业务数据库。

目录刷新使用当前本人/范围及请求代次围栏；失败、切换权限、退出或CLEAR后不得采用迟到目录，也不得恢复旧轮询。模型目录加载不能阻塞文档编辑与保存。五工具切换继续保留同范围iframe、原稿、原任务和视口。

本阶段仍执行用户要求：先完成开发，暂不启用真实付费调用。本人工作区保持 `generation.enabled=false`；本次改动不能把目录成功、默认选择或本地测试变成付费开关。普通Worker和原积压队列保持暂停。

## 验收与清理

核对新契约与旧输入兼容、确定性渠道版本、三种用途的精确选择、同名异路由、空目录、失效旧值、错误用途、配置并发修改、幂等冲突、当前权限与跨租户隔离。使用新 family `studio-model-selection`、同nonce的disposable DB/私有桶/Redis及连接前隔离检查；浏览器使用同源编译候选，检查1440/390宽度、实际选择器、五工具与原稿保持、退出后迟到正文不被读取及未知网络错误。

付费提交函数用受控RPC验证真实函数产出的精确输入，不调用真实模型。API仅使用记录调用的测试enqueuer；不启动普通消费者。检查结束后独立查无测试资源并清理本批新owned目录下的日志、截图、trace、下载与可识别缓存。历史896个拒绝边界保持冻结，不换工具重试。保留源码测试、PRD、精简结果及清理记录；全平台、CI和业务验收分别记录。
