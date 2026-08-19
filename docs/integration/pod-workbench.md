# POD 作图中心集成边界

## 范围

POD 作图中心当前固定服务 `amazon` 与 `etsy`。左侧模块顺序由公共契约锁定为：

1. 印花提取
2. 印花设计
3. 图案处理
4. 侵权检测
5. 套图&标题
6. 来图定制
7. 生产图

视觉检索、印花图检索、任务中心和我的空间属于公共能力，不新增一级模块。

## 工具目录 API

`GET /v1/pod/tools`

- 权限：`design:read`
- 租户上下文：来自已认证成员身份，调用方不能传入租户 ID
- 返回契约：`PodToolCatalogViewSchema`
- 平台顺序：固定为 `amazon`、`etsy`
- 工具状态：`definition_ready`、`implementation_active`、`enabled`、`unavailable`

前端只有在状态为 `enabled` 时才能开放创建任务入口。`implementation_active` 表示正在实现，不能被解释为工具已经可执行。

## 通用 POD 任务 API

| 路由 | 权限 | 说明 |
| --- | --- | --- |
| `GET /v1/pod/tasks` | `design:read` | 返回当前租户最近 100 个 POD 任务及进度 |
| `GET /v1/pod/tasks/:id` | `design:read` | 读取一个任务、固定输入和结果版本关系 |
| `GET /v1/pod/input-options/:toolKey` | `design:read` | 返回当前工具允许使用的 SKU 与素材 |
| `POST /v1/pod/tasks` | `design:write` | 创建 `DesignTask`、POD 任务快照并进入异步队列 |

创建请求必须包含 UUIDv7 幂等键、真实 SKU、已接入的通用工具键和参数快照。该边界覆盖 POD-1、POD-2，以及不读取订单私有素材的 `product_video`、`piece_extract`、`piece_compose`、`uv_layers`。除 `text_to_image` 外，当前工具至少需要一份素材。队列负载只携带任务 ID，不能携带提示词、素材对象路径、图片内容或订单 PII。`image_composite`、`group_photo`、`pet_outfit`、`fulfillment_composite` 与 `vector_fulfillment` 必须走订单上下文接口，不能加入通用处理器白名单。

迁移 `0047_pod_artwork_tasks` 创建 `pod_artwork_tasks` 与 `pod_artwork_task_inputs`。工具、参数、输入版本、校验和、资产域、权利状态和权利来源均不可覆盖。处理输出会创建新的 `DesignVersion`，AI 输出登记为待权利确认资产并进入人工审核，不能直接成为批准版本。普通作图任务拒绝 `customer_provided` 素材；顾客文件只能在订单行上下文中进入来图定制和生产流程。

印花设计的 14 个通用工具共享 `CreativeDesignParameterSnapshotSchema` 与 `CreativeDesignQualityCheckSnapshotSchema`。请求固定工具键、提示词、强度、创意度、比例、数量和 AI 标记；响应逐文件固定输入序号、尺寸、PNG/透明信息、AI 来源与区域、内容安全、文字复核和来源保持，并使用最终提示材料的 SHA-256 防止处理器静默改写提示。AI 工具必须返回种子，`seamless_stitch` 必须是无种子的确定性结果。`licensed_brand_fusion`、`series_design`、`canvas_extend` 与两类连续图还有独立授权、批量、区域及接缝门禁。API 导出会重新解析同一严格快照并拒绝工具漂移或证据缺失。

套图与标题的四个通用工具共享 `ListingAssetParameterSnapshotSchema` 与 `ListingAssetQualityCheckSnapshotSchema`。商品套图、标题草稿、模特试衣和换背景分别固定商品品类/模板、商品事实/关键词/规则版本、模特许可、主体保持；响应按索引返回图片或标题证据。标题字节由 Worker 重新解码和散列，图片技术元数据与 AI 区域逐文件匹配，输入序号并集必须覆盖全部固定素材。只有 `product_suite` 可以隔离失败槽位并进入 `partially_succeeded`，且成功数、失败数和请求数必须对账；其余工具任何部分结果均失败关闭。导出再次解析工具、事实、身份、安全、许可和逐项证据。

