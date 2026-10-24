# 工厂日历与共享产能

PRD1.1.73，本批定向技术验证和自有清理完成；完整工厂业务与实际部分停单数量凭证继续。每厂最多200个稳定池，服务与SQL在同一factory锁下限制新建；满额仍可精确恢复原创建回执和读取全部池，归档不抹去历史身份。

本批 a64d29f1 实施 B34/B35 的有限产能预约，验收与清理见[本批进度](../project-control/FACTORY_CAPACITY_PROGRESS_20261021.md)。完整工厂业务、实际部分停单数量释放及普通环境采用仍要继续。工厂原 `dailyCapacity` 和自由文本工作时间保持研究参考，不自动转为已确认事实。

## 资源池与固定版本

一个池表示一家具体工厂的共享资源。稳定身份保存编码、工厂、创建时工厂版本、IANA 时区及 `each|minute` 单位；单位和时区不能通过修订改变。多个能力版本可使用同一个池，不能按能力重复授予物理额度。

不可变 profile 版本保存名称、状态、明确每日额度（未知为 null）、七个当地星期的工作区间、日期例外、当地截单时刻、精确能力版本与每件整数用量，以及真实产能依据。启用需要额度、至少一项绑定及足够依据。闭厂例外必须零额度；工作区间不重叠，跨日须拆开，终点允许 `24:00`。

绑定可以引用本工厂实际存在的历史能力版本。补做沿原生产固定来源，不以当前下拉选择替换旧能力。配置接口验证实际归属；页面另允许显式输入已从历史核对的版本 ID。

当前 `active` 和 `paused` 的精确能力绑定共同组成必需池集合；暂停池仍是必需资源并阻新预约。draft、archived 不参与新必需集合。没有已确认绑定时拒绝新预约。修订不清除旧版本预约；显示的当前日历不会冒充旧生产原日历。

## 明确日期与预览

生产输入的 `capacityPlan.allocations` 明确每个池 ID、池版本 ID 和当地生产日期，每池只能一次，最多32池。调用者不传占用额；占用额按实际生产版本数量乘该池固定能力版本的每件用量计算，上限十亿单位。

预计完工时间是完成截止时刻，不能隐式充当工作日期。三个下达和三个补做入口分别选择日期，并通过服务端按原工厂版本时区解析当地完工时刻；浏览器自身时区不参与转换。工作日的最后工作区间不得晚于完工截止。

预览只读。整单在一个请求中聚合同池同日的全部商品需求；例如总额度10、两项各6，合计12须阻止。正式提交在原生产 owner 事务内再次读取当前依据和余额，预览成功不保留额度。

日期限2000—2099。应用使用开源 `@js-temporal/polyfill@0.5.1`，显式拒绝不存在或重复的当地时刻；午休、日期例外、23/25小时日和截单均按实际 UTC 区间核算。数据库独立核对 minute 精度的唯一当地时间映射，不采用 PostgreSQL 默认的夏令时选边和自动修正。`24:00` 解析为下一当地日零时。

## 余额与生命周期

池/日余额跨全部 profile 版本汇总：

- 原总预留 `allocatedUnits` 包括后来已释放的预约
- 净占用 = 原总预留 − 已释放
- 基础可用 = max(0, 当前已确认额度 − 净占用)
- 已承诺属于净占用，不额外扣一次，也不表示实际已制成件数
- minute 池额度不得超过当日实际工作分钟；当天可用还受剩余实际工作分钟减未承诺、未释放预约限制

真实新生产版本、每个预约、首个 reserve 事件及成功审计原子提交。实际 `started` 里程碑在同一事务追加 commit；真实 `cancelled` 且从未 commit 才可一次全额 release。取消申请、失败、完成和已开工后的取消均不自动退还原占用。开工时间偏离原计划会保留真实事件，不静默搬移原预约日期。

本批尚无已生产/未开工部分数量的独立停止凭证，不能按全批状态、单个交运包或人工比例退还部分承诺。下一步需把实际数量证据、审核与后续可分配量在原生产/质量/交运 owner 内闭合。

旧生产保持 `legacy_unreserved`，不回填预约或出生证明。同工厂未终结的无账本生产无法排除占用时，未来预约也阻止；当天创建、更新或记录终结的旧生产会让当天未计量耗用保持未知，后续日期再按实际事实核对。

## 事务、权限与存储

0159 增加五表：`factory_capacity_pools`、`factory_capacity_versions`、`factory_capacity_reservations`、`factory_capacity_events`、`factory_capacity_owner_proofs`。全部 forced RLS；版本、预约、事件和 owner 证明不可更新/删除。证明由实际 production version/milestone INSERT 触发器铸造，应用仅 SELECT，不按历史时间补造。

