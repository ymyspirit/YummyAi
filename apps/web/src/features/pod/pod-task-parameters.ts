export function parsePodTaskParameters(
  toolKey: string,
  formData: FormData,
): { values: Record<string, string | number | boolean | string[]> } | { error: string } {
  const text = (name: string) => podFormValue(formData, name);
  const boolean = (name: string) => formData.get(name) === "on";
  const number = (name: string, minimum: number, maximum: number) => {
    const parsed = Number(text(name));
    return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum ? parsed : undefined;
  };
  switch (toolKey) {
    case "pattern_crop": {
      const maximumCropsPerInput = number("maximumCropsPerInput", 1, 8);
      const cropPaddingPercent = number("cropPaddingPercent", 0, 20);
      if (maximumCropsPerInput === undefined || cropPaddingPercent === undefined)
        return { error: "每张图裁剪数必须为 1–8，裁剪留白必须为 0–20%。" };
      const resultLabel = text("resultLabel");
      return {
        values: {
          mode: text("mode") || "general",
          multiCrop: boolean("multiCrop"),
          maximumCropsPerInput,
          outputFormat: text("outputFormat") || "png",
          background: text("background") || "preserved",
          perspectiveCorrection: true,
          cropPaddingPercent,
          ...(resultLabel ? { resultLabel } : {}),
        },
      };
    }
    case "print_extract": {
      const minimumCompletenessPercent = number("minimumCompleteness", 50, 100);
      if (minimumCompletenessPercent === undefined)
        return { error: "最低完整度必须在 50% 到 100% 之间。" };
      return {
        values: {
          mode: text("mode") || "specialized",
          targetScenario: text("targetScenario") || "auto",
          correctionStrength: text("correctionStrength") || "standard",
          restoreOccludedAreas: boolean("restoreOccludedAreas"),
          markInferredAreas: true,
          outputFormat: text("outputFormat") || "png",
          outputBackground: text("outputBackground") || "original",
          minimumCompleteness: minimumCompletenessPercent / 100,
        },
      };
    }
    case "background_remove":
      return {
        values: {
          edgeRefinement: boolean("edgeRefinement"),
          preserveShadow: boolean("preserveShadow"),
          outputFormat: "png",
        },
      };
    case "super_resolution": {
      const scale = number("scale", 2, 4);
      const dpi = number("dpi", 72, 1200);
      const denoise = number("denoise", 0, 100);
      const sharpen = number("sharpen", 0, 100);
      return scale && dpi && denoise !== undefined && sharpen !== undefined
        ? { values: { scale, dpi, denoise, sharpen, outputFormat: text("outputFormat") || "png" } }
        : { error: "放大倍数、DPI、降噪或锐化超出允许范围。" };
    }
    case "outpaint": {
      const prompt = text("prompt");
      return {
        values: {
          aspectRatio: text("aspectRatio") || "1:1",
          direction: text("direction") || "all",
          ...(prompt ? { prompt } : {}),
          outputFormat: text("outputFormat") || "png",
          markGeneratedAreas: true,
        },
      };
    }
    case "crop_compress": {
      const width = number("width", 1, 30_000);
      const height = number("height", 1, 30_000);
      const quality = number("quality", 1, 100);
      const dpi = number("dpi", 72, 1200);
      return width && height && quality && dpi
        ? {
            values: {
              width,
              height,
              quality,
              dpi,
              format: text("format") || "png",
              colorSpace: text("colorSpace") || "rgb",
              preserveTransparency: boolean("preserveTransparency"),
            },
          }
        : { error: "尺寸、质量或 DPI 超出允许范围。" };
    }
    case "vectorize": {
      const colorCount = number("colorCount", 1, 256);
      return colorCount
        ? {
            values: {
              format: text("format") || "svg",
              colorCount,
              smoothing: boolean("smoothing"),
              closePaths: boolean("closePaths"),
              colorMode: text("colorMode") || "rgb",
            },
          }
        : { error: "颜色数量必须在 1 到 256 之间。" };
    }
    case "authorized_watermark_remove": {
      if (!boolean("rightsAttested"))
        return { error: "必须确认素材为自有或已授权，才能提交去水印任务。" };
      const regionDescription = text("regionDescription");
      if (!regionDescription) return { error: "请描述需要处理的水印区域。" };
      return {
        values: {
          rightsAttested: true,
          regionDescription,
          outputFormat: text("outputFormat") || "png",
          markInferredAreas: true,
        },
      };
    }
    case "rights_risk_scan": {
      const validityDays = number("validityDays", 1, 90);
      if (!validityDays) return { error: "风险报告有效期必须在 1 到 90 天之间。" };
      const marketplaceScope = text("marketplaceScope") || "amazon_etsy";
      const marketplaces =
        marketplaceScope === "amazon"
          ? ["amazon"]
          : marketplaceScope === "etsy"
            ? ["etsy"]
            : ["amazon", "etsy"];
      const searchTerms = text("searchTerms")
        .split(/[\r\n,]+/)
        .map((term) => term.trim())
        .filter(Boolean)
        .slice(0, 50);
      return {
        values: {
          depth: text("depth") || "basic",
          visualSimilarity: boolean("visualSimilarity"),
          marketplaces,
          searchTerms,
          validityDays,
        },
      };
    }
    case "text_to_image":
      return creativeParameters(formData, true, "text_to_image");
    case "licensed_brand_fusion": {
      if (!boolean("rightsAttested")) return { error: "必须确认品牌/IP 元素在许可范围内。" };
      const licenseReference = text("licenseReference");
      if (!licenseReference) return { error: "请填写许可证明引用。" };
      const creative = creativeParameters(formData, false, "licensed_brand_fusion");
      return "error" in creative
        ? creative
        : { values: { ...creative.values, rightsAttested: true, licenseReference } };
    }
    case "series_design": {
      const creative = creativeParameters(formData, false, "series_design");
      if ("error" in creative) return creative;
      const batchPrompts = text("batchPrompts")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(0, 100);
      if (!batchPrompts.length) return { error: "系列图至少需要一条批量提示词。" };
      return { values: { ...creative.values, batchPrompts } };
    }
    case "product_suite": {
      const listing = listingBaseParameters(formData);
      return "error" in listing
        ? listing
        : {
            values: {
              ...listing.values,
              listingTool: "product_suite",
              productCategory: text("productCategory") || "apparel",
              suiteTemplate: text("suiteTemplate") || "standard",
              outputFormat: "png",
              markAiGenerated: true,
              preserveProductIdentity: true,
              factSourcePolicy: "sku_catalog_snapshot",
            },
          };
    }
    case "title_draft": {
      const listing = listingBaseParameters(formData);
      const productFacts = text("productFacts");
      const keywordConstraints = text("keywordConstraints")
        .split(/[\r\n,]+/)
        .map((entry) => entry.trim())
        .filter(Boolean)
        .slice(0, 50);
      const platformRuleVersion = text("platformRuleVersion");
      if ("error" in listing) return listing;
      if (!productFacts || !platformRuleVersion)
        return { error: "请填写已确认商品事实和平台规则版本。" };
      return {
        values: {
          ...listing.values,
          listingTool: "title_draft",
          outputFormat: "txt",
          productFacts,
          keywordConstraints,
          platformRuleVersion,
          requireFactAttribution: true,
          markAiGenerated: true,
        },
      };
    }
    case "virtual_try_on": {
      const listing = listingBaseParameters(formData);
      const prompt = text("prompt");
      const modelLicenseReference = text("modelLicenseReference");
      return !("error" in listing) && prompt && modelLicenseReference
        ? {
            values: {
              ...listing.values,
              listingTool: "virtual_try_on",
              prompt,
              aspectRatio: text("aspectRatio") || "4:5",
              outputFormat: "png",
              modelLicenseReference,
              preserveGarmentIdentity: true,
              discloseAi: true,
              markAiGenerated: true,
            },
          }
        : { error: "请填写模特要求和许可证明，生成数量必须在 1 到 16 之间。" };
    }
    case "background_replace": {
      const listing = listingBaseParameters(formData);
      const prompt = text("prompt");
      return !("error" in listing) && prompt && boolean("preserveSubject")
        ? {
            values: {
              ...listing.values,
              listingTool: "background_replace",
              prompt,
              aspectRatio: text("aspectRatio") || "1:1",
              outputFormat: "png",
              preserveSubject: true,
              generatedBackground: true,
              markAiGenerated: true,
            },
          }
        : { error: "请填写背景描述并启用严格商品主体保持。" };
    }
    case "product_video": {
      const durationSeconds = number("durationSeconds", 5, 60);
      const fps = number("fps", 24, 30);
      const captionMode = text("captionMode") || "off";
      const captionText = text("captionText");
      const soundtrackMode = text("soundtrackMode") || "none";
      const soundtrackLicenseReference = text("soundtrackLicenseReference");
      if (!durationSeconds) return { error: "视频时长必须在 5 到 60 秒之间。" };
      if (![24, 25, 30].includes(fps ?? 0)) return { error: "视频帧率只能选择 24、25 或 30 FPS。" };
      if (captionMode === "custom" && !captionText)
        return { error: "选择自定义字幕时必须填写字幕内容。" };
      if (
        soundtrackMode === "licensed" &&
        (!soundtrackLicenseReference || !boolean("soundtrackRightsAttested"))
      ) {
        return { error: "使用许可音轨时必须填写许可证明并确认授权范围。" };
      }
      return {
        values: {
          durationSeconds,
          shotTemplate: text("shotTemplate") || "product_focus",
          aspectRatio: text("aspectRatio") || "9:16",
          resolution: text("resolution") || "1080p",
          fps: fps!,
          transition: text("transition") || "cut",
          loop: boolean("loop"),
          captionMode,
          ...(captionMode === "custom" ? { captionText } : {}),
          soundtrackMode,
          ...(soundtrackMode === "licensed"
            ? {
                soundtrackLicenseReference,
                soundtrackRightsAttested: true,
              }
            : { soundtrackRightsAttested: false }),
          allowAiMotion: boolean("allowAiMotion"),
          safeArea: true,
        },
      };
    }
    case "piece_extract": {
      const production = productionParameters(formData);
      const pieceDefinitions = text("pieceDefinitions")
        .split(/\r?\n/)
        .map((entry) => entry.trim())
        .filter(Boolean);
      const seamAllowanceMm = number("seamAllowanceMm", 0, 100);
      const minimumConfidencePercent = number("minimumConfidence", 50, 100);
      const printArea = text("printArea");
      const templateDraftName = text("templateDraftName");
      return "error" in production ||
        !pieceDefinitions.length ||
        seamAllowanceMm === undefined ||
        minimumConfidencePercent === undefined ||
        !printArea ||
        !templateDraftName
        ? { error: "请完整填写裁片定义、印刷区域和模板草稿；生产尺寸、DPI、置信度或缝份超出范围。" }
        : {
            values: {
              ...production.values,
              extractionMode: text("extractionMode") || "separate",
              boundarySource: text("boundarySource") || "alpha",
              pieceDefinitions,
              printArea,
              seamAllowanceMm,
              outputFormat: text("outputFormat") || "png",
              preserveTransparency: boolean("preserveTransparency"),
              minimumConfidence: minimumConfidencePercent / 100,
              templateDraftName,
            },
          };
    }
    case "piece_compose": {
      const production = productionParameters(formData);
      const positioningTemplate = text("positioningTemplate");
      const pieceKeys = text("pieceKeys")
        .split(/[\r\n,]+/)
        .map((entry) => entry.trim())
        .filter(Boolean);
      const minimumDpi = number("minimumDpi", 36, 2_400);
      const gapMm = number("gapMm", 0, 1_000);
      const layoutMode = text("layoutMode") || "automatic";
      const manualPlacements = text("manualPlacements")
        .split(/\r?\n/)
        .map((entry) => entry.trim())
        .filter(Boolean);
      return "error" in production ||
        !positioningTemplate ||
        !pieceKeys.length ||
        minimumDpi === undefined ||
        gapMm === undefined
        ? { error: "请填写定位模板和裁片键；生产尺寸、最低 DPI 或间距超出范围。" }
        : {
            values: {
              ...production.values,
              positioningTemplate,
              fitMode: text("fitMode") || "contain",
              layoutMode,
              pieceKeys,
              minimumDpi,
              gapMm,
              allowRotation: boolean("allowRotation"),
              manualPlacements,
            },
          };
    }
    case "uv_layers": {
      const production = productionParameters(formData);
      const layerPrefix = text("layerPrefix");
      const supplierChannelProfile = text("supplierChannelProfile");
      const layerDefinitions = text("layerDefinitions")
        .split(/\r?\n/)
        .map((entry) => entry.trim())
        .filter(Boolean);
      return !("error" in production) &&
        layerPrefix &&
        supplierChannelProfile &&
        layerDefinitions.length
        ? {
            values: {
              ...production.values,
              separationMode: text("separationMode") || "automatic",
              layerPrefix,
              supplierChannelProfile,
              layerDefinitions,
              outputFormat: text("outputFormat") || "png",
              preserveTransparency: true,
              whiteInkLayer: boolean("whiteInkLayer"),
              varnishLayer: boolean("varnishLayer"),
              conflictPolicy: "manual_review",
              compositePreview: true,
            },
          }
        : { error: "请填写图层前缀、供应商通道配置和逐层定义，并检查生产尺寸与 DPI。" };
    }
    case "seamless_pattern":
    case "seamless_stitch": {
      const referenceStrength = number("referenceStrength", 0, 100);
      const outputCount = number("outputCount", 1, 16);
      return referenceStrength !== undefined && outputCount
        ? {
            values: {
              designTool: toolKey,
              prompt: "",
              repeatType: text("repeatType") || "four_way",
              referenceStrength,
              creativity: toolKey === "seamless_stitch" ? 0 : 50,
              aspectRatio: "1:1",
              outputCount,
              outputFormat: "png",
              markAiGenerated: toolKey !== "seamless_stitch",
              markGeneratedAreas: true,
              seamCheckRequired: true,
              tilePreviewRequired: true,
            },
          }
        : { error: "参考强度或生成数量超出范围。" };
    }
    case "canvas_extend": {
      const outputCount = number("outputCount", 1, 16);
      return outputCount
        ? {
            values: {
              designTool: "canvas_extend",
              prompt: text("prompt"),
              referenceStrength: 100,
              creativity: 50,
              aspectRatio: text("aspectRatio") || "1:1",
              outputCount,
              outputFormat: "png",
              markAiGenerated: true,
              markGeneratedAreas: true,
            },
          }
        : { error: "尺寸延展的生成数量必须在 1 到 16 之间。" };
    }
    case "design_variation":
    case "product_print_variation":
    case "instruction_edit":
    case "element_fusion":
    case "style_reference":
    case "style_transfer":
    case "print_composite":
    case "meme_print":
      return creativeParameters(formData, false, toolKey);
    default:
      return { error: "当前工具没有可用参数定义。" };
  }
}