## 治理、检索和模板 API

迁移 `0048_pod_governance` 增加配方版本、资产关系、权利评估、视觉指纹、个性化模板、SKU 模板绑定、Listing 素材绑定、生产清单和不可变导出。迁移 `0049_personalization_template_source_inspections` 增加 PNG/PSD 模板源检查、固定解析结果和模板版本到检查记录的唯一关系；`0051_imported_template_inspection_insert_guard` 阻止检查生成的模板绕过确认入口。迁移 `0052_order_personalization_batches` 增加订单个性化批次、逐行项目、加密槽位解析和终态不可变约束。迁移 `0053_order_personalization_render_tasks` 增加渲染任务并固定批次项目、设计任务、参数、请求校验和、处理器来源、质量检查和结果版本；`0054_order_asset_domain` 独立加入订单私有 `order` 资产域，确保已执行过早期 `0053` 的环境也会前向升级；`0055_personalization_template_clone_lineage` 固定组织模板副本的源版本并把该关系纳入不可变触发器；`0056_order_personalization_creative_tools` 将合照与宠物换装加入订单渲染数据库白名单。所有表启用并强制 PostgreSQL RLS；版本内容、终态检查、终态批次、渲染输入和已完成导出由数据库触发器阻止覆盖。

| 路由 | 权限 | 说明 |
| --- | --- | --- |
| `GET/POST /v1/pod/recipes` | `design:read` / `design:write` | 读取或创建固定参数、模型策略和提示词版本的作图配方 |
| `GET /v1/pod/rights-assessments/:assetId`、`POST /v1/pod/rights-assessments` | `design:read` / `design:review` | 保存法律风险、视觉相似度和证据；两者分开呈现 |
| `POST /v1/pod/visual-fingerprints` | `design:write` | 为固定资产版本登记校验和与感知哈希 |
| `POST /v1/pod/visual-search` | `design:read` | 在租户内按资产域执行精确或感知哈希检索 |
| `GET /v1/pod/trace/assets/:assetId` | `design:read` | 反查素材、任务、衍生、Listing 与生产关系 |
| `GET /v1/pod/listing-options` | `design:read` | 返回 Listing 版本、已通过权利与设计双重审核的素材及最近槽位绑定 |
| `GET /v1/pod/listing-artifacts/:listingVersionId`、`POST /v1/pod/listing-artifacts` | `design:read` / `design:write` | 绑定已审核的标题或图片到 Listing 版本槽位 |
| `GET/POST /v1/pod/personalization-templates` | `design:read` / `design:write` | 创建不可覆盖模板版本及图片、文字、装饰、背景四类槽位 |
| `POST /v1/pod/personalization-templates/:id/clone` | `design:write` | 将当前租户已批准模板复制为新的独立草稿，并固定源模板版本、画布、槽位及授权素材引用 |
| `GET/POST /v1/pod/personalization-template-source-inspections` | `design:read` / `design:write` | 读取检查历史，或为固定授权 PNG/PSD 资产版本创建异步检查 |
| `GET /v1/pod/personalization-template-source-inspections/:id` | `design:read` | 读取状态、画布、槽位建议、解析警告和固定解析器版本 |
| `POST /v1/pod/personalization-template-source-inspections/:id/confirm` | `design:write` | 确认警告和四类槽位；服务端合并固定几何后创建唯一模板版本 |
| `GET /v1/pod/personalization-options` | `design:read` | 返回可绑定 SKU 与排除顾客订单素材后的授权模板源文件 |
| `POST /v1/pod/personalization-templates/:id/review` | `design:review` | 审核模板版本；批准版本才可绑定 SKU |
| `GET /v1/pod/template-bindings/:skuId`、`POST /v1/pod/template-bindings` | `design:read` / `design:write` | 显式绑定 SKU、尺寸、模板版本和顾客字段映射 |
| `GET /v1/pod/order-personalization-batches/options` | `order:read` + `design:read` | 返回 PII 安全的订单行候选、固定版本标识和稳定阻断原因，不解密顾客文字、留言或文件引用 |
| `GET /v1/pod/order-personalization-batches`、`GET /v1/pod/order-personalization-batches/:id` | `order:read` + `design:read` | 返回当前租户批次与逐行安全摘要，不返回顾客值或加密解析内容 |
| `POST /v1/pod/order-personalization-batches` | `order:write` + `order:pii:read` + `design:write` | 以 UUIDv7 幂等键创建 1–100 行订单个性化准备批次 |
| `GET /v1/pod/order-personalization-render-tasks`、`GET /v1/pod/order-personalization-render-tasks/:id` | `order:read` + `design:read` | 返回 PII 安全的渲染状态、模型来源、稳定诊断和结果设计版本 ID |
| `POST /v1/pod/order-personalization-render-tasks` | `order:write` + `order:pii:read` + `design:write` | 从成功准备项目创建幂等的图片合成、合照、宠物换装或履约合成任务 |
| `GET/POST /v1/pod/production-manifests` | `design:read` / `design:write` | 创建固定生产文件、尺寸、颜色与质量检查清单 |
| `POST /v1/pod/production-manifests/:id/review` | `design:review` | 审核或驳回生产清单，保留不可变内容 |

