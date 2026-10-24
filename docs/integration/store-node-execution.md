# 店铺节点的原能力同步执行

局部开发验证通过的独立协议 `erp-store-node-execution-v1` · 2026-10-22 · e6f2c8a1

本批将原 `HttpMarketplaceCapabilityGateway` 放到真实绑定节点执行，中央仍通过原 `MarketplaceCredentialUse` 保存凭据刷新检查点，并由原 `MarketplaceCapabilityService` 校验、保存能力版本和审计。支持 Amazon private 与 Etsy OAuth。没有新增通用 HTTP、SQL 或 Shell 工具，发布、订单、广告等其余节点操作继续保留完整 B21 待办。

共享输入输出以 [执行契约](../../packages/contracts/src/marketplace/store-node-execution.ts) 为准；原 `erp-store-node-v1` 的 Schema、心跳封套和历史回执不改。中央 `.env` 和普通148环境不改。新迁移180仅用于一次性隔离验证，不能在普通148上运行当前源。

## 原权限与自举

任务提交沿原能力同步的 StoreRead 与 StoreManage，登记和绑定仍需三项节点管理权限。有效、已知授权但尚未有首份能力的 pending_authorization 店铺可登记、绑定并仅运行能力核对，解决先同步才可绑节点的自举环；其他平台操作继续核对原 active 状态和当前能力。失权、停用、撤销、证书或绑定代次变化影响新请求和最终采用。

原中央同步路径对已经进入节点域的店铺及显式开启新模式的部署拒绝直连，离线不会回退中央。旧179未分配节点的原流程仅作为兼容路径保留，不能算作节点成功。节点实际工作由显式 `work` 命令启用，原 `run` 仍只做身份心跳。

## 凭据与执行

节点收到的有界任务固定原 requestId/checksum、输入、店铺、节点/证书/授权/绑定代次及原租约。每次 HTTP 请求先保存本地加密提交边界，再在线取得短期许可；只允许本操作对应的 HTTPS 方法和路径。Amazon schema/metaSchema 下载只能使用本次真实 definition 返回且经节点策略认可的确切链接，不能把任意 amazonaws.com URL 当作代理。

原每店凭据使用节点 RSA 公钥封装随机32字节传输密钥，正文用 AES-256-GCM，AAD 固定任务、claim、请求和节点代次。传输密钥在中央只经原 marketplace secret vault 加密保存。checkpoint 与 completion 各用独立 purpose AAD；重复未知 RPC 恢复只重传原密文，不重新调用平台。刷新成功后先保存加密本地回执，再向中央保存原唯一 token 检查点，获得原 ACK 后才能继续新平台请求。进程重启复用已读的原 HTTP 响应；已提交而无响应的步骤进入 unknown，不能重新发送。

Etsy 应用级 shared secret 不由中央封包下发。节点仅从本地 `STORE_NODE_ETSY_APP_KEYSTRING` 与 `STORE_NODE_ETSY_APP_SHARED_SECRET` 读取，必须匹配任务固定的原应用 public clientId 摘要。配置缺失或不匹配时不执行 Etsy。中央原 OAuth 配置和授权流程保留，未声称中央不再保管应用凭据。生产节点的部署与信任仍须单独验收。[Etsy 认证说明](https://developers.etsy.com/documentation/essentials/authentication/)要求应用认证与用户 OAuth 分别提供；加密复用 [Node24 crypto](https://nodejs.org/download/release/v24.17.0/docs/api/crypto.html)。

刷新检查点与下一次执行许可分门：已经提交的原请求途中成员失权时，仍可按原物理证书、job/use/credentialId/version/auth generation 精确 CAS 保存唯一返回 token；这不授予新读取或能力采用权。证书已撤销、账户已停用/撤销或授权代次已变化时不能复活，保留 unknown 与重新授权缺口。

每次请求的原摘要、permit、有限 HTTP 状态和响应摘要独立保存，不记录 URL 查询、请求头、令牌、响应正文或原错误文本。原能力 sourceChecksum 的 base64url 算法保持，外层协议 SHA-256 hex 独立。结果、传输和本地加密 journal 都有明确上限；超限必须失败，不能伪装部分结果为完整成功。

节点的原 syncedAt 保持，最多允许比中央数据库时钟快30秒，并且不能早于领取时间30秒以上。原结果到期时间必须严格等于 syncedAt 加原请求 TTL；中央采纳的 expiresAt 取原到期与中央当前时间加 TTL 的较早者。原 syncedAt、原 proposed expiresAt 和实际采纳期限在同一事务的审计中保存，原 data 与 sourceChecksum 不变；节点时钟不会延长中央采用期限。

执行账本的 credentialId 与 version 是历史固定编号，不以外键强留可删除的原密钥行，也不在撤销时清空历史编号。原授权拥有者撤销时仍实际删除凭据并推进授权代次；新派发和检查点 CAS 每次通过原拥有者核对当下 tenant、id、version 与 generation。只读历史不重新取得密钥；未结束任务在原代次或绑定失效后立即显示 authority_changed，完成时间没有实际回执时保持为空，历史成功快照仍按原版本和当前 stale 标志读取。

## 有权个人接口

| 路由 | 结果 |
| --- | --- |
| GET `/v1/marketplace-accounts/:id/node-executions` | workspace、server access、当前绑定和最近20条原任务 |
| POST 同一路径 | 201 原任务；重复同键同正文读取原任务，不启动第二次平台同步 |
| GET `.../history?before=<id>` | 原ID游标分页，最多20条及hasMore |
| GET `.../:executionId` | 原任务及该任务对应的原快照，不能改读最新快照 |
| POST `.../receipt` | StoreRead；按原 requestId/checksum 只读核对，不重新提交 |
| POST `.../:executionId/cancel` | 当前原管理权；只取消尚无平台提交许可的任务 |

同源BFF前缀 `/api/marketplace-accounts/:id/node-executions`，采用当前本人摘要和有界 JSON；不提供秘密。前端仅保存本人/本店范围的原请求 ID、checksum 和执行 ID 等标量。未知提交先核原回执，不能从查无记录推断可以换新键重发。

## mTLS 内部接口

固定 POST `/v1/store-nodes/runtime/executions/{claim|permit|step|checkpoint|complete|receipt}`。真实 TLS socket 证书决定节点，调用者不得提供租户或个人 Bearer。新 RPC 有独立大小及协议边界，不把完整 taxonomy/schema 装入旧心跳封套。`claim` 返回固定原租约及密封凭据；`permit` 固定原步骤与请求类别；`step` 保存实际请求的有限回执；`checkpoint` 与 `complete` 使用同一原密文摘要恢复；`receipt` 只返回最小状态与检查点/最终密文摘要。

## 当前验证状态

本批36项去重检查通过：节点/受限传输9条、前端14条、当前真实接口10组、真正179升级1组、本人编译页面2条；另4组20种连接前隔离拒绝通过。仅补跑失败或受影响叶，未重跑全ERP套件。11资源组及13个自有目标已清并独立复核。一次本地写盘中断未能复现并确定原因，已加入有限诊断，不把补验通过解释为已修复其原因。完整B21、实际宿主/店铺、Linux、普通采用、跨域编排和全平台业务验收继续，见[本批进度](../project-control/ERP_STORE_NODE_EXECUTION_PROGRESS_20261022.md)。
