# 创作资料跨项目复制

规格版本1，2026-10-24。关联 PRD 1.1.121、B18/B29/B32、C01/C02/C07。
当前为实施规格，未通过测试的行为不计交付，本机日用仍固定187。

## 产品行为

先保存五工具草稿，再预览并明确向另一已有创意项目追加副本。源可以是个人未关联工作区。
目标已有画布、提示词、素材、图片/视频草稿及历史保留，源文档、原件和不可变历史不改写。
撤销栈和独立 Agent 面板内存会话当前不在服务端，不能声称复制了这些资料。
复用固定 Infinite Canvas 数据结构、localforage、Studio 服务及私有资产；不编辑 vendor，不启用真实付费或普通 Worker。

## 固定契约

本人 workspace/invoke 新增 documentTransferVersion:1。RPC 为 document.preview、document.prepare、document.commit、document.lookup、document.cancel。
document.requests 为只读原请求索引，按本人source、UUIDv7游标和最多50条分页，返回items/nextCursor/unavailableOnPage。
关闭标签或重新登录没有本地指针时，从服务端恢复精确原请求并只读lookup，不自动准备、执行或换编号。
逐项核当前源、目标及资产读取权；不可读项只计本页数量，不返回目标、文件或回执详情。最近一页不能充当访问控制。
preview 输入 scope、targetScope；输出 version/sourceScope/targetScope/manifestHash/counts/excluded。
prepare/commit/lookup/cancel 共享完整原输入 scope、targetScope、requestId、manifestHash。
prepare 只固定原请求和清单，commit 明确确认后追加，lookup 只读返回 missing/prepared/committed/cancelled。
cancel 是本人显式取消准备，与提交互斥；取消后原请求终态不可执行，已提交则返回原回执而不撤销副本。
未知结果仍只读核对，只有已核实 cancelled/committed 后才允许明确建立新请求。
原请求和回执位于 Studio 自有表，tenant/owner/requestId 唯一；相同原键输入返回原结果，换输入冲突。
丢响应后不自动 POST，不换 requestId。原请求和清单出生后不可变，回执只能从空变为一次完整结果。

清单读取本人所有创作条目及删除标记，完整稳定媒体引用、原件版本/域/来源/期限/SHA/MIME/字节数和目标全部版本。
不得用500条展示目录代替完整读取；超限明确阻断，不静默截断。全部条目写入共用 scope 锁，双 scope 固定顺序上锁，防止新 key 插入。
源、目标、原件变化后重新预览；最终追加和回执在同一租户事务。媒体复用不可变资产，不改变拥有者、来源、期限或审核事实。
复制前验证私有对象存在和原元数据，I/O 后复查当前权限及所有版本。历史回执不要求当前编辑条目仍停在旧版本。
每次读取仍核当前本人、源/目标对象权限及原件资格，其他成员或租户不能认领请求。

## 原生文档与历史

canvas_store 保留节点、连接、分组、聊天及引用、viewport、背景和显示设置；asset_store 保留媒体及 kind:text 提示词正文、标题、标签、备注和来源。
新增 image_draft/video_draft 存储未提交输入，采用 version:1、drafts 数组和 activeId。复制时保留目标 activeId，源草稿追加供显式选择。
图片/视频日志复制为不可执行来源历史，原 status/taskId 保留为事实。复制的节点和日志附 _yummyaiOrigin、executionFrozen:true，适配层禁止它们恢复或轮询原任务。
生成执行、模型凭据、插件配置、送审意图、批准及生产状态留原 scope。不能借历史副本续跑原任务。
原生项目/节点/素材/日志 ID 和媒体 key 按类型化映射追加，含固定字段中的裸 key；普通文字中碰巧出现的旧 ID/key 不替换。
旧内嵌 data URI 原字节保留；无法解析的 blob/远端引用、损坏文档或未知协议明确阻断。源删除墓碑不作用于目标。

## 分工与验收

