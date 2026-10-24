# 创作原件检查、送审与画布隔离

2026-10-24 · PRD1.1.120 · c14d7a62 · B18/B29/B32 局部实施规格

本轮从固定 Infinite Canvas v0.20.0、现有 Studio/CanvasBridge 拥有者、ClamAV、私有存储和本人会话协议继续建设。源码审计发现目录填造零尺寸、画布切换缺所属栅栏、个人送审依赖错误权限并在失败后换提交键、独立桥接首次原稿未扫描。以下要求已完成本批定向实现和验收并采用本机日用schema187/adapter2.3.0，最终证据见[本片进度](../project-control/STUDIO_ORIGINAL_PROGRESS_20261024.md)。上一套R6完整配对保留；真实付费和普通Worker关闭。完整平台与后文未完成范围继续实施。

## 原件事实

共享契约增加 `asset.inspect`，地址仍为本人 scope/namespace/key，返回原entry ID/revision、asset ID/version、SHA256、MIME、实际字节数、原权利来源，以及技术检查结果。图片分别记录编码宽高、显示宽高和EXIF orientation；视频分别记录编码/显示尺寸、旋转和容器时长；音频记录容器时长。未知、解析不支持及检查失败明确呈现，不能填0或采用缩略图、客户端文档/节点尺寸作为原件事实。

检查在原授权拥有者内执行：短事务查当前会员∩caller、原项目、素材域及原pin → 有上限读取/实际hash和大小核对、现有扫描器、媒体检查 → 新事务复核相同entry/asset/object/version及当前权限。失败也先复核权限，再返回有限诊断；不泄露撤权后的metadata。原件不旋转、不重编码、不改历史版本，不将新的技术检查补作旧扫描或权利批准记录。

图片复用现有sharp完整静态图解码；音视频采用固定版本Mediabunny的内存源/容器解析，有20MiB文件、轨道/packet数、尺寸/时长和执行时限。只读本地已取得字节，不允许URL/HLS外部取流；解析器在可终止的受限worker中运行。容器/packet检查不冒充codec完整解码或制造质量合格。保持上游MPL-2.0源和许可证，不修改第三方源。依赖添加和锁文件仅由主agent使用既有pnpm处理。

新上传、旧素材首次检查、`reference.attach` 和桥接首次候选原稿共用适当的检查/扫描。参考关联在I/O后重查再落库；桥接幂等旧回执不得因重复扫描或重新编码改变，首次实际提交前仍须扫描和后续当前权利核验。视频/音频的伪magic bytes和截断文件不得作为已完整媒体通过。

`assets`保留原薄目录协议。目录逐文件按可见内容懒读原件信息，限制并发和取消；一个坏文件不能令整个目录失败。旧客户端数值仅为展示缓存；新服务端原pin投影替换缓存，缺投影时显示未知。插入、预览及送审核对同一原件，不能把缩略图尺寸传播为画布原图尺寸。

## 个人项目方案送审

增加独立的 `result.submit.pinned` 和只读 `result.lookup`。固定提交包括 scope、submissionId、原key、标题、来源说明/权利确认，以及上述原entry/asset/version/SHA/MIME/大小/来源pin。新个人workspace公布 `originalHandoffVersion:1`；新前端只在该能力存在时启用新操作。生产个人transport拒绝旧的无pin `result.submit` 并给明确升级错误；原独立插件按其已有完整原字节协议继续，由同一Bridge拥有者处理。

送审复用原Bridge的幂等、4方案上限、当前项目/资料/素材权利、不可变原稿、candidate/version和`pending_review`，不创建第二套批准或生产状态。新增只读lookup按原project/submissionId和完整原输入核对原candidate/原申请人，返回missing或准确原回执；更换原稿或来源不能冒充同一请求。恢复不要求当前key仍指向旧图，但原固定素材/版本及当前读取权必须成立。

