# 原生视频日志目录与打开预检

2026-10-24，PRD 1.1.123，B18/B29/B32。状态：新增定向API、同源编译页面、已识别自有清理和本机日用采用已有证据，完整平台与业务验收继续。复用 Infinite Canvas v0.20.0、现有本人会话 transport、原 creative studio owner 和强制 RLS；不增加框架、依赖、数据库表或付费调用。当前日用schema188、4018源8cfc09fb、adapter2.5.0／bundleef1df0bc，实际本人目录和暂停打开已核。实际局部结果、失败修复及清理限制见[本批进度](../project-control/STUDIO_VIDEO_DIRECTORY_PROGRESS_20261024.md)。

## 用户行为和真实边界

现有原生视频页挂载会读取 `video_generation_logs` 并恢复 pending 任务；现有 `generation.get` 还可能提交生成结果候选。外层最近40条生成记录不能证明原生日志完整。新视频入口先显示本人当前创作范围的完整只读目录，再由本人明确点击打开工作台。打开仅允许查看与原权限下编辑，不授予任务恢复、新生成或轮询权限。原生自动恢复、poll helper、宿主 iframe RPC 都需独立阻止暂停期间的轮询。原始状态与 task 不得改写成完成或失败；复制冻结历史保留。

## 共享协议

`workspace.videoDirectoryVersion=1` 表示支持。沿原 `/workspace` GET、`/invoke` POST、同源 BFF、严格请求/响应 schema、本人 authority 请求前后复核及 private no-store 边界扩展，不开新 server identity 通道。

- `video.directory`，输入当前 scope；一次事务枚举本人原 scope 下全部未删除 `video_generation_logs`。返回 version1、snapshotHash、total 和完整 items，不返回部分页，不用 latest40、素材列表或 iframe 水合代替目录。
- `video.preflight`，输入同 scope 和目录 snapshotHash；独立重新枚举并核对完整源。新增、删除、修订、值、任务归属/状态或当前权限发生变化时拒绝旧 hash。返回原 hash/total、canOpen、blockedEntryIds、mode=view_only、execution=paused。它只证明本次读取时的原版本，没有长期执行许可，也不锁住其他页面后续编辑。
- 每项投影只含 entryId/key/revision/valueSha256、有限标题/时间、原生状态、original/frozen/invalid 来源、任务匹配分类、ERP任务状态和固定诊断码；不返回原 prompt/config、providerTaskId、地址、凭据或错误正文。

为保持响应有界，单次最多10000条、源JSON合计最多32MiB、投影UTF-8 JSON最多9MiB，为原10MiB metadata封套留余量。服务先在数据库计算完整数量/字节，超限明确422 `studio_video_directory_too_large`，禁止截断并宣称完整。完整目录的 total 必须等于 items 数量且无重复；只有成功完整读取且确实0条才能显示空目录。限制是失败状态，不是‘前10000条’的成功结果。原hash变化用409 `studio_video_directory_changed`；损坏项目返回完整目录及200 canOpen=false，不伪装网络错误或空目录。

目录和预检在 `withTenant()` 内复核原 workspace 权限，以本人 ownerId、原 scope 和 namespace 过滤；不能用 tenant-wide 权限冒领同租户他人的日志。使用数据库时钟和原授权 owner。任务关联仅接受同 tenant、本人、scope、capability=video 的原 ERP 任务元数据；不读取模型配置或任务原件。快照摘要绑定本人、scope、当前 authority、每条原记录及所匹配任务元数据，不能跨人、跨项目或跨权限复用。

损坏JSON、null/异常封装、缺失或未知状态、非法 task、非法冻结标记、异常引用/媒体、原日志误关联二进制素材形成明确诊断并阻止打开；不能规范成 success 或静默略过。普通待处理任务找不到匹配只报 untracked，不推断失败，不创建替代任务。合法冻结副本允许保留来自其他 scope 的旧 task，但绝不恢复。日志只读不会改写 entries/revisions、任务、候选、预算、执行或审计，也不读私有媒体字节、调用 provider、generation.get、queue 或 bridge.submit。

## 页面与运行时

宿主显示未读取、读取中、完整、失败、阻止打开和已打开状态，显示原待处理、冻结及异常数量。‘重新读取’只读；打开前以原 hash 做预检。损坏、未知响应和过期原 hash 不产生打开资格。资格只在当前本人/scope生命周期内存在，不保存到 localStorage。权限撤销、scope切换或 logout CLEAR 同步清除目录与资格，迟到正文不得恢复旧内容。

初次 video 路由在预检和明确打开前不创建 iframe。已有同 scope iframe 在五工具切换时保留；runtime `/video` 路由默认拒绝挂载原生组件，覆盖初次 init、studio.tool 和内部路由。宿主与 runtime 的打开消息必须绑定原 channel、scope、authority 和已核验预检；不能仅以隐藏 iframe 或遮罩保护。其他四工具、未提交图片/视频草稿、复制历史和保存屏障保持。失权必须在原CLEAR边界销毁原生内容。

暂停期间，即使本人明确打开，也不恢复原生 pending，不发 generation.get，不自动保存 failed/success。底层视频 poll 在发RPC前拒绝执行；原生恢复入口应在进入 try/catch 写失败记录前直接返回。画布共用视频恢复入口也遵守暂停围栏。宿主 iframe 中 generation.get 请求被暂停边界拒绝；现有 ERP 外层本人明确查看结果保持原 owner 的授权规则，不作为自动预检。

只读打开五工具也不得仅因Zustand序列化的对象字段顺序变化新增原件版本。对合法的canvas_store/asset_store，可与已读取或已确认的检查点做递归对象键无关的语义比较；数组顺序、字段值及文字变化仍是编辑。不得用未确认缓存代替确认检查点，或放宽失回执核对和媒体原字节比较；等价打开保留原字节、revision和原CAS依据。

## 验收与交付

主 agent 负责共享契约、原 owner/个人服务/BFF、隔离runner配置、串行整合、编译与最终核验。三个子 agent 分别独占纯投影及单测、前端/runtime与界面单测、新增隔离API/browser夹具测试。禁止并行修改共享文件、根构建或根集成测试。

必须验证：超过原40条的完整目录及末尾危险记录；本人/同租户peer/跨租户、失成员/撤权/旧authority；损坏与未知状态、合法冻结与普通pending混合；目录后新增/改稿/删除或任务状态变化造成 stale；只读0get/create/dispatch/bridge/storage写及相关表历史摘要不变；有界响应与CLEAR晚正文；真实同源编译视频入口与五工具切换、1440/390宽度、原草稿/冻结历史保留及暂停后零轮询。

使用新的显式隔离 family/nonce DB、桶和Redis，沿原 disposable acceptance runner；浏览器在创建资源前验证已锁定Chromium157工具链，严格观察请求与未知错误。验后清理本批测试数据、资源、raw日志/截图/trace/下载与可识别缓存，保留源码测试和简洁结论。原896拒绝边界不重试。通过新切片检查不代替48需求/54工作包/8阶段、CI或真实业务验收；日用采用须另核固定来源/编译/runtime及备份恢复，不先重启原健康应用。
