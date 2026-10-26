# P2 编译页面的浏览器固定版本

P2 的三组编译页面使用 Playwright 驱动 1.61.1，Windows 与 Linux 均固定
Chromium Headless Shell 157.0.8103.6。Windows 原有完整 payload 锁保持不变。
Linux 驱动自己的 149 registry 与浏览器来源的 157 registry 分别验证，不能混用。

## 采用依据

在同一 Node 24.17.0、Playwright 1.61.1 和同源合成脚本下，Linux 149 的两次
`no-store` 分段流均读到 11 字节 EOF、解析成功，但网络报告 `ERR_ABORTED`，
测试端无法读取原响应。其余四个对照正常。Linux 157 和 Windows 157 各六个
对照均正常结束并可读取原正文。实验没有 ERP、账户、业务数据库或模型调用。

这与 [Playwright #42742](https://github.com/microsoft/playwright/issues/42742)
记载的 Chromium 问题吻合；维护者确认上游 CL8508456 已修复。
版本对照是采用测试浏览器的依据，仍须通过同候选的实际三组编译页面和完整 CI。

## CI 安装与验证

保留原 Playwright 浏览器安装供其他验收使用，随后执行 P2 专用安装步骤。
后面不能再次运行旧版 Playwright 的安装或缓存清理，以免删除其不认识的1251缓存。
安装器仅适用于 Linux x64、Node 24.17.x 的 CI 环境，不接受路径或下载源参数。

- 从固定 npm tarball 验证 SHA512，仅读取 package.json 和 browsers.json，
  不安装或执行 alpha 包代码
- 从固定官方 CFT 地址下载 Linux ZIP，验证固定大小、SHA256、原始中央目录、
  重名、文件类型、展开大小和 CRC 后，核对完整文件集与 ELF
- 使用操作系统账户的默认缓存，已有目录只能精确复核后复用或拒绝，不能覆盖
- 真正启动时再次核对来源、驱动、固定 ELF 字节和实际版本；禁止远程连接、
  系统 channel、浏览器路径及缓存覆盖

安装器只验证安装文件，不能代替浏览器启动或 ERP 验收。三组页面仍核对实际
CDP 版本、原响应完整正文、归属、原任务恢复、未审核边界及隔离资源清理。

GitHub 镜像预设的 CHROME_BIN 仅在这两个 P2 命令的进程范围显式移除；
不修改系统配置或自动审批策略。应用的 `private, no-store`、正文上限、
权限核对、取消语义和所有失败断言继续保留。