前端分别提供参考素材审核和项目方案送审。提交权限独立于DesignReview，owned/licensed/ai_generated图片均沿原owner送方案；已批准参考图也可作为方案，视频/音频和未分配空间给明确限制。素材批准、方案批准和生产放行继续分开。

提交意图复用本人Studio `app_state` 的持久CAS和不可变revision历史，固定key为`erp-result-v1:<entryId>:<revision>`，保存严格校验的原提交输入和回执状态。先确证原意图已持久化，再首次提交。传输结果未知后保留原id/原输入，只读lookup并展示恢复状态；刷新/重新登录恢复同一本人scope的原意图，不自动重发POST、不换新id。允许明确按原输入/原id重试，由原Bridge并发幂等兜底；missing本身不能宣称从未提交。已确认原意图的修改须明确新动作并保留旧revision，不能静默覆盖待核对意图。本人/项目/CLEAR/撤权围栏适用于意图保存、恢复、回执和所有迟到正文。

## 画布生命周期

保持vendor184文件原字节。通过自有adapter及严格源码锚点，为每个canvas ID隔离挂载/restore epoch/保存所属ID；新B不能保存旧A节点、连接或viewport，旧A异步媒体不能回填B。单纯React key不能替代全局store、晚restore和autosave归属检查。

媒体显示用的临时Blob地址与文档原字段分离。恢复时记录字段原值及是否存在，覆盖节点content、变体images和会话引用；全局store保存前投影回原字段，不能将恢复A时的临时地址随B的整体保存写回A。新插入及原生图片/文件存储沿稳定storageKey持久化，旧内嵌data URI逐字保留。媒体租约结束时撤销临时地址与映射。

原件检查按scope、authority、协议和能力构造稳定工作区身份；等价通知不重置检查，显式刷新使用独立代次。宿主权限复核在同一上下文最多一次在途读取和一次合并补查，完成即清除控制器及截止计时器；CLEAR、撤权或卸载立即取消在途读取并清除补查。真实身份、素材ID或MIME改变仍隔离迟到结果。

有效历史viewport按原值恢复；缺失或无效viewport使用有限默认值且不能在恢复完成前自动保存空白覆盖。增加明确“显示全部”动作，沿原nodeBounds/viewport计算，不覆盖用户已保存视图或把居中100%改称适应全部。五工具同本人同scope保留同一会话，换canvas只隔离画布生命周期。

## 验证与未完成范围

复用disposable current187本人夹具、真实RLS/S3/ClamAV和封存runtime。用合成PNG/JPEG orientation、视频/音频、伪/截断媒体检查原件事实和字节不变；在读取/扫描/存储后撤权均拒绝关联/返回。验证个人submit有而review无、手工图/已批准图送审、实际已提交丢回执→刷新→只读原回执、同键并发唯一和改变pin冲突。

真实编译页验证非默认viewport保存/刷新、延迟A→新建B不串稿、五工具及1440/390控件；只补本轮必要检查，不重复累计旧3浏览器/8API。个人`/invoke`成功状态沿原200，失回执按实际成功响应测试，不伪造201。source/runtime/契约配对、备份恢复及本批资源和raw文件清理全部完成后才考虑日用采用。`document.attach`整文档跨scope复制、完整批量与付费恢复、真实制造质量及工厂接受继续按完整蓝图实施，不用本轮替代C01—C08完整验收。

本轮自有adapter版本为2.3.0，固定vendor v0.20.0原184文件与原commit/逐文件hash保持。旧独立Canvas插件仍沿其1.1.0/v0.18.0兼容协议，两种版本不混为同一上游版本。继续项目仅复制编辑文档及媒体，不复制`erp-result-v1:`原项目动作意图；旧回执和原不可变历史仍留原scope。

开源解析依据为[Mediabunny读取媒体文档](https://mediabunny.dev/guide/reading-media-files)与[上游源](https://github.com/Vanilagy/mediabunny)。本项目固定1.62.1/MPL-2.0及其两个类型依赖；固定依赖内原许可证随独立源码依赖图保留。容器解析能力、解码能力及质量验收分别陈述。
