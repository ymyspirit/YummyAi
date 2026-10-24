# ERP Agent 的委派与能力目录

2026-10-22，PRD 1.1.86，0171。当前是统一接入前置；内置AI工作台、原业务流程及无限画布继续保留。全ERP计划与后续验收见[接入规格](../erp-blueprint/18-erp-agent-integration-specification.md)，本批进度见[委派进度](../project-control/ERP_AGENT_DELEGATION_PROGRESS_20261022.md)。日常环境采用状态以根目录PROJECT_STATUS为准。

## 身份与权限

仅保留原九项只读scope，不增加write、run或任意执行权限。签发通过当前真实成员及当前IntegrationManage，固定原membership ID、逐权限self/team/tenant上限、原团队、DB时钟和原正文checksum。有效权限始终是出生上限、调用者上限、当前成员逐权限范围及原/当前团队的交集；角色扩张或新增团队不扩大旧委派。每次认证在普通RLS角色下重读当前key、成员和角色。

旧记录的delegation为NULL，迁移不根据今天的权限回填。历史摘要和撤销沿原owner可用，认证需重新签发；旧authenticate_integration_api_client函数返回空行，不能将新self/team key经旧tenant loader扩大。新bootstrap authenticate_integration_api_client_v2只查受限凭据元数据，实际权限在withTenant中计算。所有私有HTTP响应在原owner I/O后重新认证，key撤销/到期、成员失效或权限/团队变化时拒绝返回旧正文。此最终响应门不能替代未来写命令事务内的当前授权。

旧owner未全部证实窄范围逐对象过滤，API Client全局路由门只准入GET及原九项read权限的tenant交集；所需某bit为self/team时拒绝，不能借另一个bit的tenant。无权限声明、POST或非原只读bit默认拒绝。唯一明确窄范围入口是GET /v1/integrations/agent-capabilities，仅返回固定能力覆盖元数据，不读业务对象或执行工具。OIDC本人路径继续使用原权限及业务门。

## 原请求与事务

POST /v1/integrations/api-clients接受原label/scopes/expiresAt/idempotencyKey及可选scopeLimits、teamIds，不接受调用者自填租户、委派、申请人或证明。显式scopeLimits须恰好覆盖所选scope并不超过当前逐bit上限；省略时固定本次当前交集。teamIds省略时固定当前交集，显式[]保持无团队，额外或后来加入团队不能补进旧记录。

请求结构校验不使用进程时钟。真正新签发才由DB时钟拒绝已到期时间；未知请求的原actor/body/key可在到期或范围收紧后返回原最小摘要，仍需当前管理权限和原owner范围。重放不新增事件/审计，不复显secret，不给其他成员或变更正文返回原创建结果。

出生委派和原解析正文不可变，SHA256使用共享canonicalJson及对应既有DB canonical helper。新记录状态、密钥身份、原scope/team、原正文和到期不可改；撤销只能active到revoked。SQL出生及撤销约束绑定真实当前成员/操作人、事件和成功审计；client/event持久保存DB实际fullxid，审计同事务检查使用xmin及原动作/对象/metadata匹配。不可将审计单独说成持久xid8凭据。裸SQL不能省略事件/审计、补造旧pin或在early constraint flush后追加伪结果。

## 界面与可见状态

原运营驾驶舱的开放集成区域提供创建、撤销、逐bit范围和固定团队摘要。列表是近期最多100条，不是完整历史；workspace仍需IntegrationRead，不因Manage-only放开Webhook私有内容。credentialState为pinned/revoked/expired/requires_reissue；pinned表示出生委派已固定，不保证当前调用成功或MCP接通。

Web个人BFF仅开放GET workspace、POST clients和POST clients/:id/revoke，核对同源、严格输入/输出、受限完整JSON、本人前后身份和响应authority。秘密仅创建成功时显示一次，保留在当前页面内存；关闭或已发现身份变化立即清除，退出动效不延迟清除。没有浏览器存储、URL或日志副本。复制仅由用户明确点击。

未知创建保留本页原body/key，显式核对同键结果；服务器已登记但未保存secret时只返回null，界面明确撤销后重新签发，不自动生成第二个key。刷新后当前内存正文不能自动恢复，应先核对已有客户端列表；完整跨刷新原提交恢复仍待后续工作。

目录固定版本erp-agent-catalog-v1，包含11域24项具名覆盖描述。存在的原owner、权限不足、统一适配待补分别展示。当前全部callableViaAgent=false、mcpState=not_connected，没有Schema执行入口、统一工具循环、外部Agent登录或MCP已接通结论。目录权限只是覆盖说明，不能作为生产放行、付款、发布或对外联系的批准。

## 验收与运行

本批只运行agent-delegation-integration、agent-delegation-upgrade-integration及agent-delegation-browser定向套件。配置和夹具在连接前要求E2E_AGENT_DELEGATION_ISOLATED=1、E2E_ISOLATED_DAILY=1、精确nonce PG数据库、同nonce私有桶及current/pre-0171目标。真正旧170使用本批事先固定的3073文件源，不从当前源码伪装旧库。

由统一disposable runner管理数据库、私有桶、Redis及身份夹具，浏览器需同编译候选和个人3130/8130。禁用trace/video/自动截图，手动截图遮住secret输入；不保存token或私有网络响应。检查结果后删除本批日志、截图、缓存、旧源副本和编译候选，并独立核对资源不存在。普通148、真实工厂Excel及历史保护路径不更改。