Listing 候选必须同时满足：固定资产版本位于授权域、权利状态已批准、不是顾客订单素材，并且该资产作为 `effect` 或 `production` 文件属于已批准的 `DesignVersion`。仅有权利批准但尚未完成设计审核的素材不能绑定。绑定固定到 Listing 版本、内容类型与槽位键，不会覆盖历史 Listing 内容。

模板源检查队列负载只携带 `inspectionId`。Worker 在租户事务内认领检查，重新验证资产版本、校验和、授权域、权利状态和来源类型，再通过私有对象存储读取源字节。单文件限制为 128 MiB；PSD 限制 5000 图层和 500 个候选槽位。解析器读取 PNG 头、物理分辨率，以及 PSD 的长度分段、图层记录、Unicode 名称、文字标记和 `lsct` 分组，不执行 PSD 内容、字体或脚本。解析错误和资源上限以稳定诊断码失败关闭。

同名模板槽位会获得相同 `reuseLabel`，解析器要求它们复用同一顾客字段；不同组的槽位不能静默复用字段。PSD 槽位必须分类为 `image`、`text`、`decoration`、`background` 四组之一。解析警告必须显式确认，槽位几何由服务器使用检查快照合并，不能由确认请求篡改。顾客姓名、图片与留言只在订单 PII 私有域和任务执行内存中解析，不进入普通资产检索或日志。

订单个性化批次固定订单、订单行、不可变定制版本和 SKU 模板绑定。候选接口在租户事务内读取最近订单行、最新定制版本、目录 SKU、下单时有效绑定和已批准模板，只返回外部订单标识、商品标题、数量、SKU、模板、完整度及稳定阻断码。它不读取 `encryptedValues`、顾客文件对象键或解析密文；同一订单行存在多个尺寸绑定时由运营人员显式选择一个。API 在入队前验证这些标识全部属于当前租户，队列 `order-personalization-batch` 只携带 `batchId`。Worker 使用与 API 相同的独立 `ORDER_PII_ENCRYPTION_KEY`，仅在执行内存中解密定制字段，验证订单状态、下单时有效绑定、已批准模板、锁定字段类型及已扫描提升到 `order` 域的顾客文件，再把槽位解析重新加密写入订单私有批次表。v2 解析快照固定顾客文件资产 ID、版本、SHA-256 和媒体类型。API、作业参数、日志、审计和稳定错误诊断均不返回原始文字、留言、图片对象键或解析密文。

