# 原版 Infinite Canvas 运行与升级

## 固定组合

| 项目 | 当前值 |
| --- | --- |
| 上游 | `basketikun/infinite-canvas`，`v0.18.0` |
| 提交 | `d213a74614e0e4bd8a26383d1e1e907249e9c61b` |
| 官方镜像 | `ghcr.io/basketikun/infinite-canvas@sha256:94955fb7aa90626e2240b0577c64be5c7685100fc7870592cbbc84e9fd785b8c` |
| SDK | `0.1.0`，类型原文件无修改 |
| SDK 文件 SHA-256 | `755010eeb2e53bcbbd96e02899d266b74ef177fcb6473466bdde05bad4c67257` |
| 自研节点插件 / 协议 | `1.1.0` / `1` |

ERP 兼容 `1.0.0` 的读取和单张回传，既有插件可继续使用；批量选择和流程节点需要 `1.1.0`。同一提交从旧插件重试到新插件时，返回原有版本，保留最初的来源记录，不重复创建。

固定版本是兼容性边界，不保证上游每次升级都兼容。参考：[固定提交](https://github.com/basketikun/infinite-canvas/tree/d213a74614e0e4bd8a26383d1e1e907249e9c61b)、[公开 SDK](https://github.com/basketikun/infinite-canvas/tree/d213a74614e0e4bd8a26383d1e1e907249e9c61b/plugins/canvas)。

## 启动与使用

先按[本地开发文档](local-development.md)启动 ERP，再运行：

```powershell
pnpm --filter @yummyai/database db:migrate
pnpm canvas:build
pnpm canvas:start
docker compose -f infra/infinite-canvas.compose.yml ps
```

原版容器仅监听 `127.0.0.1:4175`。默认地址为 `http://127.0.0.1:4175/canvas?mode=recent`，服务端变量 `CANVAS_WORKBENCH_URL` 可覆盖。支持 HTTPS 或 loopback HTTP，不接受用户密码或 fragment。使用 `/canvas` 入口时保留 `mode=recent`，以保留连接 query。

1. 从 **创意设计 → 创意画布** 选择业务模板或最近项目，保存需求后点击“打开创意画布”，保留 ERP 页面。
2. 原版顶部点击“节点插件 → 第三方插件”，安装 ERP“画布连接与插件安装”提供的地址，如 `http://127.0.0.1:3000/plugins/yummyai-bridge-1.1.0.js`。
3. 底部“扩展节点”添加“ERP 创作任务”，点击“读取当前需求”，将所选素材加入画布。
4. 使用原版上传、编辑与生成功能。AI 服务需另外配置并由操作者主动调用，ERP 接入验收不调用付费 AI。
5. 完成后“刷新画布图片”，选择图片，填写名称、来源与说明，确认素材权利后提交到 ERP 待审核。勾选“批量回传图片”可选择最多 4 张，逐张保存与报告错误；重复相同提交不会重复创建。
6. 在 ERP 的“方案与审核”查看大图、筛选、勾选并批准/退回；退回必须填写原因。全部审核完成后，选中通过的方案，用“用选中方案继续”建立下一步，再打开画布读取新的需求。
7. 最后一步选择已审核通用工艺底稿，点击“生成生产草稿”，从方案下“打开生产稿”进入。底稿不变，新稿需检查图案摆放、工艺参数和实际尺寸，再审核、预检、导出。没有底稿时点击“配置工艺底稿”，在生产作图创建通用项目并审核当前版本，返回刷新。

原版“Codex 未连接”和 Agent 面板属于另一套智能助手连接，与 ERP 插件无关；无需填写 Codex token。空间不够可收起 Agent 面板，点击左侧 ERP 节点名称定位表单。

ERP 的 `?brief=` 记住当前需求。刷新 ERP、切换需求或连接超时后重新“打开创意画布”，插件刷新后重新“读取当前需求”。原版图片保留在原项目，重复相同提交不会生成另一条结果。超过 4 个方案需新建需求。远程图片未加载或不允许跨源读取时，可在原版上传已获授权的本地文件。

生产 BFF 的用户会话尚未实现，当前不能把本地接入直接部署为多人公网服务，详见[认证边界](../integration/infinite-canvas.md)。

## 更新与回滚

1. 日常保留固定组合，不自动跟随 `main` / `latest`。
2. 升级前在原版项目列表导出完整 ZIP，包含项目和媒体。记录浏览器配置文件及 origin；`localhost` 与 `127.0.0.1` 存储空间不同。ERP 数据库与私有存储另按既有手册备份。
3. 用独立端口和独立浏览器配置文件运行候选官方镜像，导入备份，检查节点、连线、图片、插件数据。只有节点 JSON 不能当作完整备份。
4. 比较新旧公开 SDK、插件生命周期、图片字段、版本字段和项目导入格式；只修改自己的适配器与协议，保持上游源码不变。
5. 更新镜像摘要、`CANVAS_BRIDGE`、SDK 镜像及许可证、插件构建文件名和文档。产物使用新版本文件名，保留旧 bundle 和 manifest。
6. 验证需求及授权图、原版图片持久化、去重、错误版本拒绝、租户隔离、人工审核、完整 ZIP 恢复后再切换入口。
7. 失败时恢复旧 ERP、插件和镜像，在原 origin 的备份浏览器配置文件中恢复升级前 ZIP。新版本写过的数据未必能被旧版打开，回滚不能只换 Docker 标签。

第一版没有自动迁移原版项目、自动跨版本回滚或浏览器项目云同步。上游更新可能要求修改自己的适配器，但不需要维护上游源码补丁。

## 验证

本地功能和导航的实测结果见[2026-09-09 验收记录](infinite-canvas-acceptance-2026-09-09.md)。

场景工作流、批量筛选和生产关联的新增验收见[工作台验收记录](canvas-workflow-acceptance-2026-09-09.md)。

```powershell
pnpm canvas:start
pnpm --filter @yummyai/infinite-canvas-plugin test
pnpm --filter @yummyai/infinite-canvas-plugin typecheck
pnpm --filter @yummyai/web test -- canvas-connection.test.ts canvas-bridge navigation-registry.test.ts erp-sidebar.test.tsx
pnpm --filter @yummyai/api test:integration -- canvas-bridge.integration.test.ts pod-batch-promotion.integration.test.ts
# 先停止本工作区的 Web / API，E2E 会启动自己的真实服务。
pnpm test:e2e -- canvas-bridge navigation-workspace
```

`canvas-bridge.spec.ts` 使用真实 API、数据库、私有存储和 4175 端口的原版画布，上传自制 PNG。没有生成器 demo 或付费模型，合成审核记录以 `E2E Canvas` 开头保留。不得改用真实客户文件。
