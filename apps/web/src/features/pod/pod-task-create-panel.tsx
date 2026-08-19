"use client";

import type { PodTaskInputOptionsView } from "@yummyai/contracts/pod";
import { BadgeCheck, CircleAlert, LoaderCircle, Play, ShieldCheck } from "lucide-react";
import { useActionState, useEffect } from "react";
import { useFormStatus } from "react-dom";

import { createPodArtworkTask, type PodActionState } from "./pod-actions";

const initialState: PodActionState = { message: "", status: "idle" };

export function PodTaskCreatePanel({
  moduleKey,
  options,
  toolLabel,
}: {
  moduleKey: string;
  options: PodTaskInputOptionsView;
  toolLabel: string;
}) {
  const [state, action] = useActionState(createPodArtworkTask, initialState);
  useEffect(() => {
    if (state.taskId) window.location.assign(`/pod-workbench?module=${encodeURIComponent(moduleKey)}&task=${encodeURIComponent(state.taskId)}`);
  }, [moduleKey, state.taskId]);
  const blocked = !options.enabled || !options.skus.length || (options.requiresAssetInput && !options.assets.length);

  return (
    <section className="pod-create-panel" aria-labelledby="pod-create-title">
      <header>
        <div><p>ASYNC TASK</p><h3 id="pod-create-title">新建{toolLabel}任务</h3></div>
        <span><ShieldCheck size={14} />输入版本与参数将被固定</span>
      </header>
      {blocked ? (
        <p className="pod-create-blocked"><CircleAlert size={15} />{blockReason(options)}</p>
      ) : (
        <form action={action}>
          <input name="toolKey" type="hidden" value={options.toolKey} />
          <div className="pod-create-fields">
            <label><span>关联 SKU *</span><select name="skuId" required>{options.skus.map((sku) => <option key={sku.id} value={sku.id}>{sku.code} · {sku.productName}</option>)}</select></label>
            <label><span>任务标题 *</span><input defaultValue={`${toolLabel} · ${options.skus[0]!.code}`} maxLength={160} name="title" required /></label>
          </div>
          <fieldset className="pod-asset-picker">
            <legend>输入素材 {options.requiresAssetInput ? "*" : "（可选）"}</legend>
            <div>{options.assets.map((asset, index) => (
              <label key={asset.id}>
                <input defaultChecked={options.requiresAssetInput && index === 0} name="inputAssetIds" type="checkbox" value={asset.id} />
                <span><strong>{asset.fileName}</strong><small>{asset.domain === "authorized" ? "授权域" : "研究域"} · V{asset.version} · {asset.mediaType}</small></span>
                <code>{asset.checksumSha256.slice(0, 10)}</code>
              </label>
            ))}</div>
          </fieldset>
          <ToolParameters toolKey={options.toolKey} />
          <footer><ActionNotice state={state} /><SubmitButton /></footer>
        </form>
      )}
    </section>
  );
}