操作台支持用 CSV 批量选择候选订单行。文件只允许 `external_order_id`、`external_line_id` 和可选 `size_label` 三列，在浏览器本地解析且不上传原文件；出现姓名、留言或其他未知列时拒绝整表。尺寸列用于消除同一订单行多个模板的歧义。有效行进入受控复选框，未匹配、阻断、重复、格式错误和缺少尺寸的行只显示行号与稳定诊断，不回显原始单元格；部分有效行可以继续提交，服务端仍按既有 UUIDv7 幂等请求和租户事务重新验证全部标识。

一个批次最多 100 行；业务校验按行失败隔离，结果为 `completed`、`partially_succeeded` 或 `failed`。成功项固定模板版本、解析槽位数和加密快照的 SHA-256，不公开顾客明文的确定性摘要；终态批次和项目不可覆盖。当前解析器对同一字段多份已提升文件失败关闭，直到后续版本定义可审计的多文件顺序。

渲染队列 `order-personalization-render` 只携带 `renderTaskId`。Worker 在校验加密快照 SHA-256 后才解密，重新验证订单范围、批准模板、顾客文件版本/字节/权利证据和可选授权模板源，再调用独立订单处理器。请求不包含租户、订单或顾客身份标识；处理器只收到完成任务所需的模板、解析槽位、顾客值和文件字节。输出必须符合工具格式、角色、尺寸、颜色、透明通道、AI 推断开关、模型来源和字节上限，否则失败关闭。

`group_photo` 和 `pet_outfit` 还必须固定严格身份保持、使用全部顾客图片和明确 AI 同意。合照至少需要两份不同顾客图片，每个输出的质量证据必须逐文件匹配全部输入槽位，并确认人物数量一致、没有新增或重复人物。宠物换装必须逐文件确认宠物身份、毛色斑纹和体型保持，同时确认参考宠物身份没有迁移。处理器返回的额外自由字段会被丢弃，只保存这些 PII 安全的槽位键和审核证据。

创意工具的 `qualityCheckSnapshot.outputChecks` 必须为每个输出文件返回同名 `fileName` 和完整 `usedInputStableKeys`。合照检查项还要返回 `identityPreserved: true`、`subjectCountMatched: true`、`noAddedSubjects: true`、`duplicateSubjectsDetected: false`；宠物换装检查项还要返回 `identityPreserved: true`、`referenceIdentityTransferred: false`、`coatPatternPreserved: true`、`bodyShapePreserved: true`。顶层 `passed` 必须为 `true`。

渲染输出保存在 `order` 域，登记 `customer_provided` 待确认权利评估并创建待审核 `DesignVersion`。订单资产读取同时要求 `asset:read` 与 `order:pii:read`；它们不能进入视觉指纹、公共素材关系图、Listing 候选或普通 POD 导出。只有权利评估批准且设计人工审核通过后，履约结果才可显式进入 `ProductionManifest`。

## 独立画图设计与帆布画批量套图 API

两个工作台共享 `design:read`、`design:write`、`design:review` 权限与租户
RLS，但保持独立入口和输入边界。顶级页面 `/creative-designs` 接受 SKU 前的
1–50 条创意需求，每条 1–4 个候选；`/pod-workbench/mockup-batches` 只消费
已批准且已绑定 SKU 的正式设计版本。CSV 固定列为 `row_key`、`name`、
`prompt`、`negative_prompt`、`reference_asset_ids`、`candidate_count`、
`print_spec_version_ids`，原文件只在浏览器本地解析。

`/pod-workbench/batch-designs` 仅作为兼容地址跳转到 `/creative-designs`；服务端
仍复用 `/v1/pod/design-batches` 等版本化接口和同一资产、审核与租户边界，
不会建立第二套创意数据模型。

