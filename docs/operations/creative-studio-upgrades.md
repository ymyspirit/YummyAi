# 创意工作台的固定升级与恢复

ERP与Infinite Canvas独立构建和运行。上游源码固定在`packages/canvas-runtime/upstream.lock.json`；P2继续使用官方v0.20.0的184个未修改vendor文件，ERP adapter升级为2.8.0。外层报价、恢复和送审页面复用已有React组件；没有把上游工程改成不可升级的ERP分叉。

## 发布门

候选必须是干净Git提交，通过对应完整CI和相关隔离验收。数据库只前向追加0190、0191、0192，既有0—189迁移SQL字节及journal前缀保持。API、Web、Worker使用同一份新共享契约；Studio也须按该契约重新固定构建，不能把旧2.7二进制当作新协议验收。

使用既有`build:web:candidate`固定ERP；用`build-canvas-runtime.mjs`及`studio-runtime-artifact.mjs`固定Studio。独立快照的依赖用指定Node/pnpm冻结安装，原生ImageMagick运行包按runtime-lock逐文件核验。禁止复制另一个快照的node_modules或.next作为新构建。

日用Studio保持Docker项目组`yummyai`中的独立runtime和entry容器。新静态产物经自有清单校验、无网络Docker构建及prepare后，维护窗口通过既有Studio部署器采用。ERP的日用manifest同时固定新Studio bundle ID与实际current记录SHA；deployment ID和current文件SHA分别记录，不能混用。

## 备份和切换

切换前保留健康日用进程，准备候选、CI原始发布包、编译页面结论、测试资源查无及精确进程身份。只有最后维护窗口才持有统一startup gate、排空原报告消费者并停止原API/Web；不扩大执行策略，不中断其它服务或账户。

在候选快照内使用canonical备份与database-upgrade流程：新鲜完整数据库及私有对象备份 → 完整恢复到一次性数据库和桶 → 在副本重演189到192升级 → 核对原业务、权限、历史和私有对象逐值保全 → 对静止日用应用已重演迁移。验证资源随流程清理。

升级后采用新Studio，读取实际current SHA，再原子安装同一配对的ERP manifest和启动固定API/Web。仅重新准入经核验的订单报告两个队列，无scheduler；真实付费及普通全队列Worker继续关闭。最终用原运营账户重新读取真实页面，核对既有订单、规格、权限、未审核底稿和原预览状态。

## 故障恢复

迁移尚未执行时可以恢复原189应用与原Studio配对。迁移已经执行时，保留真实数据库和对象，恢复已核验的同一192候选及对应Studio配对，继续完成canonical升级证明与后置核对。应用启动失败不能自动把旧业务备份覆盖回日用库；恢复可访问性也不等于完成业务验收。

正常日用使用`pnpm daily:status`和`pnpm daily:start`；Studio使用已有status/start/recover命令。遇到未完成部署transition先核对原意图并按明确恢复路径处理，不能改current或跳过校验使健康探针变绿。

本地P2编译验收保留原Windows浏览器完整payload锁。Linux CI另使用本仓库固定Playwright 1.61.1及官方headless-shell 1228/149.0.7827.55，核对registry、真实可执行版本和二进制SHA，并独立标注现场SHA观察，不伪装Windows锁。两者均通过同一固定ERP候选、隔离个人OIDC与真实原件路径测试；验收关闭后清理自有原始输出，保留简明结论和校验记录。
