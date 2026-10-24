# 广告工作台的当前身份与账户权限

2026-10-21，操作 `7bd4a2c9`。本文件描述当前实现边界；实际验证及尚未完成部分见[本批进度](../project-control/ADVERTISING_AUTHORITY_PROGRESS_20261021.md)。普通数据库仍为 148，当前源码未被普通环境采用。

## 复用与职责

沿用已有 AdvertisingService、私有来源网关、PostgreSQL 强制 RLS、Zod、个人 OIDC、React 和 Lucide，不新增运行框架或依赖。[既有工作台](advertising-workbench.md)保留原始 CSV、事实、目标、分析和导出版本。开源参考继续为 [IvyeaOps](https://github.com/Hector-xue/IvyeaOps)，参考业务组织方式，不复制或执行其代码，不把其默认阈值作为本平台政策。

主 Agent 负责共享契约、Storage、BFF、隔离 runner、整合与验收；子 Agent 分别负责 API 拥有者、广告界面、测试与独立审查。所有既有修改、已交付包、原普通运行源码、八份真实业务备份和历史冻结路径保持。

## 操作权限

| 操作 | 独立权限 | 返回范围 |
| --- | --- | --- |
| workspace | Read、Write、Review 任一 | 可操作账户；仅具有对应账户 Read 时返回私有历史数组 |
| facts、原 CSV、已封存 JSON/CSV 下载 | Read | 该账户的事实或原 ID 指向的原始记录 |
| 预览、导入、经营/排名观察、来源归档 | Write | 本次操作的实际回执，不授予任意历史读取 |
| 目标版本、分析、动作登记、封存审核包 | Review | 本次操作的实际回执，不暗含 Read 或 Write |

`marketplace_accounts.created_by` 是账户的可信归属根。每项权限按自己的 data scope 核验；同一个人的租户级 Read 不能扩大其 self Write 或 self Review。self 可以操作本人创建的账户。旧账户没有固定的 team 归属，team 范围也只能到本人账户；不以拥有者今天所属团队推导历史访问权。归属为空的账户需要该项租户权限。

每次业务事务都重新读取当前有效 membership、角色和团队，并与入站请求的权限上限取交集。直接调用 service、重放旧请求和权限撤销后的下载均经过同一拥有者检查。数据库仍使用非拥有者应用角色及 `withTenant()`，不绕过 RLS。

## 身份与响应契约

workspace 显式返回所请求的 `accountId`、`contextAuthority`、当前成员权限和逐账户权限。事实页也返回账户和身份版本，并拒绝重复 ID、超过页大小及串账户的行。`contextAuthority` 采用现有 `erpSessionAuthority()` 生成的规范 JSON；它用于绑定页面状态，不是凭据或文件 SHA。来源、目标和分析校验值继续使用原来的 SHA-256。

生产 BFF 使用现有 `apiFetch()` 的个人 OIDC，不再因 production 模式一律返回 503。服务账户的生产禁用规则由原身份层继续执行。BFF 拒绝重复或未知 query、非同源写入和非法 UTF-8；按共享 schema 检查响应，并核对账户、分页、原文件、测量设置、目标版本及本次操作范围。文件字节按上限拒绝，不截断后冒充完整内容。附件名由受控 UUID 生成；错误正文仅允许已知 `authority_changed` 标记，均为私有且不缓存。

## 私有 I/O 与事务

CSV 扫描前、真实上传前、上传后和最终入库时重核当前权限及账户。成员或账户锁不跨扫描和对象存储 I/O。失败时只清理本次实际上传回执且数据库尚未引用的精确 tenant/domain/SHA/importId.csv 对象；清理沿用原 Write，不要求额外 Read，也不允许删除任意已提交来源。

原 CSV 读取在 I/O 前后分别检查当前 Read、账户和原 import 固定依据，字节数上限 5 MiB，SHA 不符或对象缺失明确失败。旧来源归档和账户删除不伪造或重写历史；原 ID 读取仍按当前权限和原有历史规则处理。

旧 `/v1/customer-intelligence/advertising-reports` JSON 路径同样重核当前 Write 和实际账户归属；无账户记录仅允许租户 Write。报表、行、审计和返回原视图在同一事务，审计故障全部回滚。混合 VOC 工作区无统一可信的逐对象 owner/team 绑定，故要求当前租户级 Read；本批未把其他 VOC 写入、分析或推荐拥有者标成已完成重构。

## 页面与恢复

广告请求按个人身份、权限版本、账户、对象与请求代次绑定。切换账户、身份或权限后清理旧私有页面、预览、表单和详情，拒收迟到响应。401、403 和已知权限版本变化会触发已有会话复核。读、写、审核控件按逐账户能力显示。

同一未确认写入保留原正文、原时间和原幂等键重试；已取得成功回执与随后列表刷新失败分别呈现。这里不承诺跨会话持久恢复，也不以断网证明服务端没有提交。现有近期列表和已读取分析版本明确标示范围，不伪称完整历史；完整历史分页及按 ID 恢复仍待补。

## 测量口径与剩余工作

本批保持原解析、金额、归因和诊断算法，不把权限测试当成它们的完整验收。已发现并保留下一批工作：带 Targeting 的 Search term 报表分类歧义；7/14 天及不同归因指标定义的独立版本；金额精度与固定货币依据；完整历史读取；归档后的历史截止回放；Review-only 对原动作的完整恢复。

亚马逊[2026-01-01 官方更新](https://advertising.amazon.com/resources/whats-new/view-attribution-updates-for-amazon-store-ads/)区分特定 SB/SD vCPM 的新浏览归因与 all views，点击归因保持原规则。由此推导：仅有 `click_and_view` 和一个天数不能证明两份报告属于相同指标定义，未来适配需固定实际列与版本，不能对所有广告类型统一套用新窗口。

## 定向验收入口

使用受控 runner 的 `--suite=advertising-authority-integration` 或 `--suite=advertising-authority-browser --compiled-web --candidate=<实际封存ID>`。浏览器继承 3130/8130 的个人身份隔离链。新 integration config 在任何连接前拒绝缺失 flag、非一次性数据库、旧 schema target 或不匹配的私有桶。普通单测排除 integration 文件；禁止直接对普通数据库运行这些夹具。

本批不启动普通应用、不消费旧任务、不调用真实广告写接口或模型，不声称已经发布、用户业务验收或完整 R34 完成。浏览器、数据库、私有桶、Redis、构建副本和原始验收输出在检查后按[交付约定](../project-control/DELIVERY_PROTOCOL.md)清理，保留源码、必要结论和清理记录。

本批技术结论：123项单元/规则、46项去重隔离集成及最终同编译3条个人会话通过，四张桌面/手机截图已实际查看；输出与5组资源清理后独立复核。登录回跳只在广告路径保留共享Schema验证的账户、日期等筛选；外部URL导航在渲染阶段先隔离旧账户，再同步查询，内部URL写回不触发重复清空。普通148仍未采用，真人业务、完整测量和执行未验收。