| 路由组 | 权限 | 关键门禁 |
| --- | --- | --- |
| `GET/POST /v1/pod/design-batches` 与详情、取消、逐项重试、候选选择 | `design:read` / `design:write` | 参考图必须是授权域且权利已批准；研究、竞品、订单私有素材阻断；提交输入不可覆盖 |
| `POST /v1/pod/creative-design-versions/:id/review` | `design:review` | 母版和全部必需画幅一次审核；AI 扩图区域保留标记 |
| `POST /v1/pod/creative-design-versions/:id/sku-bindings` | `design:write` | 所有 SKU/规格兼容检查通过后，才以受控服务创建已批准正式设计版本 |
| `GET/POST /v1/pod/print-specs` 与规格审核 | `design:read` / `design:write` / `design:review` | 物理尺寸必须在声明画幅比例 2% 内；已审核版本不可修改 |
| `GET/POST /v1/pod/mockup-template-inspections` 与确认 | `design:read` / `design:write` / `design:review` | PSD v1、RGB 8 位、受控根组、单嵌入栅格智能对象、资源上限、黄金图 SSIM ≥ 0.99 |
| `GET/POST /v1/pod/mockup-template-packs` 与审核 | `design:read` / `design:write` / `design:review` | 1–16 个已确认编译槽位，固定平台、语言、`canvas_art` 和兼容规格 |
| `GET/POST /v1/pod/mockup-batches` 与详情、取消、槽位重试、矩阵审核 | `design:read` / `design:write` / `design:review` | 一个批准模板包，最多 50 个正式设计；每槽位独立版本和错误 |
| `POST /v1/pod/mockup-batches/:id/listing-bindings` | `design:write` | 逐款事务，必需槽位齐套且输出已批准；调用方显式选择 Listing 版本和槽位，不创建或发布 Listing |

候选生成、画幅适配、模板编译和套图渲染分别进入
`creative-design`、`creative-design-adaptation`、
`mockup-template-compile`、`mockup-render`。幂等校验固定输入资产版本与
SHA-256、规格版本、模板编译校验值和处理策略版本。单候选或单槽位失败
不会删除成功结果，重试只创建新尝试。套图输出保留正式设计、创意审批、
模板检查/模板包和源资产血缘；批准后才成为 Listing 图片候选，标题仍由
原有独立工具处理。

仓库内 `packages/mockup-renderer` 用 `ag-psd` 编译受控 PSD、Sharp 处理
栅格与元数据、ImageMagick 7 参数数组执行透视变换。每次渲染使用隔离临时
目录并设置资源与输出限制，不执行脚本、链接智能对象、外部资源、可替换
文字或不可复现效果。

## 审核后不可变导出

| 路由 | 权限 | 说明 |
| --- | --- | --- |
| `POST /v1/pod/tasks/:taskId/exports` | `design:review` | 对已批准任务和已批准结果版本创建异步 ZIP 导出 |
| `GET /v1/pod/tasks/:taskId/exports` | `design:read` | 读取该任务的导出历史及封包状态 |
| `GET /v1/pod/exports/:id` | `design:read` | 读取一个导出快照 |
| `POST /v1/pod/exports/:id/read-url` | `asset:read` | 为已完成导出签发 10 分钟私有下载地址 |

导出队列同样只携带导出 ID。Worker 在租户事务内重新读取任务、批准版本、文件、权利状态和校验和；任一文件不属于 `authorized` 域、未获权利批准或字节校验和变化即失败关闭。ZIP 内包含确定性的 `manifest.json` 与固定文件路径，完成后对象键、校验和、大小和清单不可变。

## 处理器部署门槛

以下变量必须同时配置，工具才会从 `implementation_active` 切换为 `enabled`：

- `POD_PROCESSOR_URL`：处理器 HTTPS 地址；仅本机回环地址允许 HTTP。
- `POD_PROCESSOR_API_KEY`：处理器专用凭证，不得写入日志或前端变量。
- `POD_PROCESSOR_DEPLOYMENT_ID`：可审计的处理器部署标识。
- `POD_ENABLED_TOOLS`：逗号分隔的已接入通用工具白名单；订单上下文工具不在允许集合内。
- `POD_PROCESSOR_MAX_OUTPUT_BYTES`：单个结果允许的最大字节数，默认 50 MiB。