function ToolParameters({ toolKey }: { toolKey: PodTaskInputOptionsView["toolKey"] }) {
  switch (toolKey) {
    case "pattern_crop": return <div className="pod-parameter-fields pod-parameter-grid">
      <input name="perspectiveCorrection" type="hidden" value="on" />
      <Select name="mode" label="裁剪模式" options={[["general","通用"],["metal_sign","铁皮画"],["decorative_art","装饰画"]]} />
      <Check name="multiCrop" label="同一输入识别多个图案" />
      <NumberField max={8} min={1} name="maximumCropsPerInput" label="每张图最多裁剪数" value={1} />
      <Select name="outputFormat" label="输出格式" options={[["png","PNG"],["jpeg","JPEG"]]} />
      <Select name="background" label="输出背景" options={[["preserved","保留原背景"],["transparent","透明底"],["white","白底"]]} />
      <NumberField max={20} min={0} name="cropPaddingPercent" label="裁剪留白 %" value={2} />
      <label><span>结果标签</span><input maxLength={80} name="resultLabel" placeholder="例如 front-print" /></label>
      <p>透视校正固定开启；输出会逐图记录源图范围、裁剪序号和文件映射。</p>
    </div>;
    case "print_extract": return <div className="pod-parameter-fields pod-parameter-grid">
      <input name="markInferredAreas" type="hidden" value="on" />
      <Select name="mode" label="提取模式" options={[["specialized","专项提取"],["all_purpose","全能提取"],["transparent","透明底提取"]]} />
      <Select name="targetScenario" label="商品场景" options={[["auto","自动识别"],["apparel","服饰"],["phone_case","手机壳"],["cup","杯子"],["home_textile","家纺"],["clock","挂钟"],["wind_chime","风铃"],["tablecloth","桌布"],["other","其他"]]} />
      <Select name="correctionStrength" label="校正强度" options={[["standard","标准"],["strong","强力"]]} />
      <Check name="restoreOccludedAreas" label="推断补全遮挡/褶皱缺失区域" defaultChecked />
      <Select name="outputFormat" label="输出格式" options={[["png","PNG"],["jpeg","JPEG"]]} />
      <Select name="outputBackground" label="输出背景" options={[["original","保留底色"],["transparent","透明底"]]} />
      <NumberField max={100} min={50} name="minimumCompleteness" label="最低完整度 %" value={90} />
      <p>透视、褶皱和弯曲校正始终检查；AI 推断补全区域必须在结果证据中明确标记。</p>
    </div>;
    case "background_remove": return <div className="pod-parameter-fields pod-parameter-grid">
      <input name="outputFormat" type="hidden" value="png" />
      <Check name="edgeRefinement" label="细化毛发与复杂边缘" defaultChecked />
      <Check name="preserveShadow" label="保留商品自然阴影" />
      <p>固定输出透明 PNG；每张输入只生成一张结果，并校验边缘、尺寸与透明通道。</p>
    </div>;
    case "super_resolution": return <div className="pod-parameter-fields pod-parameter-grid">
      <Select name="scale" label="放大倍数" options={[['2','2 倍'],['4','4 倍']]} />
      <NumberField max={1200} min={72} name="dpi" label="目标 DPI" value={300} />
      <NumberField max={100} min={0} name="denoise" label="降噪 0–100" value={20} />
      <NumberField max={100} min={0} name="sharpen" label="锐化 0–100" value={15} />
      <Select name="outputFormat" label="输出格式" options={[['png','PNG'],['jpeg','JPEG'],['webp','WebP'],['tiff','TIFF']]} />
      <p>输出尺寸必须严格等于源图的 2 倍或 4 倍；新增细节按全图 AI 增强证据记录并进入人工审核。</p>
    </div>;
    case "outpaint": return <div className="pod-parameter-fields pod-parameter-grid">
      <input name="markGeneratedAreas" type="hidden" value="on" />
      <Select name="aspectRatio" label="目标比例" options={[['1:1','1:1'],['4:5','4:5'],['3:4','3:4'],['16:9','16:9']]} />
      <Select name="direction" label="延展方向" options={[['all','四周'],['horizontal','横向'],['vertical','纵向']]} />
      <Select name="outputFormat" label="输出格式" options={[['png','PNG'],['jpeg','JPEG']]} />
      <label><span>延展说明</span><textarea maxLength={8000} name="prompt" placeholder="可选：说明希望延续的背景、光线或纹理" rows={3} /></label>
      <p>AI 延展区域会固定写入结果证据并在审核界面标记，不可关闭。</p>
    </div>;
    case "crop_compress": return <div className="pod-parameter-fields pod-parameter-grid">
      <NumberField max={30000} min={1} name="width" label="宽度 px" value={3000} />
      <NumberField max={30000} min={1} name="height" label="高度 px" value={3000} />
      <NumberField max={100} min={1} name="quality" label="质量" value={90} />
      <NumberField max={1200} min={72} name="dpi" label="DPI" value={300} />
      <Select name="format" label="格式" options={[['png','PNG'],['jpeg','JPEG'],['webp','WebP'],['tiff','TIFF']]} />
      <Select name="colorSpace" label="色彩" options={[['rgb','RGB'],['cmyk','CMYK']]} />
      <Check name="preserveTransparency" label="保留透明通道（JPEG 不支持）" defaultChecked />
    </div>;
    case "vectorize": return <div className="pod-parameter-fields pod-parameter-grid">
      <Select name="format" label="矢量格式" options={[['svg','SVG'],['eps','EPS']]} />
      <NumberField max={256} min={1} name="colorCount" label="颜色数量" value={16} />
      <Select name="colorMode" label="颜色模式" options={[['rgb','RGB'],['spot','专色']]} />
      <Check name="smoothing" label="路径平滑" defaultChecked />
      <Check name="closePaths" label="闭合可闭合路径" defaultChecked />
      <p>SVG/EPS 会执行路径闭合与外部引用安全检查；不接受脚本、远程图片或可执行内容。</p>
    </div>;
    case "authorized_watermark_remove": return <div className="pod-parameter-fields pod-parameter-grid">
      <input name="markInferredAreas" type="hidden" value="on" />
      <label><span>处理区域 *</span><input maxLength={500} name="regionDescription" required /></label>
      <Select name="outputFormat" label="输出格式" options={[['png','PNG'],['jpeg','JPEG']]} />
      <Check name="rightsAttested" label="我确认素材为自有或已获得去水印授权" required />
      <p>仅处理自有或已授权素材；修复区域作为 AI 推断区域保存并进入人工审核。</p>
    </div>;
    case "rights_risk_scan": return <div className="pod-parameter-fields pod-parameter-grid">
      <Select name="depth" label="检查深度" options={[['basic','基础过滤'],['deep','深度检查']]} />
      <Select name="marketplaceScope" label="适用平台" options={[['amazon_etsy','Amazon + Etsy'],['amazon','仅 Amazon'],['etsy','仅 Etsy']]} />
      <NumberField max={90} min={1} name="validityDays" label="报告有效期（天）" value={30} />
      <Check name="visualSimilarity" label="同时计算视觉相似度（与法律风险分开呈现）" defaultChecked />
      <label><span>补充检查词（每行一项）</span><textarea maxLength={8000} name="searchTerms" placeholder="商品标题、图案文字、品牌或角色线索" rows={4} /></label>
      <p>报告只作辅助判断，不是法律意见；高风险与数据源缺失会阻断后续生成和导出，中低风险仍需人工复核。</p>
    </div>;
    case "text_to_image": return <CreativeParameters promptRequired />;
    case "licensed_brand_fusion": return <div className="pod-parameter-fields"><CreativeParameters /><label><span>许可证明引用 *</span><input maxLength={500} name="licenseReference" required /></label><Check name="rightsAttested" label="我确认品牌/IP 元素在许可范围内" required /></div>;
    case "series_design": return <div className="pod-parameter-fields"><CreativeParameters /><label><span>系列提示词（每行一条）*</span><textarea maxLength={8000} name="batchPrompts" placeholder="主图主题\n副图主题\n配对图主题" required rows={4} /></label></div>;
    case "product_suite": return <div className="pod-parameter-fields"><ListingParameters /><Select name="productCategory" label="商品品类" options={[["apparel","服装"],["phone_case","手机壳"]]} /><Select name="suiteTemplate" label="套图模板" options={[["standard","标准套图"],["lifestyle","场景套图"],["detail","细节套图"]]} /><p>商品身份、结构、印花位置和已确认商品事实均为强制质量门禁；单个槽位失败会形成可追溯的部分成功。</p></div>;
    case "title_draft": return <div className="pod-parameter-fields"><ListingParameters /><label><span>已确认商品事实 *</span><textarea maxLength={8000} name="productFacts" placeholder="只填写 SKU 目录或审核资料中已确认的材质、颜色、结构和用途" required rows={4} /></label><label><span>关键词约束（每行一项）</span><textarea maxLength={8000} name="keywordConstraints" rows={3} /></label><label><span>平台规则版本 *</span><input defaultValue="listing-rules-2026-08" maxLength={160} name="platformRuleVersion" required /></label><p>每条标题保存字符数、UTF-8 字节数、事实来源、关键词来源和商标风险检查，并强制人工文字审核。</p></div>;
    case "virtual_try_on": return <div className="pod-parameter-fields"><ListingParameters /><label><span>模特与场景要求 *</span><textarea maxLength={8000} name="prompt" required rows={3} /></label><label><span>模特资产许可证明 *</span><input maxLength={500} name="modelLicenseReference" required /></label><Select name="aspectRatio" label="画面比例" options={[["4:5","4:5"],["3:4","3:4"],["1:1","1:1"]]} /><p>服装版型、颜色、印花位置和模特许可均需逐文件校验；结果明确披露 AI 合成。</p></div>;
    case "background_replace": return <div className="pod-parameter-fields"><ListingParameters /><label><span>背景描述 *</span><textarea maxLength={8000} name="prompt" required rows={3} /></label><Check name="preserveSubject" label="严格保留商品主体" defaultChecked required /><Select name="aspectRatio" label="画面比例" options={[["1:1","1:1"],["4:5","4:5"],["3:4","3:4"]]} /><p>处理器只能改变背景；商品结构、颜色、印花、文字和接触关系必须保持并进入人工审核。</p></div>;
    case "product_video": return <div className="pod-parameter-fields pod-parameter-grid">
      <input name="safeArea" type="hidden" value="on" />
      <NumberField max={60} min={5} name="durationSeconds" label="时长（秒）" value={15} />
      <Select name="shotTemplate" label="镜头模板" options={[["product_focus","商品聚焦"],["lifestyle","生活方式"],["detail","细节展示"]]} />
      <Select name="aspectRatio" label="画幅" options={[["9:16","9:16"],["1:1","1:1"],["4:5","4:5"],["16:9","16:9"]]} />
      <Select name="resolution" label="分辨率" options={[["1080p","1080p"],["720p","720p"]]} />
      <Select name="fps" label="帧率" options={[["30","30 FPS"],["25","25 FPS"],["24","24 FPS"]]} />
      <Select name="transition" label="转场" options={[["cut","直接切换"],["fade","淡入淡出"],["slide","滑动"]]} />
      <Select name="captionMode" label="字幕" options={[["off","关闭"],["product_title","使用商品标题"],["custom","自定义"]]} />
      <label><span>自定义字幕（选择自定义时必填）</span><input maxLength={500} name="captionText" /></label>
      <Select name="soundtrackMode" label="音轨" options={[["none","无音轨"],["licensed","许可音轨"]]} />
      <label><span>音轨许可证明（使用许可音轨时必填）</span><input maxLength={500} name="soundtrackLicenseReference" /></label>
      <Check name="soundtrackRightsAttested" label="我确认音轨许可覆盖本次商品视频" />
      <Check name="loop" label="首尾循环" />
      <Check name="allowAiMotion" label="允许 AI 生成商品运动（结果将明确标记）" />
      <p>安全区检查固定开启；仅接受 1–20 张已授权商品图片，输出固定为 H.264 MP4。</p>
    </div>;
    case "piece_extract": return <div className="pod-parameter-fields pod-parameter-grid"><Select name="extractionMode" label="提取模式" options={[["separate","分版（推荐）"],["combined","合版"]]} /><Select name="boundarySource" label="边界来源" options={[["alpha","透明通道"],["dark_line","深色裁片线"]]} /><label><span>裁片定义（每行 稳定键|名称|角度|翻转）*</span><textarea defaultValue={"front|前片|0|none\nback|后片|0|none"} maxLength={8000} name="pieceDefinitions" required rows={3} /></label><label><span>印刷区域说明 *</span><input defaultValue="裁片边界内缩缝份后为印刷区域" maxLength={500} name="printArea" required /></label><NumberField name="seamAllowanceMm" label="缝份 mm" value={10} /><Select name="outputFormat" label="裁片格式" options={[["png","PNG"],["tiff","TIFF"],["jpeg","JPEG（仅合版）"]]} /><Check name="preserveTransparency" label="保留透明通道" defaultChecked /><NumberField name="minimumConfidence" label="最低置信度 %" value={90} /><label><span>定位模板草稿名称 *</span><input defaultValue="裁片定位模板草稿" maxLength={160} name="templateDraftName" required /></label><ProductionFields /></div>;
    case "piece_compose": return <div className="pod-parameter-fields pod-parameter-grid"><label><span>定位模板引用 *</span><input maxLength={500} name="positioningTemplate" required /></label><label><span>裁片键（与已选素材顺序一致）*</span><input defaultValue="piece-1" maxLength={8000} name="pieceKeys" required /></label><Select name="fitMode" label="适配方式" options={[["contain","等比包含"],["cover","等比填充"],["stretch","拉伸"]]} /><Select name="layoutMode" label="排版方式" options={[["automatic","自动排版"],["manual","手动排版"]]} /><NumberField name="minimumDpi" label="最低有效 DPI" value={300} /><NumberField name="gapMm" label="裁片间距 mm" value={5} /><Check name="allowRotation" label="允许 90° 旋转" /><label><span>手动位置（每行 key,x,y,角度,缩放）</span><textarea maxLength={8000} name="manualPlacements" rows={3} /></label><ProductionFields /></div>;
    case "uv_layers": return <div className="pod-parameter-fields pod-parameter-grid"><Select name="separationMode" label="分层方式" options={[["automatic","自动识别"],["rule_based","按通道规则"]]} /><label><span>图层前缀 *</span><input defaultValue="uv" maxLength={80} name="layerPrefix" required /></label><label><span>供应商通道配置 *</span><input defaultValue="supplier-uv-v1" maxLength={500} name="supplierChannelProfile" required /></label><label><span>图层定义（每行 稳定键|名称|通道|顺序|透明度）*</span><textarea defaultValue={"artwork|彩墨层|color|0|1\nwhite|白墨层|white_ink|1|1\nvarnish|光油层|varnish|2|1"} maxLength={8000} name="layerDefinitions" required rows={4} /></label><Select name="outputFormat" label="图层格式" options={[["png","PNG"],["tiff","TIFF"]]} /><Check name="whiteInkLayer" label="生成白墨层" defaultChecked /><Check name="varnishLayer" label="生成光油层" defaultChecked /><p>透明通道、合成预览和冲突人工复核始终启用。</p><ProductionFields /></div>;
    case "seamless_pattern":
    case "seamless_stitch": return <div className="pod-parameter-fields pod-parameter-grid"><Select name="repeatType" label="连续方式" options={[["four_way","四方连续"],["two_way","二方连续"]]} /><NumberField max={100} min={0} name="referenceStrength" label="参考强度 0-100" value={70} /><NumberField max={16} min={1} name="outputCount" label="生成数量" value={4} /><p>每个结果固定生成平铺预览，并校验水平/垂直接缝；连续图拼接只重复单元，不拉伸内容。</p></div>;
    case "canvas_extend": return <div className="pod-parameter-fields pod-parameter-grid"><Select name="aspectRatio" label="目标比例" options={[["1:1","1:1"],["4:5","4:5"],["3:4","3:4"],["16:9","16:9"]]} /><NumberField max={16} min={1} name="outputCount" label="生成数量" value={1} /><label><span>延展说明</span><textarea maxLength={8000} name="prompt" rows={3} /></label><p>原图区域保持可追溯，所有 AI 延展区域必须逐矩形标记并进入人工审核。</p></div>;
    case "design_variation":
    case "product_print_variation":
    case "instruction_edit":
    case "element_fusion":
    case "style_reference":
    case "style_transfer":
    case "print_composite":
    case "meme_print": return <CreativeParameters />;
  }
}

