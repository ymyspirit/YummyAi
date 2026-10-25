# 单张图片报价与原请求恢复

当前发布范围为单张图片，真实付费默认关闭。图片报价是运营填写的预估与预算预留，不代表服务商实际账单或扣款硬上限。视频、多图与旧直接生成入口继续关闭。

## 用户操作

在生图工作台打开“单张生图与费用”。管理员可读取并明确保存组织月预算、默认任务预留上限及图片任务上限；在模型配置中维护每张预估美元金额、预留金额和报价依据。没有有效报价与预算时页面解释缺项，不自动填零或无限额度。

编辑图片输入并准备报价后，服务器保存不可变的本人原请求与五分钟报价。准备不预留预算、不排队、不调用模型。逐项核对参数与金额并明确勾选后才允许提交。暂停期间可以保留和取消准备，提交由API与Worker分别拒绝。

提交同时固定生成任务、预算账本和Creative Execution。网络中断后只读取原编号；刷新页面从服务器本人索引及本地原编号恢复。输入、模型选型、权限或参考图变化使原报价不能提交。取消只作用于尚未提交的准备；未知提交不能靠换编号或自动重试解决。

生成结果以私有原字节及资产版本登记，默认未审核。原件检查、权利审核、提交项目方案、业务审核及生产编辑分别执行。采用原响应的任务还显示独立采用回执，原执行的失败或待核对状态、费用与预算历史继续保留。

## 契约和边界

- `pod/studio-paid-image`、`pod/studio-image-budget`和`ai/studio-image-pricing`是共享契约。金额分别按8位预估与6位预留精度校验。
- 本人Studio RPC提供`paid.image.prepare/commit/lookup/requests/cancel/abandon`及预算`get/save`，全部经当前OIDC会话及context authority核对；错误、迟到正文和私有预览都再次核对当前身份。
- `creative_studio_image_requests`保存原输入、标准化输入、报价及生成关联；`creative_studio_image_cancellations`是不可变的原键取消事实。相同本人原编号只能对应同一份输入。
- API和Worker都要求`STUDIO_PAID_IMAGE_ENABLED=1`且租户出现在精确`STUDIO_PAID_IMAGE_TENANT_IDS`中；空值和通配符不构成准入。当前日用值保持关闭，不能用开发验收替代真实付费启用授权。
- Worker核对数据库中的完整报价、双侧身份、原输入、模型路由、参考图和账本预留。UTC月份变化在实际提交前再核对预算，未知费用继续保留占用。

## 受控套图

销售方案的视觉交付保留四槽：图稿、场景、细节、定制说明。每槽使用同一单张报价与原键恢复机制。固定槽项目映射、商品方案版本、真实非AI样品、模型、尺寸、质量、背景、单次上限和整组预算；其余三槽额外固定同组已经人工审核的唯一图稿。

新增REST入口位于`v1/sales-plans/:id/launch/visuals/:groupId`：`POST images/prepare|commit|cancel|abandon`，`GET images`，`GET images/by-request/:requestId`及只读的`POST prepare-original`。共享请求在`catalog/product-visual-generation`。成功回执带当前context authority，个人恢复索引只返回本人原记录。

套图报价包含完整`visualDelivery`，输入指纹覆盖`{input, visualDelivery}`。提交重新核对来源与额度，Worker也核对真实槽项目及已审图稿。每槽最多四个真实尝试，每人最多四个排队或运行的图片任务；预算按原账本的实际预留和记账累计，不能用单次上限伪装实际费用。

原件检查只读取实际原资产和技术信息。页面可直达该槽的“素材与审核”，由运营明确送审；收集结果不会替付费任务自动提交方案或批准图稿。

隔离API套件为`studio-paid-image-integration`、`studio-visual-paid-image-integration`及保留历史的`studio-paid-image-legacy-regression`。浏览器套件`studio-paid-image-browser`使用固定编译候选和一次性OIDC/数据库/存储/Redis，注入的受控模型不产生真实付费。
