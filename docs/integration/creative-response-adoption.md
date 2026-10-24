# 创作原响应安全采用

2026-10-24 · PRD1.1.126 · a71c9e42 · R01/R08/R13/R18/R39 · B18/B28/B32 · C06

首个拥有者已通过24项真实采用API检查、23项既有素材回归与3个编译个人页面场景，候选缩略图实际字节已验，本批自有输出清理及独立查无通过，尚未采用到日用。当前日用仍是已验证的1.1.125、schema188、4052源630fdef0/Web052e/Studio adapter2.7.0，普通Worker与真实付费关闭。继续复用 Infinite Canvas、PostgreSQL/Drizzle、既有加密vault、私有对象存储、Sharp和ClamAV，不增加执行框架或外部依赖。

## 完整目标与首个拥有者

C06最终须覆盖模型超时、响应存储失败、原响应导入和人工接管，且五类creative execution各由真实业务拥有者验收。首片先接通creative_candidate/generate的已登记加密原响应，形成generated且unverified的候选，继续原选稿、规格适配及人工审核。原执行failed/uncertain、费用、预算、原提交、attempt/dispatch、归档和历史均不重写。不自动选稿、批准或放行生产。

其他四类拥有者、仅有receipt或渠道原文而缺可信归档的导入、外部原请求查询及跨申请人接管仍是明确后续缺口。客户端任意CreativeResponse、proofChecksum、补造HTTP200/deployment/maxOutputBytes都不是可信响应。未实现类型明确拒绝，不以回调替身或候选正例代替全部C06。

## 共享接口

契约位于`@yummyai/contracts/harness/creative-response-adoption`。同源BFF沿`/api/creative-executions`转发原个人身份，不接收tenant或凭据。

| 接口 | 行为 |
| --- | --- |
| GET `/:executionId/response-adoption` | 当前原候选与归档元数据、固定basis、采用阻断原因、本人原请求索引；无写入 |
| GET `/:executionId/response-adoption/preview?basis=…` | 有界读取原图 实际解码扫描并复核权限 返回basis 原响应摘要与实际图片字节摘要；无写入 |
| POST `/:executionId/response-adoptions` | 严格正文requestId、expectedBasis、acknowledgeReviewRequired=true；明确请求原响应采用 |
| GET `/:executionId/response-adoptions/by-request/:requestId` | 只读找回原采用请求、状态和原回执；missing不能证明未派发，不自动POST或换键 |
| POST `/:executionId/response-adoptions/:adoptionId/cancel` | 明确放弃未提交的本地处理；活跃处理不抢占，已提交回执不撤销 |

每个execution只能对应一个独立采用事实，同租户同申请人requestId唯一。重复同键同正文复用；换人、换执行、换完整正文冲突。跨刷新先读服务端本人索引和精确原键，成功回执不依赖归档永久保留。

候选图读取复用现有AssetsController，并在原`/assets`之外提供`/v1/assets`明确别名。个人页面只调用`POST /v1/assets/:id/read-url`，仍要求AssetRead、当前资产拥有范围、authorized域及短期签名；原控制器权限、RLS和审计完全复用。不能为兼容旧地址放宽个人传输的`/v1/`边界。每份素材失败独立呈现固定原因，图片过期或加载失败可只读重取，不清空整批或以正常占位图掩盖缺图。

## 三层与并发

数据层拟新增0189独立采用表，强制RLS及非owner应用角色，保存原请求、basis、原source/receipt/密文与正文摘要、有限本地尝试、租约和不可变回执。旧0188及更早迁移字节不改，升级只在一次性188副本先验证；日用不得连接未配对189开发源。

Harness层把采用作为不调用模型的本地受控命令：准备原请求、bounded归档读取、密文校验和解密、完整原envelope/receipt匹配、严格POD解码、实际图片解码与扫描、固定产物上传/回读、最终owner事务和独立回执。原归档意图不证明对象存在，任何失败均不能伪装成功。I/O前后及最终提交复核原权限上限和当前逐权限范围、原来源版本/权利、原方法、原候选未采用以及父取消/归档。原执行锁→实际父项→条目/候选→资产，避免与现operator和取消反向锁。

Agent层只呈现证据与明确操作，不自动重发、切换模型、增加预算或制造批准。页内关闭、刷新、重登及请求回执丢失优先只读恢复；过期、缺失、撤权和暂时失败分别显示。HTTP成功后仍校验完整契约、原execution/request/basis，不能只看status。

本地处理有有限尝试和数据库时钟租约；失效旧处理器不得提交。失败产物使用本采用ID专属内容寻址位置并保留准确manifest，已登记业务资产与孤立中间物区分；正式清理只能处理本采用精确未登记对象，保留原归档和已提交结果。

租约过期不证明旧上传已经停止。首片只允许明确释放的prepared原请求继续本地有限尝试；processing即使过期仍只读核对，不盲目重领或取消。已派发PUT发生传输错误时，须以实际对象回读确证原字节；不能确证则保留processing及原错误，不能把一次HEAD404当作上传终止。跨进程崩溃或远端写入长期不明的安全接管和自动孤物过期维护仍是C06后续缺口。取消后精确清理失败保留pending，恢复当前写权限后可按同一取消请求再核对和清理。

## 文件分工与验收

主控独占共享contracts、DB/schema/迁移、主service/controller、BFF接线、共享codec与进度聚合、runner注册、状态和PRD、构建、服务与资源生命周期。前端负责共用执行历史内的采用面板/client/intent/CSS；后端子Agent仅负责独立原归档验证helper及其纯测试；QA负责独立integration/fixture、guard、client竞态与编译个人页面。

验证必须使用真实候选拥有者、PostgreSQL/RLS、私有存储及ClamAV。failed/uncertain、原字节和费用保持、损坏/过期/清除、跨租户/撤权/换源、I/O中取消、并发幂等、真实提交后失ACK只读恢复、失败产物归属和真正188升级分别留证。模型调用计数器任何调用即失败；不启动普通Worker。不重复无变化的旧全量套件。

页面按1440/390核对真实原响应和独立回执、待审核语义、刷新恢复与退出后的迟到正文。检查后删除本片raw日志、截图、trace、测试下载及可识别缓存和隔离资源，保留源码、简明结论、业务备份和恢复记录。896历史冻结边界和并行AI计费任务路径均不重试。

当前执行状态见[本片进度](../project-control/CREATIVE_RESPONSE_ADOPTION_PROGRESS_20261024.md)和[state.json](../project-control/state.json)。
