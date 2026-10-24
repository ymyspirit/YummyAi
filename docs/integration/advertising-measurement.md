# 广告报表测量版本

2026-10-21，操作 `c8e71f42`。本批182项定向技术检查与自有清理通过；这不代表完整广告或平台业务验收。当前进度见[测量进度](../project-control/ADVERTISING_MEASUREMENT_PROGRESS_20261021.md)。普通库仍为148，六应用停止，新源码未普通采用。

继续复用现有 AdvertisingService、强制RLS、来源网关、Zod和[既有开源参考 IvyeaOps](https://github.com/Hector-xue/IvyeaOps)。金额精度沿用仓库固定ISO快照，不增加框架、依赖或另一张可变货币表。

## 实际指标列

搜索词与投放目标是两个维度。含 Customer Search Term 的普通搜索词报告不能因为也有 Targeting 就变成投放汇总。来源保留所有原列和单元格，不能把目标词替代实际搜索词。

逐文件固定 impressions、clicks、purchases、spendMinor、salesMinor、bidMinor 的实际原列名。预览列出候选；歧义需要明确选原列后才能参与转化决策；未确认可仅保存原始证据，修改后重做预览。7天购买与14天销售不能拼成一组；泛用列、默认别名顺序或空单元格不能成为偷偷改用另一指标的理由。显式冲突不能用 allowPartial 绕过。

## 定义与来源

新 conversionDefinition 是操作者对报告设置及指标定义的具名核对依据，不是ERP向Amazon验真的凭据。`click`、`legacy_click_and_view`、`shopping_signal_2026`、`all_views_14d` 和 `unknown` 分开。旧批次的天数与 click_and_view 标签不能代替新定义。

[Amazon 2026-01-01公告](https://advertising.amazon.com/resources/whats-new/view-attribution-updates-for-amazon-store-ads/)只对特定SB/SD vCPM及Amazon Store库存更新浏览归因；点击规则未变，all views另保留14天，新模型不能由日期或广告名猜出统一窗口。[SP搜索词列定义](https://advertising.amazon.com/help/G3HEFZYWZF84NPS9)同时存在seller的7天与vendor的14天口径。因此不能因文件名SP就替报告选择7天，也不能对全部广告统一套2026新浏览规则。

每份来源固定适配器版本、原列对、转化模型/窗口/人工依据和币种精度。事实保留该行的依据，分析保存结构化measurementPins及源SHA/采集时点。语义相同的中英列名可以共同分析，原列名分别留在源依据中；不同定义或精度不能混组。未知/旧未固定口径保留原值和诊断，不能生成据此否词、调价等转化动作。点击CVR只用于已固定的点击定义。

归因成熟按这份报表实际采集日期判断。分析日变晚不更新原下载的转化数据；需要真实重采才能有更成熟来源。

## 金额与历史

新转换用固定ISO精度及BigInt，保留不舍入、不截断和安全整数上限。行币种与金额中明确ISO代码或不相容符号冲突时拒绝转换；未知代码没有默认两位。旧金额整数、原CSV、旧事实、分析、导出及校验值不回填。

新目标和经营金额固定同一币种依据，旧缺依据保持未知。旧原提交先按原正文和原校验值精确恢复，不能因为新解析算法把旧回执冒充新版本；新预览校验值同时绑定原输入、适配器、allowPartial和实际指标依据。修改部分导入开关必须重新预览；真实混合有效/无效行已证明旧预览409且零写入。

历史截止包括当时存在、之后才归档的来源；当前已撤回来源只供该截止的历史分析，不能生成新的执行动作。完整历史列表、原动作跨会话恢复和外部授权广告执行仍由后续工作完成。

独立花费预算按原产品范围、货币依据、广告主和时区核对。不同真实实体可以合计，同实体跨转化模型和重叠下载不能叠加；局部覆盖或同时间冲突金额明确诊断，不能凑出预算。转化建议仍独立要求已固定且成熟的点击口径。

运行入口为advertising-measurement-integration / advertising-measurement-browser，要求同nonce一次性资源与专用隔离flag。旧服务IPC只读固定148源码，仅在新隔离库创建旧版本作字节对照。无新迁移、密钥或普通启动；验收扫描器恢复原停止。完整历史、更多真实报表与减少动态效果场景未由本批两条浏览器验收穷尽。
