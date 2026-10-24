# 工厂协作身份与逐文件任务

2026-10-18 · R02/R25 · B36，复用 B37 原生产交付拥有者。状态：设计与实施中，
本文件不是功能完成或真实工厂验收记录。

2026-10-19 / 1.1.33：新V3任务增加原制造版本的最小材料/工序/责任、销售数量单位、精确计划用量及明确生产说明。工厂不取得内部库存主键、成本、余额和BOM备注。接受必须同时核对原JPG和制造清单校验值；收到、接受、完工及质检仍分别记录，旧包不补造清单。详见[制造交付契约](manufacturing-delivery.md)。

## 来源与复用

先核对现有开源组件及业务服务，参考
[ERPNext 的供应商 Portal User 关联校验](https://github.com/frappe/erpnext/blob/develop/erpnext/buying/doctype/request_for_quotation/request_for_quotation.py)
和[工序任务](https://docs.frappe.io/erpnext/job-card)。这里只借鉴身份与业务对象关联的
做法，不引入另一套 ERP、账户库或复制其代码。继续使用现有 NestJS、PostgreSQL RLS、
OIDC、Lucide、原生页面组件、私有存储和生产交付服务。

原有运营端拥有者是 `OrderProductionDeliveryService`。文件、固定版本、数量、
工厂能力、正式出图校验与回执顺序继续由它维护，不增加第二份生产状态。

## 身份与授权

工厂人员使用现有 OIDC 身份及当前有效成员关系。认证边界从当前有效的工厂授权
派生 factory task read/respond 协作权限，不修改其普通后台角色，不授予 OrderRead、
OrderPiiRead、DesignRead、AssetRead 或后台写权限。工厂对象和任务范围来自服务端
记录，不能由租户请求头或调用者声明选择。只读授权不派生 respond，具体任务仍要
复核本人分配；普通 API 客户端不会因此获得工厂用户权限。

运营须同时具有成员管理和订单读写权限，才可将已开通成员关联到具体工厂。
工厂授权固定成员、工厂、有效期、创建者及幂等依据；撤销是一向终态。重新合作
创建新的授权，不恢复旧任务入口。本功能不发送邀请邮件或替用户创建外部账户。
真实人员开通、身份提供方配置和工厂试点分别验收。

任务分配固定到现有交付包的某一个文件，并记录工厂授权、期限及原文件校验值。
不得把包内其他文件、同厂另一卖家租户或未分配任务一起授权。撤销任务或工厂授权、
成员停用、当前权限失效、工厂停用和保留期到期均需阻止后续读取与写入。

## 工厂端数据与操作

### 对外身份与部署边界

现有 `apps/web/src/server-api.ts` 使用本地统一服务身份，不能直接用于对外工厂请求。
同一 Next.js 应用以 `FACTORY_PORTAL_ONLY=1` 在独立入口运行；该模式按服务端路径
白名单默认拒绝所有运营页面、运营 API、RSC 绕行及图片代理，只开放工厂页面、
个人登录、受权工厂 BFF 与必要静态资源。运营部署保留内部入口，不能将其本地
开发代理公开给工厂。正式网络、反向代理与身份提供方配置另须验证。

工厂登录复用现有 `auth.ts` 的 Authorization Code / S256 PKCE，并补 state、nonce、
一次性流程与 issuer/audience/subject 验证。参考
[Keycloak 的 Authorization Code/PKCE](https://www.keycloak.org/securing-apps/javascript-adapter)
和 [jose 的 JWKS/声明验证](https://github.com/panva/jose/blob/main/docs/jwks/remote/functions/createRemoteJWKSet.md)。
JWKS 来源只能是配置的可信身份服务，不能采用令牌自带的远程密钥地址。

Web 已直接声明现有 jose 6.2.3、ioredis 5.11.1 和 zod 4.4.3；锁文件仅增加 Web
的三个 importer 依赖，外部依赖图不变，已用冻结离线安装核对根与安装锁一致。
个人 access/refresh token 由独立 `FACTORY_SESSION_ENCRYPTION_KEY` 域加密，保存在
Redis；浏览器只持有随机 HttpOnly、SameSite、生产 Secure/__Host 会话标识。原流程
和会话分别分域，不在浏览器存原令牌，不回退 `API_ACCESS_TOKEN` 或内部统一身份。
工厂 BFF 只转发当前个人会话，后端继续检查真实成员、工厂授权与任务范围。

会话须支持有界刷新与原子互斥；刷新不能延长原绝对保留期限。一次性 code 或轮换
refresh 的响应不确定时重新登录，不能使用现有通用 identity 传输的自动重试来重放。
注销和撤销期间的刷新不能复活会话。请求丢失/撤权后清除已显示资料及未提交内容，
较早成功响应不能恢复旧数据。合成签名身份的真实浏览器已经覆盖登录、个人文件、
只读、撤权后清除、旧响应和刷新中注销；正式身份服务和工厂业务试点仍单独验收。

测试身份提供方可使用隔离的签名/JWKS 夹具验证真实 PKCE、JWT、会话和 API 路径，
但必须明确它不代表真实工厂账号或正式 Keycloak 客户端已完成配置。测试 Redis、
身份 HTTP 服务、数据库和存储资源都需跟随原隔离 runner 的 finally 清理。

### 制作与回执

任务只返回本人的分配引用、工厂名称、制作数量、截止时间、必要工艺、原正式文件
校验值和回执状态。买家姓名/地址、平台订单号、财务、模型提示词、原来图、其他
制作版本和内部审批说明不进入工厂 DTO。

文件走认证下载端点，不发永久公开链接。由原文件拥有者核对分配、当前来源和
正式文件字节；读取结束再检查当前授权，撤销途中不返回已读取的缓冲区。
存储读取使用仅绑定当前任务和原对象的服务端授权，不伪造后台成员权限。

工厂本人可确认收到、接受或拒收原文件，提交须绑定分配、文件校验值和当前回执
序号。接受不等于开产、完工、质检通过或生产放行。创建返工、修改图稿、改变生产
数量与费用仍走运营流程。工厂本人回执和运营代登记在历史里明确区分；重试复用
原事件，权限或授权已撤销后不能用幂等重放继续写入。

## 必须验证

- 普通工厂身份只见已分配文件；同厂不同成员、不同工厂、不同租户及猜测 ID 均隔离。
- 当前角色/成员、工厂授权、任务撤销及期限每次复核；旧入口和晚到成功响应不能恢复数据。
- 已审核 JPG 的真实字节、原校验值、数量与工艺保持一致；来源改版、暂停、拒收或隐私到期时阻止下载。
- 下载途中撤销不返回缓冲区；原订单后台、资产和编辑接口仍拒绝工厂最小角色。
- 原接收/接受/拒收序列、并发冲突、幂等、操作者来源和生产门禁通过原业务拥有者验证。
- 运营授权/分配及工厂端正常、空、失败、到期、撤权页面通过真实认证浏览器核验。
- 使用隔离测试资源并清理；原有自动审批拒绝的本地删除不绕过，剩余项继续如实登记。

## API、页面与迁移

运营入口为 `/factory-collaboration`，需要当前租户级成员管理与订单读取权限；
写授权、分配和撤销还需订单写权限。原交付文件的候选读取保留原订单/PII/设计/
资产权限，不因能管理成员就自动获得原件。工厂入口为独立源的 `/factory-work-items`。

API `/v1/factory-collaboration/workspace` 提供有界候选和分页授权；
`POST grants`、`POST grants/:id/revoke`、`GET/POST grants/:id/work-items`、
`POST assignments/:id/revoke` 分别维护授权及逐文件任务。当前候选上限 100，
授权/任务每页最多 50；原生产交付列表截断时明确提示，不能当作全量。

个人 API `/v1/factory-portal/session`、`work-items`、`work-items/:id`、
`work-items/:id/file` 和 `POST work-items/:id/feedback` 均经原认证成员边界。
FactoryTaskRead/Respond 只由当前有效授权派生。专用存储许可绑定服务端实际任务、
用户、原对象与校验值，最长 60 秒、最大 64 MiB；复制JSON或其他对象不能复用。

迁移 `0125_factory_collaboration.sql` 新增 factory_access_grants、
factory_task_assignments、factory_task_receipts；复合租户外键、强制RLS、SQL当前
操作者守卫和不可变来源同时约束写入。任务与授权仅可单向撤销，不可修改对象
和原文件；重新合作创建新授权与新任务。既有生产包及回执不会自动建立工厂授权。
此迁移仅由隔离验收执行；普通库的备份、迁移与正式开通尚未执行。

## 配置与验收方式

除现有 OIDC_ISSUER、OIDC_AUDIENCE、可选 OIDC_JWKS_URI、API_BASE_URL 和
REDIS_URL，工厂部署还需 FACTORY_PORTAL_ONLY=1、FACTORY_PORTAL_ORIGIN、
FACTORY_OIDC_CLIENT_ID 和独立32字节base64url FACTORY_SESSION_ENCRYPTION_KEY。
公开源必须匹配回调，生产用HTTPS；本地仅允许loopback HTTP。按来源和客户端
隔离Redis命名空间，8小时绝对会话、10分钟登录流程，不在日志输出令牌或密钥。
Redis连接永久失败后下一请求可重新建立客户端；失败请求不回退内部身份。

`infra/keycloak/realm-export.json` 的 `yummyai-factory` 是源码配置：公开客户端、
Authorization Code、S256、关闭密码/隐式/服务账户授权；开发回调为
`http://localhost:3001/api/factory-auth/callback`。租户声明来自管理员配置的用户属性，
实际访问仍须数据库当前成员与分配。该文件不会更新正在运行的realm；不自动
创建真实人员、授予角色、发送邀请或开放网络。退出协作删除本地会话，非全局IdP退出。

复跑 `pnpm test:e2e:order-daily --suite=factory-portal` 和
`--suite=factory-collaboration`，各自在独立Web快照运行，个人身份HTTP/JWKS为合成。
实际API认证、当前成员、RLS、Redis加密/CAS、私有原件与回执都执行。刷新竞态
测试仅修改该隔离会话的加密到期检查点以确定触发时序，保留真实签名令牌。
Runner finally 验证DB/桶/Redis删除、身份HTTP服务关闭与Web快照删除；原始
截图/日志/trace检查后的本地清理另记，不能把此前拒绝的清理宣称完成。

既有生产包的单品支持范围
仍以[原交付契约](production-delivery.md)和各供应规范为准，不能因为增加工厂入口
就宣称所有品类均已通过工厂制作验收。
