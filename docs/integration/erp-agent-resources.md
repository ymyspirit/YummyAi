# ERP 原业务资源读取

当前扩展：PRD1.1.96已将六类资源接入独立内置native-v2，同任务十一类读取经本批局部验证；旧native-v1保持原协议。见[版本化内置Agent](erp-agent-native-v2.md)。下方保留资源切片当时状态。

2026-10-22 · `erp-agent-resources-v1` · 8d6f2a19 · 本批局部技术验证与自有清理通过

此接入扩展整个 ERP 的 Agent 业务范围。它复用原业务 owner，不建立第二套商品、订单、财务或广告事实，不修改旧 read/tools/native/loop/plan v1 的 pin、历史请求或摘要。实现和通过证据分别记录，以[专项进度](../project-control/ERP_AGENT_RESOURCES_PROGRESS_20261022.md)为准。

## 六类原事实

| 资源 | 固定输入与读取范围 |
| --- | --- |
| research.evidence | 原研究对象、所选 capture snapshot、明确的研究结论 revision 或 null；保留原公开事实、缺失诊断及研究来源，排除媒体下载和评论正文 |
| catalog.sku | 原 SKU 与明确配方或原当前配方；返回规格事实、制作映射、原配方状态和有权限的封存包版本；不返回素材字节或渠道连接 |
| listing.version | 原 Listing 与明确的原版本；返回该版文案、属性、媒体标识与原规则检查；不根据今天的主版本替换历史 |
| orders.order | 原订单与预期事件序列；返回状态、数量、金额和币种；保留原业务订单/行号和Listing标识，不返回收件人或地址正文 |
| finance.profit_run | 原利润计算 ID；保留原 minor money、口径、贡献和缺项，不重新求利润或补零 |
| advertising.analysis | 当前受权原账户与原分析 ID；保留原测量版本、来源 pin、币种与结果，不执行广告操作 |

所有输入和输出使用[共享严格契约](../../packages/contracts/src/ai/agent-resources.ts)。没有原主图的合法定制配方保留 null。研究 studyRevisionId 为 null 时 content 必须为 null、studyVersion 为 0，不能自动补今天的研究结论。研究规范 URL 与原采集 URL 分别保留，不能用字符串相等代替对象版本关联。

## 原 owner、身份与边界

服务先交叉核对当前成员与调用者原权限上限，按每项 permission scope 检查能力，再由原 owner 校验具体对象。候选列表与详情同样受权；原调用结束后再次核对当前身份，变化时丢弃私文。返回前还通过原 owner 再读同一对象或同一候选查询，避免对象被移出团队但成员权限未变时返回旧资料。对象摘要变化返回 `agent_resources_source_changed`；候选比较原条目与 coverage，不比较可变的 opaque cursor，始终保留第一份原游标。两次读取及身份复核共用 30 秒期限，到期丢弃结果，不表示中止原数据库查询。API Client 不借新通道取得本人权限。新接口不需要原 Assist 的模型运行或业务写权限。

资源采用独立 Harness 注册和执行 pin。所选 definition 的摘要绑定原严格输入/输出 Schema、效果、owner 和限制；input 摘要绑定版本、资源及完整所选输入；data 摘要绑定原投影、所选输入、来源和 coverage。Web BFF、浏览器与 MCP 使用同一[纯校验器](../../packages/contracts/src/ai/agent-resource-transport.ts)。这验证结构与原对象关系，不证明商业因果或建议最优。

API 为本人认证的 `/v1/agent-resources/workspace`（GET）及 `definition`、`candidates`、`call`（POST）。后面三项只是查询，不准备或执行业务。Web 使用同源 `/api/agent-resources/`；禁止任意上游 URL、SQL、租户或文件路径。响应有界且不缓存，失败只返回安全诊断。

## 真实对象选择和范围

工作台从原 owner 的真实候选选择对象及版本，不要求操作者手填 UUID。候选查询按资源有不同严格分支：研究关键词；SKU/Listing 原分页；订单原状态/平台筛选；财务原近期窗口；广告先选受权账户，再沿原分析历史游标读取。

候选一律标注 `bounded_candidates / complete=false`，不能把一页、近期窗口或旧游标当全集。研究旧时间游标存在同时间戳漏读边界，本接入口只使用有界搜索，不通过循环旧游标声称全量。对象读取为 `single_object_projection / complete=false`，表示一个原对象的已声明字段投影，不能冒充该领域、所有历史或完整源对象。

当前页面的研究选择使用原最新 snapshot，且不自动加载研究结论。API/MCP 可明确传入旧 snapshot 和 study revision；页面的专用研究历史选择器仍待补齐。旧原生模型循环继续原五工具，未因新资源注册自动扩大工具范围。

物流的原 GET 含到期清文维护，不在本协议中伪装为纯读；物流、采购等其余原操作与 Agent 原生循环的进一步接入继续。

## MCP 的显式扩展

继续原五个公开 MCP 入口，旧 MCP v1 共享契约不改。可信启动参数 `--allow-resource=<上述资源 key>` 逐项允许；省略时仍为原 49 项目录和原五读取，不新增可调用范围。付费模型及原业务准备仍按原启动策略控制。

允许后 `erp_tool_schema` 接受独立 `resource/<key>` 定义分支，返回原资源 definition、独立 executionContract、所选完整 call Schema 及候选请求 Schema。`erp_execute` 继续 `operation=read`，requestJson 承载新 ResourceCall；候选请求是 `{version:"erp-agent-resources-v1",kind:"candidates",query:<严格查询>}`。客户端必须保留 coverage、来源、所有摘要和当前身份。

本批同时补齐原读取 definition 的 executionContract，以及 native/start 的原可选模型、限制和执行 pin，供实际客户端从 MCP 入口组装请求。仅服务器测试或从测试夹具补 pin 不算客户端接通。

## 验收与恢复

专用 disposable runner 提供 `agent-resources-integration` 和 `agent-resources-browser --compiled-web --candidate=<源码一致候选>`。配置在连接前校验资源/MCP及所有继承隔离旗标、current175、同 nonce 数据库、私有桶和 Redis。只加载本批专用测试，不混入写死174的旧工具测试，不放宽旧升级或隔离门。

正常、空、失权、迟到身份变化、对象/版本互换、摘要篡改、精确金额/单位、原历史与零新增业务执行均需实际验证。MCP 用官方 SDK，调用 pin 和 Schema 必须从 MCP 入口发现；浏览器用本人实际会话及编译页面。全部本批临时输出、截图、候选和隔离资源验后清理，旧885冻结路径及两份拒绝报告不重试。

实际用户宿主配置、远程授权、真实模型质量与账单、日常148配套升级、其余领域及全平台业务验收仍未完成。原普通 Web 启动审批拒绝边界保持。

本批结果：23项去重功能检查和4组隔离配置检查通过。初次夹具导入失败不计覆盖；次轮6组通过，修正两处测试预期后只补跑2组，生产字节相等证明保留。编译本人页面2条及1440/390目视检查通过。6个自有目标、2670文件、877944523字节及3个仅链接已清，4组隔离资源前后独立查无。旧885冻结路径及两份历史策略拒绝报告保持。详见[验收结论](../project-control/checkpoints/2026-10-22-agent-resources-8d6f2a19-evidence.json)和[清理后审计](../project-control/checkpoints/2026-10-22-agent-resources-8d6f2a19-resource-audit-after.json)。