function CreativeParameters({ promptRequired = false }: { promptRequired?: boolean }) {
  return <><label><span>提示词{promptRequired ? " *" : ""}</span><textarea maxLength={8000} name="prompt" required={promptRequired} rows={3} /></label><NumberField max={100} min={0} name="referenceStrength" label="参考强度 0-100" value={70} /><NumberField max={100} min={0} name="creativity" label="创意程度 0-100" value={50} /><Select name="aspectRatio" label="画面比例" options={[["1:1","1:1"],["4:5","4:5"],["3:4","3:4"],["16:9","16:9"]]} /><NumberField max={16} min={1} name="outputCount" label="生成数量" value={4} /><p>输出固定保留最终提示哈希、模型、种子、输入序号和 AI 标记；检测到文字时必须人工复核。</p></>;
}

function ListingParameters() {
  return <><Select name="platform" label="目标平台" options={[["amazon","Amazon"],["etsy","Etsy"]]} /><Select name="locale" label="语言/站点" options={[["en-US","English (US)"],["en-GB","English (UK)"],["de-DE","Deutsch"]]} /><NumberField max={16} min={1} name="outputCount" label="候选数量" value={4} /></>;
}

function ProductionFields() {
  return <><NumberField name="width" label="生产宽度" value={300} /><NumberField name="height" label="生产高度" value={400} /><Select name="unit" label="尺寸单位" options={[["mm","mm"],["in","inch"],["px","px"]]} /><NumberField name="dpi" label="DPI" value={300} /><Select name="colorMode" label="色彩模式" options={[["cmyk","CMYK"],["rgb","RGB"],["grayscale","灰度"],["spot","专色"]]} /></>;
}

