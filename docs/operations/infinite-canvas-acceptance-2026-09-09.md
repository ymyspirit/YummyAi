# Infinite Canvas 本地接入验收 · 2026-09-09

本次交付是原版画布与 ERP 的本地创作、回传、审核流程。左侧入口为 **创意设计 → 创意画布**，功能搜索和全部功能目录使用同一条导航记录。

## 环境与范围

- Windows 11；Node.js 24.17.0；pnpm 11.10.0。
- 原版 Infinite Canvas `v0.18.0`，官方镜像固定为 `sha256:94955fb7aa90626e2240b0577c64be5c7685100fc7870592cbbc84e9fd785b8c`，仅监听 `127.0.0.1:4175`。
- 自研插件 `1.0.0`、协议 `1`、公开 SDK `0.1.0`；上游源码未修改。SDK 原文件摘要和许可见[运行说明](infinite-canvas.md)。
- 真实本地 API、PostgreSQL、私有对象存储和浏览器，使用自制几何 PNG；没有使用客户订单图片或调用付费生成服务。
- 验收后恢复 ERP Web `3000` 和 API `8000`；原版容器健康。

## 已验证行为

1. 从侧栏进入画布需求页；桌面、手机导航及当前页高亮正确，搜索“画布”能找到入口。
2. 保存需求后刷新 ERP，仍能恢复当前需求；由 ERP 打开原版画布，安装插件并读取需求。
3. 通过原版节点和素材上传界面提交图片，ERP 显示真实预览和待审核版本。
4. 刷新原版项目，图片保留；重复同一提交返回原结果，不产生重复版本。
5. 人工批准创意母版后状态更新；批准素材可以供下一条需求使用，并能再次进入原版画布。
6. 租户隔离、授权素材版本及摘要校验、错误连接来源与版本拒绝、超时、并发去重、最多四个方案和已取消需求拒绝均有自动化覆盖。
7. 已审核版本保持不可变；创意母版还需按产品尺寸与工艺制作生产文件。

## 检查结果

| 检查 | 本次结果 |
| --- | --- |
| `pnpm test:e2e -- canvas-bridge navigation-workspace` | 15 项通过 |
| `pnpm --filter @yummyai/web test` | 53 个文件、253 项通过 |
| 插件单元测试 | 3 项通过 |
| 批量创作契约单元测试 | 5 项通过 |
| `canvas-bridge.integration.test.ts` | 5 项通过 |
| `pod-batch-promotion.integration.test.ts` | 3 项通过 |
| `pnpm typecheck` | 15 个包通过 |
| `pnpm build` | 插件、Web、扩展构建通过 |
| `pnpm check:rules`、Drizzle 元数据检查 | 通过 |
| `pnpm install --frozen-lockfile` | 通过 |
| 本次接入文件的定向 ESLint | 通过 |
| `pnpm lint` | 未通过：已有的三个商品文案产物脚本有错误，见下方 |

全仓库 lint 剩余错误位于以下既有产物脚本，不属于本次画布接入：

- `artifacts/etsy-photo-acrylic-cake-topper-01A-listing-draft/system/build-and-validate.mjs`：未使用变量、未声明 Node 全局。
- `artifacts/etsy-photo-acrylic-cake-topper-launch-package/system/generate-package.mjs`：未使用变量、未声明 Node 全局。
- `artifacts/yummyai-amazon-custom-a01-product-package/system/generate-amazon-custom-package.ts`：未使用变量、禁止的内联 import 类型写法。

原始浏览器截图保存在 `apps/web/test-results/canvas-bridge-original-pin-92103-eturns-reviewed-ERP-results-chromium/`。本次副本保存在仓库忽略目录 `output/infinite-canvas-acceptance-2026-09-09/`：

- `original-canvas-plugin.png`：原版画布和 ERP 节点。
- `erp-approved-master.png`：真实图片预览及人工批准后的创意版本。
- `erp-canvas-desktop.png`、`erp-canvas-mobile.png`：桌面与手机入口和布局。

## 尚未覆盖的上线工作

生产环境的用户会话 BFF 尚未实现，当前连接仅允许本地 loopback；不能直接作为多人公网服务部署。原版浏览器项目没有自动云同步，升级须按[升级与备份步骤](infinite-canvas.md)独立验证。

本次没有进行整套 P0 发布验收、CI 候选提交验证或完整备份恢复演练；工作区包含其他正在进行的功能。本记录不代表发布候选或阶段完成。
