# YummyAI Infinite Canvas 节点插件

独立 ESM 插件，宿主为未经修改的官方 Infinite Canvas。入口 `src/index.tsx` 只使用 `vendor/canvas-sdk-types.ts` 的公开 SDK，React 由宿主注入。

```powershell
pnpm --filter @yummyai/infinite-canvas-plugin typecheck
pnpm --filter @yummyai/infinite-canvas-plugin test
pnpm canvas:build
```

在原版“节点插件 → 第三方插件”安装 ERP 提供的 bundle URL。版本和协议记录在 `@yummyai/contracts/pod/canvas-bridge`。生成文件不纳入 Git。

参见[接入文档](../../docs/integration/infinite-canvas.md)、[运行手册](../../docs/operations/infinite-canvas.md)。如果抽离为独立仓库，需要同时版本化共享协议包；不复制或改写宿主源码。
