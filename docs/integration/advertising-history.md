# 广告完整历史与原 ID 读取

2026-10-21，操作b7e49a2f，PRD1.1.70。本批144项定向技术检查和自有清理已通过，完整业务继续。普通148与六应用保持停止。复用现有RLS、AdvertisingService和原结果，并参考[IvyeaOps](https://github.com/Hector-xue/IvyeaOps)、[shadcn分页](https://ui.shadcn.com/docs/components/base/pagination)及现有财务台账游标交互，不新增依赖。

`GET /v1/advertising/history`必填accountId和kind，pageSize默认25、上限100，事件另需parentId。`GET /v1/advertising/records/:id`按同账户、类型及父对象独立取原记录，不先扫描近期数组。正式契约为`@yummyai/contracts/advertising/history`。类型为imports、goals、observations、analyses、actions、exports、action_events和import_events。

列表只读摘要，按原UUID降序、固定创建截止和上界逐页读取。截止保留数据库微秒原串，避免JS Date截断导致漏页；返回真实count、上界、原请求游标、下一游标和hasMore。游标绑定租户、本人、当前权限、账户、类型、父对象及页长，并核对当前可读的真实锚点；游标不授予权限。跨请求不是一个MVCC事务，动作状态是本次读取的当前投影。

当前账户Read可读账户历史。无Read时，Write仅恢复本人导入/观察和本人来源的归档事件；Review仅恢复本人目标/分析/动作/封存及本人动作事件，动作与封存还要核验本人原分析。其他人的记录不能通过猜ID恢复。事件归属指受权父对象，可以包含同事处理记录，不按事件作者丢弃历史。归档记录及已删除账户沿既有精确核权规则保留；CSV原文和既有附件入口仍独立要求Read。

原分析读保存JSON，不重新分析或补当前测量依据；原封存读保存payload，不用今日动作替换。同账户重分析可以按同推荐key复用旧动作，不把原runId改成新分析。事件输出白名单，不透出raw.data、请求键、对象坐标或内部凭据。

工作区是明确的近期预览：导入/目标/观察/动作最多200，分析10，historyWindow注明loaded/limit/hasMore。动作预览events为空且eventsComplete=false，须独立读取原动作后续办；原动作详情保留完整事件，也提供事件分页。续办观察期窄读原目标，只披露所需窗口和最早复盘时间；缺目标时明确原服务历史默认7天，不冒充保存规则。当前目标优先版本号，创建时间回拨不改变版本。

原单对象超过既有32MiB上限会明确失败，不截断冒充完整；超大事件仍可逐页读取。本批恢复已登记结果和当前修订；跨会话尚未送达的原写正文需要后续持久命令实现。

专项advertising-history-integration / advertising-history-browser须专用flag和同nonce一次性数据库/私有桶/Redis，浏览器为个人OIDC 3130/8130。缺隔离或目标不符在连接前拒绝。验收后清理本批输出及资源，完整业务、普通采用与平台准出另验。

本批实际通过122单元/规则、20去重隔离集成及同编译2条个人OIDC浏览器。201导入/超10分析、三类各超10000行、同刻与微秒游标、原目标修订/30天、本人Write/Review及跨账户父对象均有运行证据；事件白名单和封存一致性由严格契约复验。真实已读对象在范围收窄后404、撤权403或迟到切账户均清除旧投影。丢201后的原正文/键重试只有1事件；这不是未送达正文跨会话持久恢复。1440/390三截图实际查看，未执行减少动态效果专门场景。

首两次浏览器均未开始测试：外部xray Bound socket占8130；临时端口配置首次缺ES模块作用域。只修正隔离API端口和临时type:module，最终原同编译2条通过，不改断言/超时、不触碰外部进程。5组一次性DB/私有桶/Redis删除前后独立查无，临时配置/日志/截图/trace/构建已清，ClamAV恢复原停止。
