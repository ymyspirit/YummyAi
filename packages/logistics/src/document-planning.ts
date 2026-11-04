import type { DocumentAdapter, DocumentOrderSource, DocumentOrderPreview, DocumentParcelOverride,
  DocumentRow, FactoryDocumentProfile, ParcelSpecification } from "@yummyai/contracts/logistics/documents";
import { balancedParcel, ceilThree, inches, parcelCarrierChecks, unitWeight } from "./document-parcels.js";
import { normalizeDocumentRegion, yunexpressRecipientProblem } from "./document-address.js";

export function recommendYunexpressChannel(specifications: Array<Pick<ParcelSpecification,"productKind"|"sizeIn">|undefined>):string|null {
  if(!specifications.length||specifications.some(spec=>!spec||spec.productKind==="other"||spec.productKind==="shaped_pillow"&&spec.sizeIn===null))return null;
  return specifications.some(spec=>spec!.productKind==="shaped_pillow"&&spec!.sizeIn!>20)?"ZBZXRPH":"THPHR";
}

/** Receives already-authorized order sources. This function cannot advance any business state. */
export function planOrderDocument(adapter: DocumentAdapter, source: DocumentOrderSource, profile: FactoryDocumentProfile,
  override?: DocumentParcelOverride): DocumentOrderPreview {
  const blockers: string[] = [], notices: string[] = [], a = source.address;
  const result: DocumentOrderPreview = { orderId: source.id, orderNumber: source.orderNumber, blockers, notices, parcel: null, rows: [] };
  const correctRoute = adapter === "yunexpress" ? profile.route === "yunexpress" : profile.route === "printeque";
  if (!correctRoute || adapter === "printeque_factory" && profile.productionAdapter !== "printeque_factory") blockers.push("所选工厂未配置此导单方式");
  if (!profile.destinationCountries.includes(a.countryCode)) blockers.push("收件国家不在此工厂导单配置的适用范围");
  if (!source.lines.length) blockers.push("订单没有可导出的商品");
  const lines: Array<{ line: DocumentOrderSource["lines"][number]; spec: ParcelSpecification }> = [];
  for (const line of source.lines) {
    if (!Number.isSafeInteger(line.quantity) || line.quantity <= 0) { blockers.push("订单商品件数无效"); continue; }
    const spec = profile.specifications.find(value => value.specificationVersionId === line.specificationVersionId);
    if (!spec) blockers.push(`商品 ${line.externalLineId} 的规格尚未关联本工厂包裹参数`);
    else lines.push({ line, spec });
  }
  if (lines.length !== source.lines.length || !lines.length) return result;
  const quantity = lines.reduce((sum, row) => sum + row.line.quantity, 0);
  if (quantity > 10000) { blockers.push("单个包裹超过 10000 件 请拆分核对"); return result; }
  const weightLb = override?.weightLb ?? Number(lines.reduce((sum, row) => sum + unitWeight(row.spec, "lb") * row.line.quantity, 0).toFixed(3));
  const declarationKg = Number(lines.reduce((sum, row) => sum + unitWeight(row.spec, "kg") * row.line.quantity, 0).toFixed(3));
  const weightKg = override?.weightLb === undefined ? declarationKg : ceilThree(override.weightLb * 0.45359237);
  const plan = balancedParcel(lines.map(({ line, spec }) => ({ quantity: line.quantity,
    length: inches(spec.length, spec.dimensionUnit), width: inches(spec.width, spec.dimensionUnit), height: inches(spec.height, spec.dimensionUnit) })));
  const length = override?.lengthIn ?? plan.lengthIn, width = override?.widthIn ?? plan.widthIn, height = override?.heightIn ?? plan.heightIn;
  const checks = parcelCarrierChecks(length, width, height);
  const skus = new Set(lines.map(row => row.spec.supplierSku)), values = new Set(lines.map(row => row.spec.declaredUnitValueMinor));
  const goodsSku = override?.goodsSku ?? (skus.size === 1 ? lines[0]!.spec.supplierSku : "");
  const declared = override?.declaredUnitValueMinor ?? (values.size === 1 ? lines[0]!.spec.declaredUnitValueMinor : null);
  const channel = override?.channelCode ?? recommendYunexpressChannel(lines.map(row=>row.spec)) ?? "THPHR";
  result.parcel = { quantity, weightLb, weightKg, lengthIn: length, widthIn: width, heightIn: height, goodsSku,
    declaredUnitValueMinor: declared, gofo: checks.gofo, usps: checks.usps, channelCode: adapter === "yunexpress" ? channel : null };
  const region = normalizeDocumentRegion(a.region, a.countryCode);
  if (adapter !== "printeque_factory") {
    for (const [label, value] of [["收件人", a.recipient], ["收件地址", a.address1], ["城市", a.city], ["邮编", a.postalCode]] as const)
      if (!value.trim()) blockers.push(`缺少${label} 请到订单地址入口补齐`);
    if (!region.valid) blockers.push("美国州/省无法识别 请在订单地址中填写州全称或两位缩写");
    else if (region.value !== a.region) notices.push(`州/省已规范为 ${region.value}`);
  }
  if (adapter === "printeque_shipping") {
    blockers.push(...checks.blockers);
    if (!goodsSku) blockers.push("整单含不同工厂 SKU 请核对合包商品 SKU");
    if (declared === null) blockers.push("申报单价缺失或同单单价不同 请核对合包申报单价");
    const first = lines[0]!.spec;
    result.rows = [{ "订单号": source.orderNumber, "目的国家": a.countryCode, "收件人姓名": a.recipient,
      "收件人地址1": a.address1, "收件人地址2": a.address2, "城市": a.city, "州/省": region.value,
      "收件人邮编": a.postalCode, "收件人电话": a.phone, "Label备注": source.orderNumber,
      "箱数": 1, "包裹重量": weightLb, "长": length, "宽": width, "高": height, "商品SKU": goodsSku,
      "中文品名": [...new Set(lines.map(row => row.line.specificationName))].join(" / "), "英文品名": first.nameEn,
      "申报单价": declared === null ? null : declared / 100, "数量": quantity, "重量": unitWeight(first, "lb"), "海关编码": first.hsCode }];
  } else if (adapter === "printeque_factory") {
    result.rows = lines.map(({ line, spec }): DocumentRow => {
      if (!spec.supplierSku) blockers.push(`商品 ${line.externalLineId} 缺少工厂 SKU`);
      if (!line.productionFileSku) blockers.push(`商品 ${line.externalLineId} 尚未关联正式生产交付文件`);
      return { order_number: source.orderNumber, parent_sku: spec.supplierSku, sku: line.productionFileSku ?? "",
        size: line.specificationName, weight: Number((unitWeight(spec, "lb") * line.quantity).toFixed(3)), qty: line.quantity,
        tracking_number: "", carrier_channel_provider: profile.carrierProvider, carrier_service: profile.carrierService,
        custom_message: `${source.orderNumber} / ${line.externalLineId}`, origin: profile.originCompany, gift_message: "", factory: profile.factoryCode };
    });
  } else {
    const nameProblem = yunexpressRecipientProblem(a.recipient);
    if (nameProblem) blockers.push(nameProblem);
    if (!profile.useAccountSender) blockers.push("请确认使用云途账户默认发件人后再导出");
    if (lines.some(row => row.spec.productKind === "shaped_pillow" && row.spec.sizeIn === null)) blockers.push("抱枕尺寸尚未确认 无法选择云途渠道");
    if (weightKg < declarationKg) blockers.push("包裹总重不能小于商品申报重量合计");
    const declarations = lines.map(({ spec }) => ({ nameEn: spec.nameEn, nameCn: spec.nameCn,
      value: spec.declaredUnitValueMinor, weight: unitWeight(spec, "kg") }));
    if (new Set(declarations.map(row => JSON.stringify(row))).size !== 1) blockers.push("同单商品的申报品名、单价或单重不同 请先核对申报方案");
    const first = declarations[0]!;
    if (first.value === null) blockers.push("申报单价尚未配置");
    const fullAddress = [a.address1, a.address2].filter(Boolean).join(" ");
    for (const [label, value, limit] of [["收件人姓名", a.recipient, 200], ["收件人地址", fullAddress, 200],
      ["收件人城市", a.city, 100], ["收件人省州", region.value, 100], ["邮编", a.postalCode, 50], ["电话", a.phone, 50]] as const)
      if (value.length > limit) blockers.push(`${label}超过模板允许的 ${limit} 字符`);
    result.rows = [{ "客户订单号": source.orderNumber, "产品代码": channel, "跟踪号": "", "收件人国家": a.countryCode,
      "收件人姓名": a.recipient, "收件人地址": fullAddress, "收件人城市": a.city, "收件人省州": region.value,
      "邮编": a.postalCode, "电话": a.phone, "件数": 1, "包裹总重量": weightKg, "申报币种": "USD",
      "申报品名1": first.nameEn, "中文申报品名1": first.nameCn, "申报数量1": quantity,
      "申报FOB价1": first.value === null ? null : first.value / 100, "申报单重1": first.weight }];
  }
  result.blockers = [...new Set(blockers)];
  return result;
}