订单上下文渲染使用完全独立的配置，四项缺一时 Worker 不注册该队列处理器，API 也拒绝创建新任务：

- `POD_ORDER_PROCESSOR_URL`
- `POD_ORDER_PROCESSOR_API_KEY`
- `POD_ORDER_PROCESSOR_DEPLOYMENT_ID`
- `POD_ORDER_ENABLED_TOOLS`：只允许 `image_composite`、`group_photo`、`pet_outfit`、`fulfillment_composite`、`vector_fulfillment`
- `POD_ORDER_PROCESSOR_MAX_OUTPUT_BYTES`：单个订单结果字节上限，默认 50 MiB

该处理器接收订单 PII，必须使用独立凭证、受控网络出口、经过审查的数据处理协议和禁止保留/训练策略，不能与普通通用 POD 处理器混用。

Worker 向处理器发送固定参数及素材字节，不发送租户 ID。处理器必须返回模型键、模型版本、可选种子、质量检查、是否部分成功和结果文件。图片、视频与矢量结果还必须包含尺寸、色彩模式、透明通道和 AI 推断范围；ZIP/文本封装结果可以不声明视觉尺寸，但必须由质量检查和后续不可变清单描述包内容。远程明文 HTTP、URL 内嵌凭证、空结果、超限结果、缺少模型来源或缺少必要技术元数据都会失败关闭。

`piece_compose` 使用额外的失败关闭协议。请求固定 `pieceKeys` 与输入资产顺序、画布尺寸/单位/DPI/色彩、定位模板、适应方式、自动或手动计划、最低 DPI、间距和旋转开关。手动计划每行格式为 `pieceKey,x,y,rotation,scale`，必须完整且唯一覆盖全部裁片。响应只能包含 production PNG/TIFF/ZIP 且 `aiInference=none`；质量快照必须声明通过、无重叠/越界/空白，并为每个裁片返回输入序号、位置、尺寸、方向、缩放、有效 DPI、印刷区域与缝线证据，同时逐文件覆盖全部输出与裁片键。额外字段、部分成功、输入/输出遗漏、手动位置漂移或技术元数据不符均以稳定 `PIECE_LAYOUT_*` 诊断终止。

`piece_extract` 同样使用严格生产协议。请求必须且只能固定一份授权源素材，并提供分版/合版模式、对应边界来源、唯一裁片定义、生产画布、缝份、输出格式/透明度、置信度阈值和模板草稿名称。处理器返回完整画布、逐裁片文件和模板 ZIP，并在严格质量快照中给出闭合区域、坐标、方向、翻转、置信度和文件映射。Worker 重新计算低置信度人工确认、画布范围、格式/DPI/色彩/透明度以及完整文件覆盖；失败使用稳定的 `PIECE_EXTRACT_*` 终止错误。模板草稿只能进入人工确认，不能自动成为可生产模板。

`uv_layers` 固定单一授权源素材、生产画布、分层方式、供应商通道配置和唯一有序图层定义。处理器只能返回全画布透明 PNG/TIFF 与 ZIP，每层必须声明来源像素、冲突像素和稳定文件映射，并提供合成预览。质量快照中的冲突必须包含范围、原因、候选图层和置信度；Worker 重新核对画布、通道顺序、透明度、候选键和逐文件覆盖，异常以稳定 `UV_LAYERS_*` 终止。冲突结果可以进入人工处理队列，但保持 `exportReady=false`；`PodExportService` 会再次解析严格快照并拒绝导出，只有创建冲突为零的新版本才能继续。

