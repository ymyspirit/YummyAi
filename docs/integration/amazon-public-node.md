# Amazon 公开应用的节点能力与校验预览

PRD 1.1.106 · B21 · 3d7f9a21 · 本批局部技术验证通过，完整 B21 继续

已有公开 OAuth 可以取得并保存店铺凭据，但节点能力同步、标准 CLI 和原校验预览仅接受私有应用，导致公开授权后停在待初始化状态。本批贯通新增公开店铺、原 OAuth、节点登记及绑定、明确提交能力任务、原能力快照和批准 Listing 的节点校验预览。正式刊登提交、Feed、Etsy 写入、普通版本采用和完整 B21 继续独立推进。

## 应用身份与秘密归属

原授权 Gateway 在真实 code 请求之前固定本次 `clientId`，用同一值构造请求并保存到原 public credential。它是应用身份，不是密钥。旧 public credential 没有此绑定时明确要求重新授权；不能用当前环境变量补造历史来源。

中央仍通过原凭据拥有者、成员权限、授权代次和 credential use/version 核验 public credential。领取任务时核对原 `kind`、原 `clientId` 与当前中央应用配置一致，在原密封 seed 中固定 `amazonAppClientIdSha256`。新字段可缺省以读取旧私有应用和 Etsy seed，但公开应用必须有原绑定；不改变旧 AAD、journal、回执或事实表。

节点启动时从本地读取 `STORE_NODE_AMAZON_APP_CLIENT_ID` 和 `STORE_NODE_AMAZON_APP_CLIENT_SECRET`。两项完整配置才声明支持公开应用；实际执行前核对固定 ID 摘要。中央不在 seed 中下发公开应用 secret，节点不从中央环境或密文推测应用配置。私有应用继续使用每店凭据，不依赖新增公开应用配置。

原能力与刊登 Gateway 通过显式环境映射使用本地应用配置，继续经过受限 transport、实际 HTTP 前的在线 permit 和原 owner 最终采用。节点本地 secret 也进入输出过滤；不得进入任务、日志、浏览器、模型或结果。

已有 completion 及原物理回执的恢复先于本地应用可用性检查。撤掉配置不丢弃已经持久化的回执；任何新的 HTTP 仍须当前固定应用、原租约与许可。已提交而响应未知的步骤不重新发送。

## 创建与原操作

新增 Amazon 店铺时可以直接选择私有应用或公开 OAuth，保留原默认和已有编辑路径。Etsy 使用自己的 OAuth。平台授权仍由本人在店铺详情明确开始；创建档案不触发外部授权或发布。

节点工作台继续服从服务器权限、绑定及状态。`run` 仅执行身份心跳，`work` 才显式处理已保存任务。配置缺失或不匹配应显示配置问题；原应用绑定缺失应显示需要重新授权，不能冒充个人失权而删除原请求。

首份能力与校验预览沿用原 API、Zod 契约、mTLS、私有 journal、能力快照、Publication 和事件。公开模式不增加通用 URL 工具，不绕过 Listing 及 Store 的逐项权限，不回退中央执行，不自动正式发布。

## 开源与依据

已核对 [Amazon 官方开源 SDK](https://github.com/amzn/selling-partner-api-sdk) 和 [putListingsItem](https://developer-docs.amazon/sp-api/lang-en_us/reference/putlistingsitem)。本批复用现有有界 adapter、Node24、NestJS、Zod 和 React，避免引入另一条绕过 permit 的 HTTP 执行路径。`VALIDATION_PREVIEW` 保持独立校验语义，不能算作正式上架。

## 验收要求

必须通过真实原 OAuth owner、标准 CLI/mTLS、首份能力采用和同店原版本校验预览；缺错本地配置、旧无绑定凭据及中央应用 ID 变化应在新平台请求前停止。另验证原回执丢失后的恢复、未知提交不重发、私有应用无需公开配置和本地秘密不外泄。

个人编译页面需验证创建时直接选择公开模式、当前任务及原键恢复、桌面和窄屏状态。外部平台响应由隔离 HTTPS 提供方产生，不把合成提供方验证当真实卖家授权或正式发布。资源必须使用新一次性数据库、私有桶、Redis 和 PKI，并在检查后清理本批自有输出；普通148及885历史冻结路径保持。

## 本批验证结论

50 项定向单元、6 项真实隔离接口及 2 项同一编译版本的个人浏览器场景共 58 项去重通过。新建公开店铺、原 OAuth cookie 与授权代次、一次原中央 code 交换、标准 CLI/mTLS 节点能力、固定 Listing 版本预览及丢失 201 后只读原回执均有实际证据。桌面 1440/1280 与手机 390 画面已检查。首轮测试定位和网络观测失败保留，未计通过。

6 组一次性数据库、私有桶和 Redis 已由独立审计确认不存在；5150 个本批临时文件、8 个本地目标及 3 个链接已清，共享依赖保留。日常 148 数据库及原 API/Web 继续运行，本批开发 182 尚未采用。没有真实卖家授权、正式刊登或付费模型调用；正式提交、Feed、Etsy 写入及完整业务验收继续。

详见[交付结论](../project-control/checkpoints/2026-10-23-amazon-public-node-3d7f9a21-delivery-validation.json)。