function Select({ label, name, options }: { label: string; name: string; options: Array<[string, string]> }) { return <label><span>{label}</span><select name={name}>{options.map(([value, text]) => <option key={value} value={value}>{text}</option>)}</select></label>; }
function NumberField({ label, max, min, name, value }: { label: string; max?: number; min?: number; name: string; value: number }) { return <label><span>{label}</span><input defaultValue={value} max={max} min={min} name={name} required type="number" /></label>; }
function Check({ label, name, required = false, defaultChecked = false }: { label: string; name: string; required?: boolean; defaultChecked?: boolean }) { return <label className="pod-check"><input defaultChecked={defaultChecked} name={name} required={required} type="checkbox" /><span>{label}</span></label>; }
function SubmitButton() { const { pending } = useFormStatus(); return <button disabled={pending} type="submit">{pending ? <LoaderCircle className="spin" size={15} /> : <Play size={15} />}{pending ? "正在提交" : "创建异步任务"}</button>; }
function ActionNotice({ state }: { state: PodActionState }) { if (state.status === "idle") return null; return <p className={`pod-action-notice ${state.status}`} role="status">{state.status === "success" ? <BadgeCheck size={14} /> : <CircleAlert size={14} />}{state.message}</p>; }
function blockReason(options: PodTaskInputOptionsView) { if (!options.enabled) return "该工具尚未连接已验证的处理器部署。"; if (!options.skus.length) return "没有可关联的 SKU，请先完成产品立项。"; return "没有符合当前工具资产策略的素材。"; }