`product_video` 使用严格单文件协议。请求必须固定 1–20 张授权域图片及 5–60 秒时长、镜头模板、画幅、720p/1080p、24/25/30 FPS、转场、循环、字幕、音轨许可、AI 运动同意和始终开启的安全区。处理器只能返回一份 `video/mp4` effect 文件，技术元数据必须声明像素尺寸、RGB、非透明、时长、帧率、H.264 和 AAC/无音轨，文件必须具有 MP4 `ftyp` 容器标记。严格质量快照逐文件列出全部输入序号，并确认播放、空白/损坏帧、字幕溢出、音频削波、许可与 AI 证据；Worker 重新计算参数和输入覆盖，部分成功、额外输出或任何漂移均以稳定 `PRODUCT_VIDEO_*` 诊断失败关闭。

`pattern_crop` 固定 1–100 张授权域 PNG/JPEG/WebP/TIFF 输入、裁剪模式、单图/多图、每图 1–8 个结果上限、PNG/JPEG、背景、透视校正、留白和结果标签。质量快照为每个输出返回输入序号、从 0 连续递增的裁剪序号、归一化源图范围、输出尺寸、透明状态和完整性。Worker 拒绝部分结果，重新核对全部输入覆盖、裁剪数上限、唯一文件映射、格式/扩展名、RGB 像素元数据和零生成式推断，异常使用稳定 `PATTERN_CROP_*` 诊断。

`print_extract` 固定 1–100 张授权域栅格输入、专项/全能/透明底、商品场景、校正强度、遮挡恢复、格式/背景和最低完整度；透明底只能是透明 PNG。每个输入必须且只能映射一个输出，质量快照记录透视、形变、裁剪覆盖、完整度，以及每个 AI 推断矩形的原因、置信度和 `marked=true`。Worker 逐文件核对尺寸、RGB、透明通道、输入序号、最低完整度、`aiInference=partial|none` 和技术元数据中的推断矩形；未授权的补全、漏标、部分成功或区域漂移以稳定 `PRINT_EXTRACT_*` 诊断失败关闭。两类提取任务即使人工批准，导出前仍会再次解析严格快照。

图案处理的 `background_remove`、`super_resolution`、`outpaint`、`crop_compress`、`vectorize` 与 `authorized_watermark_remove` 共享逐输入失败关闭协议：固定 1–100 张授权域栅格输入，每个输入恰好映射一个 effect 文件和一个唯一序号质量记录。Worker 重新核对格式、扩展名、像素宽高、DPI、色彩、透明通道和 AI 区域；一键抠图固定透明 PNG 并保持源尺寸，超分必须严格满足 2×/4×且把全图新增细节标为 AI 增强，扩图和授权去水印必须逐矩形标记生成/修复区域，裁剪压缩必须与固定尺寸和 alpha 计划一致。SVG/EPS 矢量结果还需路径数与闭合证据；SVG 字节会拒绝脚本、外部引用、`javascript:`、`DOCTYPE`、`ENTITY` 和远程资源。任何部分结果、文件映射漂移、漏标或不安全矢量以稳定 `PATTERN_PROCESSING_*` 或工具专用诊断终止。批准后导出仍会重新解析严格快照、核对工具键、唯一输入序号、生成区域和矢量路径证据。

`rights_risk_scan` 固定 1–100 张研究域或授权域栅格输入、基础/深度、Amazon/Etsy 范围、视觉相似度开关、补充检查词和 1–90 天有效期。处理器每个输入只能返回一份 `text/plain` JSON 证据文件；严格质量快照逐项记录法律风险、置信度、规则命中、证据来源/时间/可访问性、视觉相似度、数据源与规则版本、模型版本、检查时间和失效时间，并固定 `auxiliary_non_legal_opinion` 声明。Worker 重新解析 JSON 文件、核对全部输入序号、报告有效期和模型，且禁止把视觉相似度混入法律风险。高风险或未知批次状态变为 `blocked`；高风险源素材权利状态变为 `rejected`，未知与中风险变为 `unverified`。自动结果为每个输入创建 `RightsAssessment`，证据详情保留在版本化快照中；报告导出会再次阻断高风险、未知和过期快照。任何部分成功、缺源却给出确定结论、文件/证据漂移或不完整模型来源均以稳定 `RIGHTS_RISK_*` 诊断失败关闭。

