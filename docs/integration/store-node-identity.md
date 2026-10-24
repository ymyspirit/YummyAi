# 每店节点身份与心跳

版本 erp-store-node-v1 · PRD 1.1.101 开发版局部验证通过 · 2026-10-22

本轮将独立节点程序、一次性公钥登记、短期客户端证书、真实双向 TLS、单店绑定和持久心跳接入原 ERP。已通过37项去重定向检查及验后清理，详细边界见[本批进度](../project-control/ERP_STORE_NODE_IDENTITY_PROGRESS_20261022.md)。它只建立节点身份与可达性，`execution.status=not_integrated`、`supportsPlatformOperations=false`。尚不承载平台任务、授权秘密分发或原执行意图，不能因为节点显示在线而推断平台已接通。完整 B21 与普通环境采用仍待完成。

## 源码和开源依据

- 原 Nest/Drizzle/RLS 所有者增加 [StoreNodeService](../../apps/api/src/marketplaces/store-node.service.ts)，共享 [严格契约](../../packages/contracts/src/marketplace/store-node.ts)，迁移 [0179](../../packages/database/migrations/0179_store_node_identity.sql)。原平台授权与凭据保持原模块拥有。
- 独立 [apps/store-api-node](../../apps/store-api-node/package.json) 复用 Node 24 的 HTTPS、TLS、crypto 和已锁定 tsx/Zod。中央签发使用绝对路径 OpenSSL 3、固定参数和无 shell 的 execFile。没有自行实现 ASN.1 或密码算法。
- 参考 [Node 24.17 TLS](https://nodejs.org/download/release/v24.17.0/docs/api/tls.html) 与 Apache-2.0 [smallstep/certificates](https://github.com/smallstep/certificates)。step-ca 仅作为生产 CA 部署候选，当前没有实现其 API、自动根轮换、硬件密钥或托管 CA 接入。

## 原批准和真实节点协议

1. 节点 `init` 在自身私有目录生成 RSA 3072 位密钥，私钥为 AES-256 加密 PKCS#8。口令只由该进程 `STORE_NODE_KEY_PASSPHRASE` 取得；公钥可交给 ERP，私钥与口令不得交给聊天、模型或 ERP。
2. 有权人员在原店铺节点区域登记公钥。所有写入都重新核对 StoreRead/StoreManage/StoreAuthorize、当前成员、原账号归属、授权代次和绑定 revision。票据有效十分钟，数据库只存 SHA-256，一次展示仅留组件内存。相同请求键不能重显票据；未知提交先 GET 按 creationRequestKey 恢复，需要新票据时明确重新签发。
3. 节点 `enroll` 使用 HTTPS 服务器身份验证，签署共享规范元组，证明持有绑定公钥。原票据在签发前独立事务 claim，签发后再核对原 claim、证书代次、账号授权代次与当前成员。迟到证书无法通过原指纹登记，不得直接使用。
4. 客户端证书有效不超过 24 小时，仅 clientAuth，含固定节点 URN。签发起止日期显式固定到原 claim 的数据库时刻：notBefore 为 claim 减三十秒再取整秒，notAfter 为该起点加二十四小时；这吸收本机原生与 JS 时钟差并缩短剩余寿命，签后须精确匹配，中央采用与节点仍核对证书在实际当前时刻有效。节点只向指定 runtime HTTPS origin 发起出站请求。运行时监听器从真实 TLS socket 提取证书，不信任转发证书头、Bearer 或调用者 tenant。CA 验证后仍逐请求核对数据库证书指纹、公钥、原成员与账号状态。
5. 首次真实心跳后可显式绑定。每店仅一条绑定记录，用 revision 做 CAS，证书代次及店铺授权代次固定在绑定中。更换节点先 draining，保留原心跳租约到期；draining 心跳不能续绑定租约。重签或撤销立即废除旧证书，同时保留排空期限。
6. 会话和 sequence 持久化。未知回复使用原请求恢复，同序列原回复不延长原租约，不能以新请求重放未知操作。不同 session 在旧会话有效期内拒绝抢占。心跳租约三十秒；节点停止后显示离线，中心不回退直连。这是身份心跳租约，尚未实现平台执行许可。

## 路由

| 路由 | 身份与结果 |
| --- | --- |
| GET `/v1/marketplace-accounts/:id/nodes` | 原本人 StoreRead；严格 workspace、当前本人摘要、节点和绑定事实 |
| POST `.../nodes/enrollments` | 三项权限；新公钥登记，201，一次性 enrollment bundle |
| POST `.../nodes/:nodeId/enrollment` | 三项权限与证书代次；201，显式重签，旧证书立即无效 |
| POST `.../nodes/binding` | 三项权限与双代次/revision；200，绑定或排空当前绑定 |
| POST `.../nodes/:nodeId/revoke` | 三项权限与双代次/revision；200，撤销节点证书 |
| POST `/v1/store-nodes/enroll` | 独立 HTTPS 引导入口；一次票据、公钥持有证明，拒绝 caller tenant |
| POST `/v1/store-nodes/runtime/heartbeat` | 私有 mTLS 监听器；逐次证书与原权限核对，不承载普通个人 Bearer |

前端同源 BFF 位于 `/api/marketplace-accounts/:id/nodes`，只接受上述固定有限路径。先后核对当前本人及授权摘要，响应限长并按原 Schema 解析。原 OAuth、店铺账号、能力、发布等 DTO 与原动作不替换。

## 配置和部署限制

中央只有 `STORE_NODE_RUNTIME_ENABLED=1` 才启用。未配置显示真实未配置状态，不自造 CA 或启动开放监听。

| 变量 | 内容 |
| --- | --- |
| `STORE_NODE_OPENSSL_PATH` | 可执行 OpenSSL 3 的绝对普通文件路径 |
| `STORE_NODE_CA_CERT_PATH` / `STORE_NODE_CA_KEY_PATH` | 中央签发 CA 证书链及私钥的受保护绝对文件路径 |
| `STORE_NODE_SERVER_CERT_PATH` / `STORE_NODE_SERVER_KEY_PATH` | runtime 服务器证书链及私钥路径，serverAuth 和域名必须正确 |
| `STORE_NODE_ENROLLMENT_ORIGIN` / `STORE_NODE_RUNTIME_ORIGIN` | 固定 HTTPS origin，不含凭据、路径、查询或 fragment |
| `STORE_NODE_RUNTIME_HOST` / `STORE_NODE_RUNTIME_PORT` | 独立 TLS 监听地址及端口，默认 host 127.0.0.1，port 必填 |
| 节点 `STORE_NODE_KEY_PASSPHRASE` | 仅节点进程持有的私钥口令，不能打印或放入 bundle |

CA 私钥只在中央受保护签发域，节点没有数据库、Redis、浏览器 cookies 或平台 token。生产 HTTPS 引导代理、PKI 管理、CA 信任交付、节点主机与监控必须单独部署验收；本地验收 CA 和回环 HTTPS 代理只是隔离测试资源。当前 `.env` 不变，普通数据库 148 和既有普通应用保持停止，179 仅能运行在匹配已迁移的环境。

## 未完成范围

平台请求的原 intent 绑定、逐操作允许列表、受控令牌/凭据迁移、原任务幂等回执与 unknown 核对、真实店铺与宿主采用仍未接入节点。这轮不得宣称 Amazon/Etsy 已改成节点执行，也不得把历史中心调用算作节点成功。节点本地排他锁与持久文件提交当前只实现 Windows，Linux 节点部署未实现，不能据此投产跨系统节点。生产密钥托管、自动续期、CA 轮换和实际公网部署继续保留明确缺口。
