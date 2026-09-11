# 创意画布工作流验收

日期：2026-09-09。范围：本地场景模板工作台、原版插件 1.1.0、审核后继续与生产工艺底稿关联。本记录是功能验收，不是 P0 发布或 CI 候选认证。

## 实际行为

- 四个模板入口与最近项目；一个流程只显示一个项目，历史步骤仍可打开。
- 原版 Infinite Canvas 上实际显示相连的流程步骤、需求和参考图；没有改写宿主源码、内部 store、SDK 类型或官方镜像。
- 原版插件单张回传、批量两图回传、重复提交、刷新后的图片持久化均使用真实页面验证。
- ERP 直接展示受认证保护的缩略预览；可放大、按状态筛选、勾选批准或带原因退回。模拟一次预览 503 后，可点击重试恢复真实图片。
- 当前步骤所有方案审核完成后才允许继续；只带入勾选的已批准原图，已退回方案不进入下一步。
- 生产关联实际创建独立项目、复制底稿工艺参数、经扫描后导入图案，打开生产编辑器可读取新图层；原底稿不改动，新稿工艺确认和审核状态全部重置。
- 1600 px 桌面、768/390/375 px 小屏检查通过；小屏用下拉切换项目，无横向溢出。测试覆盖浅色、深色和 reduced-motion，图片对话框支持 Escape 关闭。
- 保留插件 1.0.0 单张回传兼容；从旧版提交重试到 1.1.0 时返回相同版本，不重写原来源。
- 截图复查发现 reduced-motion 的全局微时长过渡会让主题切换时的继承文字延后更新。工作台范围已关闭该过渡，并改用主题链接色；补查 375 px 浅深切换、深色刷新、真实预览加载和 1600 px 桌面均通过，已更新截图。

## 检查结果

| 检查 | 结果 |
| --- | --- |
| `pnpm test` | 15 个工作区任务通过，含规则与工具测试 |
| `pnpm typecheck` | 15 个工作区任务通过 |
| `pnpm build` | Web、独立插件、扩展构建通过 |
| Canvas Bridge 集成 | 9 项通过：租户隔离、权利、固定素材、并发重试、限制、流程闸门、升级重放与生产补偿 |
| 生产编辑器 + 创意 SKU promotion 集成 | 17 项通过；与 Bridge 合计 26 项 |
| 原版插件单元 | 4 项通过 |
| 工作台模型 / BFF / 窗口连接单元 | 10 项通过 |
| 画布与导航 E2E | 合计 16 项通过；随后修改小屏和预览重试后，2 项画布 E2E 再次通过 |
| 修改范围 ESLint | 通过 |
| `pnpm lint` | 失败：3 个既有 artifacts 资料生成脚本共 23 项错误，不在本次修改范围 |
| Drizzle 元数据检查 | 通过；0066、0067 迁移已应用 |
| 冻结锁文件离线校验 | 通过 |
| `git diff --check` | 通过 |

全仓 lint 的既有报错位于 `artifacts/etsy-photo-acrylic-cake-topper-01A-listing-draft/system/build-and-validate.mjs`、`artifacts/etsy-photo-acrylic-cake-topper-launch-package/system/generate-package.mjs`、`artifacts/yummyai-amazon-custom-a01-product-package/system/generate-amazon-custom-package.ts`，涉及未使用变量、Node 全局声明和类型导入规则。

## 截图与运行

截图保存在 `output/canvas-workflow-acceptance-2026-09-09/`：

- `canvas-template-start.png`
- `canvas-template-start-dark.png`
- `canvas-review-desktop.png`
- `canvas-production-linked.png`
- `canvas-workflow-mobile.png`
- `original-canvas-plugin.png`

测试使用独立浏览器上下文、真实 API/数据库/私有存储/扫描服务、真实原版画布和合成 PNG。未调用付费 AI，未使用买家文件。合成项目以 `E2E Canvas` / `E2E Workflow` 开头保留，不是实际工厂底稿。

原版仍为 `v0.18.0`，镜像摘要 `sha256:94955fb7aa90626e2240b0577c64be5c7685100fc7870592cbbc84e9fd785b8c`，容器健康。SDK 类型文件 SHA-256 仍为 `755010eeb2e53bcbbd96e02899d266b74ef177fcb6473466bdde05bad4c67257`。

ERP 的本地入口仍为 `http://127.0.0.1:3000/creative-designs/canvas`，原版画布为 `127.0.0.1:4175`。多人公网用户会话、任意算法流程编辑、自动生图、订单 SKU 自动映射和完整工艺模板库不属于本次验收。已通过母版仍须经过生产作图的实际尺寸确认、人工审核和预检后才能送印。
