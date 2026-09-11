# ERP 界面更新验收

日期：2026-09-09。范围：现有 Next.js ERP 的显示与导航偏好。本次没有更换业务框架、服务接口、授权方式、数据库或原版 Infinite Canvas。

## 模板选择与实现

选择 [Kiranism / Next Shadcn Dashboard Starter](https://github.com/Kiranism/next-shadcn-dashboard-starter) 作为布局参考，使用现有组件实现中性配色、内嵌工作区、紧凑侧栏和主题切换。项目为 MIT 许可；此次未复制模板业务源码或安装其依赖。现有 React Bits SpotlightCard 保留，用于常用任务和创意模板卡片；许可文件保持原样。

- 共用配色、文字、表单、表格和页面标题尺寸；大量旧的 8–10 px 业务文字提高到至少 12 px。
- 240 px 常规侧栏、76 px 图标侧栏；手机端仍是原有菜单。
- 浅色、深色、跟随系统；刷新及跨页保留偏好，系统变化与跨标签页修改可同步。禁用浏览器存储仍可操作。
- 运营总览去除巨大标题和装饰性英文栏目码；指标与待办采用相同的工作区样式。
- 创意项目列表、步骤、方案和下一步操作层级统一，画布按钮明确说明独立窗口。
- 订单两种视图、报告预览及任务内生产编辑保留。主题不影响生产图像、工艺尺寸、DPI、版本、审核和回传关联。
- 修复工作流标签在 375/390 px 宽度下溢出，保持大型业务表格在自身容器内滚动。

## 本轮验证

- Web 单元测试：55 个文件、251 项通过。
- Web 类型检查：通过。
- 修改的 TS/TSX 文件 ESLint：通过。
- 浏览器 E2E：25 项通过，覆盖主导航、搜索、手机菜单、React Bits、主题与侧栏偏好、订单报告、真实 ZIP 导入与原图、生产编辑、画布插件、方案审核和生产稿接续。
- 浏览器页面巡检：18 个主页面 + 导入视图 + 功能目录，分别检查 1440 px 与 390 px；另检查 6 个深色工作区，共 46 组。无页面横向溢出、无 pageerror。
- Web 生产构建：通过。

页面巡检使用本地实际服务。E2E 保留既有夹具边界：部分概览/产品/刊登页面使用测试配置；订单、原图、生产文件和画布关键流程通过实际本地 API 与基础设施。没有据此宣称线上发布或完整 P0 验收。

## 本地证据

截图与诊断在 `output/ui-modernization-2026-09-09/`，不纳入版本控制。其中包括 `desktop-dashboard.png`、`desktop-creative-canvas.png`、`desktop-products.png`、`mobile-creative-canvas.png`、`dark-overview.png`、`dark-canvas.png`、`compact.png` 和 `page-audit.json`。截图反映当前本地资料；不将测试图案或已有订单预览作为模板自带素材。

命令输出在 `output/ui-modernization-{unit,typecheck,lint,e2e,build,pages}.log`。原有未提交改动保留；未创建发布标签，也未运行完整仓库的发布候选检查。