主控维护契约、schema/迁移、事务拥有者、传输接线、整合及最终验收；后端子 Agent 负责原生文档纯函数清单和追加；前端子 Agent 负责持久草稿、保存屏障、冻结及确认恢复；测试子 Agent 负责隔离验收与审查。
不并发写共享契约、schema、状态、构建输出和日用目录。
验收包含完整文档/媒体、非空目标冲突 ID、源/目标变更、新 key 并发、I/O 后撤权、成员/租户隔离、同键并发、排除操作意图及缺失引用原子失败。
真实1440/390页面核五工具及刷新、源/目标互不串写、实际丢响应后的只读恢复。
测试用独立库/桶/Redis和输出，核验后清理本批资源及raw，保留源码和简要结论。
日用切换另需同源候选、备份恢复和真实187升级演练，不用规格或单元绿灯代替。

本批恢复页另需固定浏览器工具链。旧 Chromium149 与 Edge156 已在无路由的合成响应中复现 no-store 有界 reader 读到 EOF 后外层仍报取消；原 R3 恢复叶继续按失败保留，不能把未知取消放行，也不取消 no-store、字节上限或截断/撤销检查。
候选工具链单独保存在本机 `.artifacts/toolchains`，官方包固定版本与完整性，浏览器完整安装文件清单和锁文件均固定摘要，不改变项目 pnpm 依赖或日用浏览器。验收入口在创建任何输出、库、桶或 Redis 前核本批锁，Playwright 配置和合成探针再次核同一锁；不接受任意路径、远程浏览器环境覆盖或自动回退。
必须先通过同一可执行文件的正常、主动取消、超限及真实截断对照，再在重新冻结的同源 Web/API 候选上运行完整两叶严格门。新工具链下载成功不计验收。本批 runner 的结果 manifest 也放入同一独占输出叶，便于完成后逐项清理。

## 188 本机采用与中断恢复

R4同源双叶、12实际页面和新308 raw独立清理已通过，完整源码3994项与编译候选已配对；实际采用状态另看项目状态及操作journal，不从本段推断已升级。
采用先固定原187配置、29份旧备份及14条不可变schema receipt逐复合主键/完整行摘要，再精确停写、新建业务备份和完整恢复/188升级彩排。彩排两个库和桶另行独立查无后才能调用真实apply。
apply调用前持久化尝试标记。即使函数报错或normalDatabaseMigrated仍false，迁移事务也可能已经提交；保持停机核真实库，禁止自动恢复187应用绑定或旧业务库。升级后其余原表逐项不变，旧receipt逐行保全，新增188记录只接受原backup/source/canonical/actual/schema精确组合，并由非owner yummyai_app重新通过readiness。
两个应用配置指针写入前固定完整next-binding原文及current/state摘要、Studio pin和本批qualified pair。仅已有pass apply和已封存next-binding的配对提交中断，可用本批协调器--finish-binding续配；未知内容拒绝覆盖。apply失败、Studio采用前中断仍需主控根据journal与真实库继续核验，不能声称一键自动覆盖所有失败阶段。
R4采用时的ordinary startup gate只串行API/Web，Studio up仍在gate外；该次维护由主控独占串行，并在部署后/指针提交前复查精确Studio指针和live baseline。当时未证明任意并发daily:start互斥。后续PRD1.1.122已另行冻结并验证根维护工具的[共享协调门](runtime-startup-serialization.md)，覆盖支持的daily/Studio/容器/镜像维护入口；原R4应用快照与采用执行SHA保持，未悄改已验源或重放迁移。

2026-10-24实际采用结果：上述187备份/全恢复彩排及188 apply通过，普通库已188；固定配对API/Web日用健康，原业务事实和私有对象保全。状态与[本人页面走查](../project-control/checkpoints/2026-10-24-studio-transfer-d8b42e71-personal-smoke-r4.json)分别记录采用、实际查看范围与未完成范围。后续按daily:status/start使用当前版本，不能根据较早历史段落再次执行升级或恢复187应用。