每个公共读/写在 `withTenant()` 的非所有者角色下重核当前成员与请求上限，读取需要租户级 `order:read`，配置需要租户级 `order:write`，逐项范围独立判断。配置写返回原池版本回执，不伪造额外读取授权。生命周期 helper 沿原 ERP 或具体工厂 assignment owner 已作出的授权执行，不另加宽泛 ERP 写权限，避免拒绝合法工厂反馈。

按既有 membership/production owner 锁，再 factory、排序后的全部 pool、排序后的 pool/day 取 advisory 锁。factory 锁使用原目录的 `hashtext('factory:'+id)`，不能改成另一把64位散列锁。余额和当前数据库时钟在锁后读取。配置 raw 写同样取锁，工厂根 `FOR SHARE` 阻止校验后改版；头指针与真实最新版本终态双向闭合。

SQL另验证规范原文哈希、严格 JSON 形状与字符串、池/生产实际父关系、当前固定版本、真实完整事务 ID、日历、截单、分钟余额、旧未知占用、实际里程碑、事件顺序及一次全额守恒。新生产必须在出生事务完整预约当前全部必需池；配置变化会重验该事务已出生生产，提前 flush 约束也不能隐藏后来新增必需池。

原生产、整单与补做 owner 保留原幂等键及原文 checksum。输入方案在传输层 optional 只为读取和恢复旧原回执；新写缺方案仍拒绝。旧 raw 成功回执和原 command 回执可恢复，旧尚未执行原文不能被补造成已预约的新生产。

## 接口

API 根为 `/v1/sourcing`，共享契约出口为 `@yummyai/contracts/suppliers/factory-capacity`。

| 方法与路径 | 用途 |
| --- | --- |
| GET `factories/:factoryId/capacity` | 默认14天、最多31天的当前池及当地日历，可按固定能力版本过滤 |
| POST `factories/:factoryId/capacity-pools` | 原键创建池与首个不可变版本 |
| POST `factories/:factoryId/capacity-pools/:poolId/revisions` | expectedVersion 修订，保留全部旧预约 |
| GET `factories/:factoryId/capacity-pools/:poolId/history` | 精确原池全部版本 |
| POST `factories/:factoryId/capacity-preview` | 整批只读聚合核算 |
| POST `factories/:factoryId/capacity/resolve-time` | 按实际固定工厂版本解析当地时刻 |
| GET `production-orders/:productionOrderId/capacity` | 原生产预约与累计承诺/释放，或明确旧无账本 |

个人 BFF `/api/factory-capacity/[...path]` 仅转发白名单。读结果绑定身份权限戳；写回执绑定原工厂、池、版本、profile及原输入，I/O前后复核个人身份。POST核同源，完整请求上限256KiB、上游结果8MiB。识别已知 `409 authority_changed` 并立即清除私有旧状态，不回显上游正文、密钥或调用者提供的tenant头。

配置响应未知时保留本页原正文与原键，刷新读取不卸载未核对副本；同键重试不代表跨浏览器会话恢复。历史关闭/切换与请求序号、abort绑定，迟到结果不重新打开。页面沿用 ERP、Lucide、既有对话框及动效规范。

整单重读通过稳定 token 同时刷新各商品的制造依据。原组件保留，只有实际来源、权限或可选版本失效时清除原确认。制造单位确认和数量变化会作废旧产能预览，提交前需重新核对。

本批浏览器日志还定位到原私有来源读取的并发锁序隐患。`OrderWorkspaceService.currentSource` 在同一个原授权事务内先按真实订单子项锁父 `orders FOR SHARE`，再执行原子项/订单锁与全部隐私和版本检查，与发货父先子后的顺序保持一致。确定性集成检查使用实际父锁等待屏障，并覆盖原版本、文件、PII与租户隔离。

## 隔离验收与运维

当前 API 使用 `--suite=factory-capacity-integration`；真实158升级使用独立 `--suite=factory-capacity-upgrade-integration`、`pre-0159` 和逐文件固定的旧158源；浏览器使用 `--suite=factory-capacity-browser --compiled-web --candidate <ID>`。各配置先拒绝缺隔离标记、非一次性库或不匹配私有桶，再连接数据库。

浏览器为合成个人 OIDC、Web3130与独立临时回环 API。普通148及固定普通运行源不采用159；不重试此前被自动审批拒绝的普通 Web 启动。验后独立核实一次性数据库、私有桶、Redis和临时文件清除，保留真实备份、冻结路径与精简验证记录。

参考：[ERPNext有限产能](https://docs.frappe.io/erpnext/capacity-planning)、[Temporal开源实现](https://github.com/js-temporal/temporal-polyfill)、[当地时间歧义](https://tc39.es/proposal-temporal/docs/zoneddatetime.html)、[PostgreSQL默认歧义处理](https://www.postgresql.org/docs/17/datetime-invalid-input.html)。
