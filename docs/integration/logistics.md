# 物流购单与工厂交付

入口：订单与履约 → 发货中心 → 物流下单，或整单详情中的「按发货工厂准备物流面单」。
生产排期已经固定工厂、数量和预计完工时间后，可提前准备面单。物流任务不会推进生产完成、质检、实际出库或平台发货回写。

## 连接、规则与路线

迁移 `0105–0107` 分别加入完整印花组合、物流任务及「已提交」工厂回执。
API、Worker 均需重启。所有业务表启用强制租户 RLS，读写通过 `withTenant()` 和普通应用角色。
物流凭据复用 `INTEGRATION_SECRET_ENCRYPTION_KEY` / `yummyai-integration-v1` 加密域。
任务收件资料使用订单 PII 加密域；PDF 存入订单私有域，按租户、任务、有效订单及保留期授权读取。

1. 先在工厂目录确认实际发货地址和邮编。连接中的街道、城市、邮编和国家必须与当前工厂版本相同。
2. 中国发货连接使用云途；其他已配置发货地使用 ShipOS。云途面单随交付包提供，ShipOS 默认由工厂按物流订单编号拉取。
3. 配置账户接口、凭据、账单币种及小数位、币种依据、API 兼容与购单权限依据、允许下载面单的域名。
4. 为渠道填写目的国、自然日时效上下限与来源、服务条件核验、电池限制、最大重量和尺寸。通过当前账户渠道读取核验后，才能启用自动购单。
5. 配置单票、每日预算及允许渠道；默认只询价。预算按租户、币种、UTC 日累计已预留金额与实际费用的较大值，未确认的购单仍占用预算。

服务端 `YUNEXPRESS_ALLOWED_ORIGINS` 限定经部署管理员确认的 OMS HTTPS 源；不预填文档占位地址。
`LOGISTICS_LABEL_ALLOWED_HOSTS` 限定额外 PDF 下载域名，ShipOS 已允许 `shipease.oss-cn-hangzhou.aliyuncs.com`。
凭据只在保存时提交，不回显、不记录 HTTP Authorization 或地址。新增版本需重新核验。

## 任务与费用

每个任务固定订单来源序号、地址加密版本、工厂资料版本、生产版本、包裹实测与申报资料、交期及规则版本。
同一订单跨工厂分开创建。声明商品数量必须与所选生产任务一致；旧生产版本已有未取消物流任务时，改稿须先人工核对旧物流单。
自动选择先满足最晚发货、送达、服务条件、币种与预算，再取合格总价最低的报价。
使用「最晚发货＋已核验最大自然日时效」核对送达，购单前重新询价。缺项或无合格服务进入人工待办。
申报价及预算以所配置币种的最小货币单位保存，不默认所有币种都有两位小数。
报价不替代实际费用；供应商未返回实际费用时显示「未返回」。实际费用超单票或每日预算保留物流订单并进入待办。

调用创建接口前，事务锁定预算并保存购单意图及稳定客户订单号。结果丢失、处理中或部分面单成功时只查询同一客户订单号。
查询未发现订单仍保持「结果不确定」，不能自动再次购买。ShipOS 面单签发可能产生费用；签发响应不确定后只查询已有面单。
云途标签获取可恢复，已保存 PDF 的校验值不能被新的内容覆盖。请使用「查询并核对结果」，不要在外部平台另建重复订单。
任务、报价、事件和原版本均保留；地址匿名化或保留期到期时清除加密快照、跟踪号及相关私有 PDF。

## 接口

所有接口前缀 `/v1/logistics`，浏览器经同源 `/api/logistics` 白名单代理。

| 方法与后缀 | 行为 |
| --- | --- |
| GET `options`、`tasks`，GET `tasks/:id` | 有权限的排期、按订单筛选的任务及脱敏结果 |
| GET `connections` | 已配置连接与预算版本，凭据不回显 |
| POST `connections`，POST `connections/:id/verify` | 保存不可变连接版本、读渠道核验；IntegrationManage |
| POST `rules` | 保存规则版本；启用需当前连接核验 |
| POST `tasks` | 固定任务并派发 Worker；OrderRead、OrderPiiRead、OrderWrite |
| POST `tasks/:id/dispatch` | 询价、按规则执行或查单；同一意图不重复购单 |
| POST `tasks/:id/cancel` | 仅取消尚未开始购单的本地任务；不向供应商撤单 |
| GET `tasks/:id/labels/:labelId` | 授权读取私有 PDF，禁缓存 |

Worker `logistics` 队列执行 quote/purchase/reconcile/retention，每次执行重新检查操作者当前权限、订单、地址、工厂与制作审核版本。
物流首版要求租户数据范围，self/team 范围显式拒绝。重复请求复用原任务；改动包裹、路线或交期不会覆盖固定任务，须先核对原物流单。

ShipOS 适配器使用 `getChannel.php/getPrice.php/createOrder.php/queryOrder.php/orderDetail.php/getLabels.php`，独立于原查询同步适配器。
云途使用 `Common/GetShippingMethods/Freight/GetPriceTrial/WayBill/CreateOrder/WayBill/GetOrder/Label/Print`。
云途按公开 OMS 2023 规范发送批量数组、客户订单号、公斤三位小数及整厘米尺寸；首版一个任务一个包裹。
巴西税号、约旦证书及需要额外税务字段的目的地转人工；不猜填资料。ShipOS 缺少收件邮箱也转人工。
公开接口价格可能缺少币种或时效，必须使用账户核验来源；启用前确认当前账户兼容性。

基线：[ShipOS 官方文档](https://s.apifox.cn/45f68512-0e9b-41e9-8bd5-d8498f6faccd)、[云途 OMS 2023 规范](https://yunexpress-fileupload.oss-cn-shenzhen.aliyuncs.com/%E4%BA%91%E9%80%94%E7%89%A9%E6%B5%81API%E6%8E%A5%E5%8F%A3%E5%BC%80%E5%8F%91%E8%A7%84%E8%8C%83OMS20230706.pdf)。

## 工厂交付与验收

整单详情 → 工厂交付与回执：按工厂版本生成正式 JPG、逐商品 CSV 清单、不可变 manifest 和物流关联信息。
云途任务必须完成面单准备；ShipOS 工厂拉取模式保存客户物流订单号及跟踪号。
运营手动到 [工厂 ERP](https://v2.jmlonline.com/task/list) 上传 ZIP，登记「已提交」及实际凭证，再分别登记工厂收到、接受或拒收。
回执不等同生产完成。原生产、质检与交接证据继续控制实际发货。
异形抱枕按订单固定模板与 Rule Center 快照核验完整 JPG、实际像素、150 DPI、嵌入 sRGB、单双面和原工艺门禁；旧订单不补写新规则。

隔离验收：`pnpm test:e2e:order-daily --suite=logistics-integration` 和 `--suite=logistics`。
HTTP 供应商夹具只在匹配的一次性数据库、存储桶和 Redis 中允许 loopback；不接触真实账户或购单。
测试涵盖重复派发、价格变化、响应丢失、部分面单、预算、取消、权限撤销、地址更新与匿名化、跨工厂任务、正式 ZIP 与桌面/390px 页面。
资源清理和 HTTP 创建次数分别记录在忽略的 `tmp/order-daily-e2e-*.json`、`tmp/logistics-transport-proof-*.json`。