`vector_fulfillment` 只接受已固定且已批准的 `image/svg+xml` 模板源以及订单加密槽位快照。请求强制 `outputFormat=svg`、模板适配、关闭生成式增强、透明背景、CMYK/专色、物理画布、模板配置、文字转路径、排版模式、镂空、连接桥、最小线宽和路径修复策略。响应只能包含 production 角色 SVG；Worker 拒绝脚本、外部资源、DOCTYPE/ENTITY、嵌入位图、部分成功、画布或 viewBox 漂移，并重新核对全部固定槽位、路径闭合、自交、重复、孤立节点、孔洞方向、边界、线宽、桥宽和修复记录。每个文件必须有且只有一条严格质量证据。创建 SVG `ProductionManifest` 时，API 再次读取该设计版本对应的权威矢量任务快照，验证文件属于该版本并使用权威质量记录，调用方不能用自报 `passed=true` 绕过质量闸门。

## 资产策略

| 策略 | 使用范围 |
| --- | --- |
| `authorized_only` | 自有或授权已批准的设计资产 |
| `risk_evidence_allowed` | 侵权风险检查可同时读取研究证据，但风险证据不能成为结果资产或进入导出 |
| `order_context_only` | 仅在订单权限与订单上下文内读取顾客个性化素材 |

任何生成、补全、改图或生产结果都需要保留输入版本、参数快照、模型与种子，并进入人工审核。竞品研究素材不能被提升到可发布或可生产域。

## 当前交付状态

- 已交付：公共目录契约、七模块工作台、图案裁剪严格输入覆盖/连续裁剪范围/文件映射协议、印花图提取严格校正/完整度/AI 区域标记协议、14 类印花设计严格提示词/输入覆盖/安全/AI 来源/系列与接缝协议及导出再校验、四类套图与标题严格商品事实/身份保持/模特许可/部分槽位/文字文件协议及导出再校验、六类图案处理严格参数/逐输入文件/AI 增强与 SVG 安全协议及导出再校验、侵权检查严格逐素材报告/数据源时效/模型/高风险阻断与视觉相似度分栏协议、POD-1/POD-2 通用任务参数与异步执行边界、商品短视频严格单 MP4/输入覆盖/播放/字幕/音轨许可协议、裁片提取严格区域/文件/模板草稿协议、裁片合成严格排版计划与逐裁片质量阻断、UV 严格通道/冲突/文件协议及导出再阻断、租户隔离任务表、不可变输入和参数快照、结果设计版本、审核联动、治理实体、Listing 素材槽位控制台、空白模板、PNG/PSD 异步源检查、四类槽位确认、同名槽位/SKU 绑定控制台、组织模板复制溯源、订单候选安全 CSV 批量选择、订单私有域批次准备与 v2 加密槽位解析、图片合成/合照/宠物换装/履约图/矢量履约专用渲染边界、创意工具身份质量阻断、订单私有结果和双重审核闸门、生产清单审核台，以及审核后不可变 ZIP 导出。
- 部署后可用：只有列入 `POD_ENABLED_TOOLS` 且处理器环境完整的通用工具会显示“可用”。受控 POD-3 工具仅包括 `product_video`、`piece_extract`、`piece_compose`、`uv_layers`；仓库不附带第三方图像/视频模型或侵权证据提供方。这些工具即使启用也只接受通过上述严格协议的结果。
- 继续实现：POD-3 图形模板编辑器、内置 PSD 像素/蒙版/字体/效果渲染、跨租户公共模板市场、模板槽位文字/颜色/素材引用的批量表格编辑、裁片模板几何编辑和 UV 冲突蒙版编辑器。短视频、裁片、UV 与矢量履约的严格执行边界已经交付，但仓库不附带供应商视频生成、像素识别、排版或蒙版修复引擎，不能据此宣称完整生成算法已经开放。

Amazon/Etsy 发布和订单同步继续使用现有官方授权 API 路径。作图中心不会通过浏览器自动化模拟卖家后台操作。