function productionParameters(
  formData: FormData,
): { values: Record<string, string | number> } | { error: string } {
  const width = boundedNumber(formData, "width", 0.01, 100_000);
  const height = boundedNumber(formData, "height", 0.01, 100_000);
  const dpi = boundedNumber(formData, "dpi", 36, 2_400);
  if (width === undefined || height === undefined || dpi === undefined)
    return { error: "生产尺寸或 DPI 超出范围。" };
  return {
    values: {
      width,
      height,
      dpi,
      unit: podFormValue(formData, "unit") || "mm",
      colorMode: podFormValue(formData, "colorMode") || "cmyk",
    },
  };
}

function creativeParameters(
  formData: FormData,
  promptRequired: boolean,
  designTool:
    | "design_variation"
    | "product_print_variation"
    | "instruction_edit"
    | "text_to_image"
    | "element_fusion"
    | "licensed_brand_fusion"
    | "series_design"
    | "style_reference"
    | "style_transfer"
    | "print_composite"
    | "meme_print",
): { values: Record<string, string | number | boolean> } | { error: string } {
  const prompt = podFormValue(formData, "prompt");
  if (promptRequired && !prompt) return { error: "请填写提示词。" };
  const referenceStrength = boundedNumber(formData, "referenceStrength", 0, 100);
  const creativity = boundedNumber(formData, "creativity", 0, 100);
  const outputCount = boundedNumber(formData, "outputCount", 1, 16);
  if (referenceStrength === undefined || creativity === undefined || outputCount === undefined) {
    return { error: "参考强度、创意程度或生成数量超出范围。" };
  }
  return {
    values: {
      designTool,
      prompt,
      referenceStrength,
      creativity,
      aspectRatio: podFormValue(formData, "aspectRatio") || "1:1",
      outputCount,
      outputFormat: "png",
      markAiGenerated: true,
      markGeneratedAreas: true,
    },
  };
}

function listingBaseParameters(
  formData: FormData,
): { values: Record<string, string | number> } | { error: string } {
  const outputCount = boundedNumber(formData, "outputCount", 1, 16);
  if (!outputCount) return { error: "候选数量必须在 1 到 16 之间。" };
  return {
    values: {
      platform: podFormValue(formData, "platform") || "amazon",
      locale: podFormValue(formData, "locale") || "en-US",
      outputCount,
    },
  };
}

function boundedNumber(formData: FormData, name: string, minimum: number, maximum: number) {
  const parsed = Number(podFormValue(formData, name));
  return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum ? parsed : undefined;
}

export function podFormValue(formData: FormData, name: string) {
  const entry = formData.get(name);
  return typeof entry === "string" ? entry.trim() : "";
}
