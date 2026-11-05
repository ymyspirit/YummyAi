import { test, expect } from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import type { ChildProcess } from "node:child_process";
import type { AmazonReportBatchView, AmazonReportWorkspaceView, MarketplaceAccountView } from "@yummyai/contracts";
import type ExcelJSType from "../../api/node_modules/exceljs";
import type JSZipType from "../../api/node_modules/jszip";
import type { DocumentExportView, FactoryDocumentProfile } from "@yummyai/contracts/logistics/documents";
import {LogisticsConnectionProfileSchema,type LogisticsAccountView,type LogisticsTaskView} from "@yummyai/contracts/logistics";
import type {FulfillmentFlowView,FulfillmentRouteWorkspace} from "@yummyai/contracts/order/fulfillment-flow";
import type { OrderWorkDetail } from "@yummyai/contracts/order/workspace";
import type { ProductionDeliveryWorkspace, ProductionDeliveryPackageView } from "@yummyai/contracts/order/production-delivery";
import { centerApi } from "./order-centers-fixture";
import { prepareDeliveryOrder } from "./production-delivery-fixture";
import { startProductionEditorWorker } from "./production-editor-fixture";
import { loginErp } from "./erp-identity-fixture";
import {fixture as reviewFixture} from "./order-review-fixture";
const require = createRequire(new URL("../../api/package.json", import.meta.url));
const ExcelJS = require("exceljs") as typeof ExcelJSType, JSZip = require("jszip") as typeof JSZipType;
let worker: ChildProcess | undefined;
test.beforeAll(async () => { worker = await startProductionEditorWorker(); });
test.afterAll(async () => { worker?.kill(); });
test.beforeEach(async ({ page }) => { if (process.env.WEB_AUTH_MODE === "personal") await loginErp(page, "operator", "/logistics"); });
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

test("order documents unifies one review click with design dispatch",async({page})=>{
  const state=await reviewFixture(page,1,{automaticFulfillment:true,currentReadContracts:true});
  await page.goto("/orders");
  await page.getByRole("button",{name:"开始处理订单",exact:true}).click();
  const drawer=page.getByRole("dialog",{name:"整单详情",exact:true});
  await drawer.getByRole("button",{name:"审单通过并开始设计",exact:true}).click();
  await expect.poll(()=>state.records[0]!.line.preparation).toBe("pushed");
  expect(state.saves).toHaveLength(1);expect(state.dispatches).toHaveLength(1);expect(state.unexpectedWrites).toEqual([]);
  await expect(drawer.getByRole("status").filter({hasText:"设计已派发"})).toBeVisible();
});

for(const mode of ["quote","purchase"] as const)test(`order documents unifies reviewed order to ${mode} and keeps templates separate`,async({page},testInfo)=>{
  test.setTimeout(300_000);
  const previous=await centerApi<FulfillmentRouteWorkspace>("fulfillment-flow/routes");
  for(const route of previous.routes.filter(route=>route.profile.name.startsWith("Synthetic flow ")&&route.profile.mode!=="disabled"))
    await centerApi("fulfillment-flow/routes",{id:route.id,expectedVersion:route.version,profile:{...route.profile,mode:"disabled"},idempotencyKey:randomUUID()});
  const order=await prepareDeliveryOrder(2,false,{release:false,originCountry:"US",materialResponsibility:"factory"});
  const detail=await centerApi<OrderWorkDetail>(`order-centers/lines/${order.lines[0]}`),orderId=detail.line.orderId;
  for(const lineId of order.lines){
    const line=await centerApi<OrderWorkDetail>(`order-centers/lines/${lineId}`);
    await centerApi(`order-centers/lines/${lineId}/platform-deadline`,{expectedProjectionVersion:line.line.projectionVersion,shipByAt:new Date(Date.now()+7*86400000).toISOString(),evidenceReference:"Synthetic platform ship-by",idempotencyKey:randomUUID()});
  }
  const profile:FactoryDocumentProfile={name:`Synthetic flow packing ${mode}`,route:"printeque",productionAdapter:"printeque_factory",originCountryCode:"US",destinationCountries:["US"],originCompany:"Synthetic",factoryCode:"SYNTHETIC",carrierProvider:"ShipOS",carrierService:"",useAccountSender:false,evidence:"Synthetic measured packing",
    specifications:[{specificationVersionId:detail.draft.specificationVersionId!,productKind:"shaped_pillow",sizeIn:10,supplierSku:"CP-10",weight:.26,weightUnit:"lb",length:8,width:5,height:5,dimensionUnit:"in",declaredUnitValueMinor:800,nameEn:"Pillow",nameCn:"抱枕",hsCode:""}]};
  const saved=await centerApi<{id:string}>("logistics/documents/profiles",{factoryId:order.factoryId,expectedVersion:0,profile,idempotencyKey:randomUUID()});
  const connectionProfile=LogisticsConnectionProfileSchema.parse({name:`Synthetic ShipOS ${mode}`,provider:"shipos",factoryId:order.factoryId,originCountryCode:"US",baseUrl:process.env.LOGISTICS_TEST_BASE_URL!,
    sender:{name:"Synthetic sender",address1:"Synthetic factory address; not a real business",city:"Synthetic city",region:"CA",postalCode:"00000",countryCode:"US",phone:"1234567890",email:"sender@example.invalid"},
    currency:"USD",currencySource:"Synthetic billing currency",labelHosts:["127.0.0.1"],labelMode:"factory_pull",
    channels:[{code:"fixture",name:"Synthetic ShipOS channel",countryCodes:["US"],transitDaysMin:3,transitDaysMax:5,transitSource:"Synthetic transit calendar",conditionsVerified:true,conditionsEvidence:"Synthetic channel evidence",maxWeightGrams:10000,maxDimensionMm:1000}],
    apiCompatibilityEvidence:"Synthetic local carrier",purchasePermissionEvidence:"Synthetic local purchase only"});
  const connection=await centerApi<{connectionId:string}>("logistics/connections",{expectedVersion:0,profile:connectionProfile,credentials:{provider:"shipos",appKey:"synthetic-appkey",appSecret:"synthetic-secret"},idempotencyKey:randomUUID()});
  await centerApi(`logistics/connections/${connection.connectionId}/verify`,{expectedVersion:1,idempotencyKey:randomUUID()});
  await centerApi("logistics/rules",{connectionId:connection.connectionId,expectedVersion:0,rule:{name:"Synthetic budget",currency:"USD",autoPurchase:true,maxTicketMinor:1000,maxDailyMinor:10000,quoteMaxAgeSeconds:120,allowedChannelCodes:["fixture"],evidence:"Synthetic authorized purchase ceiling"},idempotencyKey:randomUUID()});
  await page.goto("/fulfillment-routes");
  await page.getByRole("button",{name:"新增规则",exact:true}).click();
  await page.getByLabel("规则名称",{exact:true}).fill(`Synthetic flow ${mode}`);
  await page.getByLabel("工厂包裹规则",{exact:true}).selectOption(saved.id);
  await page.getByLabel("物流连接",{exact:true}).selectOption(connection.connectionId);
  await page.getByLabel("制作计划天数",{exact:true}).fill("5");
  await page.getByLabel("审图通过后",{exact:true}).selectOption(mode);
  await page.getByRole("button",{name:"保存规则",exact:true}).click();
  await expect(page.getByRole("status")).toContainText("规则已保存");
  await expect(page.getByRole("cell",{name:`Synthetic flow ${mode}`,exact:false})).toBeVisible();
  await page.screenshot({path:testInfo.outputPath(`flow-rules-${mode}-desktop.png`),fullPage:true});
  await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  await page.screenshot({path:testInfo.outputPath(`flow-rules-${mode}-narrow.png`),fullPage:true});
  await page.setViewportSize({width:1440,height:960});
  // Existing approved orders require an explicit start; saving a rule never backfills them.
  expect((await centerApi<FulfillmentFlowView>(`fulfillment-flow/orders/${orderId}`)).id).toBeNull();
  await centerApi(`fulfillment-flow/orders/${orderId}/resume`,{});
  let flow:FulfillmentFlowView;
  await expect.poll(async()=>{
    flow=await centerApi<FulfillmentFlowView>(`fulfillment-flow/orders/${orderId}`);
    if(flow.stage==="exception"){
      const tasks=await centerApi<{tasks:LogisticsTaskView[]}>(`logistics/tasks?orderId=${orderId}`);
      throw new Error(JSON.stringify({reasons:flow.reasons,tasks:tasks.tasks.map(task=>({status:task.status,diagnostic:task.diagnostic,quotes:task.quotes}))}));
    }
    return mode==="quote"?flow.stage:!!flow.productionExportId;
  },{timeout:150_000,intervals:[1000,3000,5000]}).toBe(mode==="quote"?"paused":true);
  const tasks=await centerApi<{tasks:LogisticsTaskView[]}>(`logistics/tasks?orderId=${orderId}`);
  expect(tasks.tasks).toHaveLength(1);expect(tasks.tasks[0]!.externalReference).toBe(order.externalId);
  expect(tasks.tasks[0]!.status).toBe(mode==="quote"?"quoted":"completed");
  expect(flow!.productionOrderIds).toHaveLength(2);
  if(mode==="purchase"){
    expect(flow!.deliveryPackageIds).toHaveLength(1);
    const exported=await centerApi<{exports:DocumentExportView[]}>(`logistics/documents/exports?orderId=${orderId}`);
    expect(exported.exports).toHaveLength(1);
    const current=await centerApi<OrderWorkDetail>(`order-centers/lines/${order.lines[0]}`);
    await page.goto(`/orders?line=${current.line.id}`);
    const panel=page.getByRole("region",{name:"本单自动履约",exact:true});
    await expect(page.getByRole("button",{name:"刷新整单",exact:true})).toBeEnabled();
    await expect(panel).toBeInViewport();
    await expect(panel.getByRole("link",{name:"下载工厂 ERP 表"})).toBeVisible();
    await expect(panel).toContainText("待提交工厂");
    const downloadPending=page.waitForEvent("download");
    await panel.getByRole("link",{name:"下载工厂 ERP 表"}).click();
    const downloaded=await downloadPending,workbook=new ExcelJS.Workbook();
    await workbook.xlsx.load(Uint8Array.from(await readFile((await downloaded.path())!)).buffer);
    const sheet=workbook.getWorksheet("orders")!,headers=new Map<string,number>();
    sheet.getRow(1).eachCell((cell,index)=>headers.set(String(cell.value),index));
    expect(sheet.rowCount).toBe(3);
    expect([2,3].map(row=>sheet.getCell(row,headers.get("order_number")!).value)).toEqual([order.externalId,order.externalId]);
    const packet=await page.request.get(`/api/order-centers/deliveries/${flow!.deliveryPackageIds[0]}/file`);
    expect(packet.ok()).toBe(true);
    const files=await JSZip.loadAsync(await packet.body());
    expect(Object.keys(files.files).filter(name=>/\.jpg$/i.test(name))).toHaveLength(2);
    await page.screenshot({path:testInfo.outputPath("flow-order-desktop.png"),fullPage:true});
    await page.goto(`/production-files?projectId=${current.line.editorProjectId}`);
    await expect(page.getByRole("heading",{name:"生产文件",exact:true})).toBeVisible();
    await expect(page.getByRole("button",{name:"新建项目",exact:true})).toHaveCount(0);
    await page.goto("/pod-workbench/production-editor?kind=tire_cover");
    await expect(page.getByRole("heading",{name:"工艺底稿",exact:true})).toBeVisible();
    await expect(page).toHaveURL(/\/production-templates\?kind=tire_cover$/);
    await expect(page.getByLabel("产品类型",{exact:true})).toHaveValue("tire_cover");
    await expect(page.getByRole("combobox",{name:"打开工艺底稿",exact:true})).toBeVisible();
    const production=await centerApi<{projects:Array<{id:string}>}>("production-editor/projects?scope=production");
    const templates=await centerApi<{projects:Array<{id:string}>}>("production-editor/projects?scope=templates");
    expect(production.projects.some(project=>project.id===current.line.editorProjectId)).toBe(true);
    expect(templates.projects.some(project=>project.id===current.line.editorProjectId)).toBe(false);
  }
});
test("order documents configures carrier accounts before factory readiness without exposing credentials",async({page},testInfo)=>{
  await page.goto("/logistics");
  await expect(page.locator("main.logistics-page")).toHaveAttribute("aria-busy","false");
  const configuration=page.locator("details.logistics-section").filter({has:page.locator("summary",{hasText:"发货连接与自动购单规则"})});
  await configuration.locator("summary").first().click();
  const account=page.getByRole("region",{name:"物流 API 账户",exact:true}),name=`Synthetic API account ${randomUUID()}`;
  await account.getByLabel("服务商",{exact:true}).selectOption("yunexpress");
  await account.getByLabel("账户名称",{exact:true}).fill(name);
  await account.getByLabel("正式 API 地址",{exact:true}).fill(process.env.LOGISTICS_TEST_BASE_URL!);
  await expect(account.getByLabel("接口版本",{exact:true})).toHaveValue("openapi");
  await account.getByLabel("客户代码（可选）",{exact:true}).fill("synthetic-customer");
  await account.getByLabel("AppSecret",{exact:true}).fill("synthetic-logistics-secret");
  await account.getByLabel("AppId",{exact:true}).fill("synthetic-app");
  await account.getByLabel("来源标识 sourceKey",{exact:true}).fill("synthetic-source");
  await expect(account.getByRole("button",{name:"测试连接",exact:true})).toBeDisabled();
  await account.getByRole("button",{name:"保存账户",exact:true}).click();
  await expect(account.getByRole("status")).toContainText("已加密保存");
  await expect(account.getByLabel("账户名称",{exact:true})).toHaveValue(name);
  await expect(account.getByLabel("AppSecret",{exact:true})).toHaveValue("");
  await expect(account.getByLabel("来源标识 sourceKey",{exact:true})).toHaveValue("");
  await account.getByRole("button",{name:"测试连接",exact:true}).click();
  await expect(account.getByRole("status")).toContainText("已读取 1 个渠道");
  const list=await centerApi<{accounts:LogisticsAccountView[]}>("logistics/accounts"),saved=list.accounts.find(row=>row.profile.name===name)!;
  expect(saved.profile.yunexpressProtocol).toBe("openapi");expect(saved.verifiedAt).toBeTruthy();expect(JSON.stringify(list)).not.toContain("synthetic-logistics-secret");expect(JSON.stringify(list)).not.toContain("synthetic-source");expect(JSON.stringify(list)).not.toContain("encryptedCredentials");
  await account.getByLabel("客户代码（可选）",{exact:true}).fill("synthetic-replacement");
  await account.getByRole("button",{name:"保存账户",exact:true}).click();
  await expect(account.getByRole("alert")).toContainText("请同时填写对应 API 密钥");
  expect((await centerApi<{accounts:LogisticsAccountView[]}>("logistics/accounts")).accounts.find(row=>row.id===saved.id)?.version).toBe(saved.version);
  await account.getByRole("button",{name:"放弃本次修改",exact:true}).click();
  await account.getByLabel("账户名称",{exact:true}).fill("Unsaved synthetic change");
  await account.getByRole("button",{name:"放弃本次修改",exact:true}).click();
  await expect(account.getByLabel("账户名称",{exact:true})).toHaveValue(name);
  await account.getByLabel("账户名称",{exact:true}).fill(`${name} revised`);
  await account.getByRole("button",{name:"保存账户",exact:true}).click();
  await expect(account.getByRole("status")).toContainText("已加密保存");
  await expect(account).toContainText("当前版本待测试");
  await account.scrollIntoViewIfNeeded();await page.screenshot({path:testInfo.outputPath("carrier-accounts-desktop.png"),fullPage:true});
  await page.setViewportSize({width:390,height:844});await account.scrollIntoViewIfNeeded();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  await page.screenshot({path:testInfo.outputPath("carrier-accounts-mobile.png"),fullPage:true});
  const malformed=await page.request.get("/api/logistics/accounts?tenantId=forbidden");expect(malformed.status()).toBe(400);
  const denied=await page.request.post("/api/logistics/accounts",{headers:{origin:"https://invalid.example","content-type":"application/json"},data:{}});
  if(process.env.WEB_AUTH_MODE==="personal"){expect(denied.status()).toBe(400);expect(await denied.json()).toMatchObject({code:"login_invalid"});}else expect(denied.status()).toBe(403);
});
async function packet(order: Awaited<ReturnType<typeof prepareDeliveryOrder>>, orderId: string) {
  const view = await centerApi<ProductionDeliveryWorkspace>(`order-centers/deliveries?order=${orderId}`);
  expect(view.candidates.every(row => !row.blockers.length)).toBe(true);
  return centerApi<ProductionDeliveryPackageView>("order-centers/deliveries", { factoryId: order.factoryId, supplierId: order.supplierId,
    items: view.candidates.map(row => ({ productionOrderId: row.productionOrderId, productionVersionId: row.productionVersionId, expectedProjectionVersion: row.projectionVersion })), idempotencyKey: randomUUID() });
}

test("order documents preserves whole-order Printeque labels and approved-file ERP rows", async ({ page }, testInfo) => {
  const order = await prepareDeliveryOrder(2, false, { originCountry: "US", materialResponsibility: "factory" });
  const detail = await centerApi<OrderWorkDetail>(`order-centers/lines/${order.lines[0]}`), orderId = detail.line.orderId;
  const original = await packet(order, orderId);
  await page.goto(`/logistics?orderId=${orderId}#documents`);
  const documents = page.getByRole("region", { name: "工厂导单与物流表", exact: true });
  await expect(documents.locator(".document-orders").getByText(order.externalId, { exact: true })).toBeVisible();
  const config = documents.locator("details.document-config").filter({ has: page.locator("summary", { hasText: "工厂导单与包裹规格配置" }) });
  await config.locator("summary").click(); const form = config.locator("form");
  await form.getByLabel("配置工厂", { exact: true }).selectOption(order.factoryId);
  await form.getByLabel("工厂编号", { exact: true }).fill("SYNTHETIC");
  await form.getByLabel("订单来源 origin", { exact: true }).fill("Synthetic operator");
  await form.getByLabel("物流渠道提供方", { exact: true }).fill("Synthetic carrier");
  await form.getByLabel("包裹数据依据", { exact: true }).fill("Synthetic measured package approved for isolated test");
  await form.getByRole("button", { name: "添加包裹规格", exact: true }).click();
  await form.getByLabel("产品规格 1", { exact: true }).selectOption(detail.draft.specificationVersionId!);
  for (const [name, value] of [["产品尺寸 in", "10"], ["工厂 parent_sku", "CP-10"], ["单件含包装重量", "0.26"], ["申报单价 USD", "8"], ["包裹长", "8"], ["包裹宽", "5"], ["包裹高", "5"]]) await form.getByLabel(name!, { exact: true }).fill(value!);
  await expect(documents.getByRole("button", { name: "预检包裹与表格" })).toBeDisabled();
  await form.getByRole("button", { name: "保存配置", exact: true }).click();
  await expect(form.getByRole("status")).toContainText("已保存");
  await documents.getByRole("button", { name: "预检包裹与表格", exact: true }).click();
  await expect(documents.getByRole("status").filter({ hasText: "预检通过" })).toBeVisible();
  await documents.getByRole("button", { name: "生成表格", exact: true }).click();
  await expect(documents.getByRole("status").filter({ hasText: "文件已生成" })).toBeVisible();
  const downloadPending = page.waitForEvent("download"); await documents.getByRole("link", { name: "下载表格", exact: true }).click();
  const downloaded = await downloadPending, workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Uint8Array.from(await readFile((await downloaded.path())!)).buffer);
  const sheet = workbook.getWorksheet("Sheet1")!, headers = new Map<string, number>(); sheet.getRow(2).eachCell((cell, i) => headers.set(String(cell.value), i));
  expect(sheet.rowCount).toBe(3); expect(sheet.getCell(3, headers.get("数量")!).value).toBe(4);
  expect(sheet.getCell(3, headers.get("长")!).numFmt ?? "General").toBe("General");
  await documents.getByRole("button", { name: "生成表格", exact: true }).click();
  await expect(documents.getByRole("status").filter({ hasText: "复用" })).toBeVisible();
  expect((await centerApi<{ exports: DocumentExportView[] }>(`logistics/documents/exports?orderId=${orderId}`)).exports).toHaveLength(1);
  await documents.getByLabel("生成表格", { exact: true }).selectOption("printeque_factory");
  await documents.getByRole("button", { name: "读取所选订单的正式交付包" }).click();
  await documents.locator(".document-production input[type=checkbox]").check();
  await documents.getByRole("button", { name: "预检包裹与表格" }).click();
  await expect(documents.getByRole("status").filter({ hasText: "预检通过 · 2 行" })).toBeVisible();
  await documents.getByRole("button", { name: "生成表格", exact: true }).click();
  await expect(documents.locator(".document-history-row")).toHaveCount(2);
  const erpRow = documents.locator(".document-history-row").filter({ hasText: "Printeque 工厂生产表" });
  const erpPending = page.waitForEvent("download"); await erpRow.getByRole("link", { name: "下载表格" }).click();
  const erpDownload = await erpPending, erp = new ExcelJS.Workbook(); await erp.xlsx.load(Uint8Array.from(await readFile((await erpDownload.path())!)).buffer);
  const data = erp.getWorksheet("orders")!, columns = new Map<string, number>(); data.getRow(1).eachCell((cell, i) => columns.set(String(cell.value), i));
  expect(data.rowCount).toBe(3);
  expect([2, 3].map(row => data.getCell(row, columns.get("order_number")!).value)).toEqual([order.externalId, order.externalId]);
  const actualNames = [2, 3].map(row => data.getCell(row, columns.get("sku")!).value);
  expect(new Set(actualNames)).toEqual(new Set(original.items.map(item => item.snapshot!.file.path.split("/").at(-1)!.replace(/\.jpg$/, ""))));
  await page.screenshot({ path: testInfo.outputPath("documents-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: testInfo.outputPath("documents-mobile.png"), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("order documents registers Yun PDF and builds Yicai folders from unchanged approved JPG bytes", async ({ page }, testInfo) => {
  const order = await prepareDeliveryOrder(1, false, { materialResponsibility: "factory" }), detail = await centerApi<OrderWorkDetail>(`order-centers/lines/${order.lines[0]}`), orderId = detail.line.orderId;
  const original = await packet(order, orderId);
  const profile: FactoryDocumentProfile = { name: "Synthetic Yicai packing", route: "yunexpress", productionAdapter: "yicai_folder", originCountryCode: "CN", destinationCountries: ["US"], originCompany: "", factoryCode: "", carrierProvider: "", carrierService: "", useAccountSender: true,
    evidence: "Synthetic measured packing approval", specifications: [{ specificationVersionId: detail.draft.specificationVersionId!, productKind: "shaped_pillow", sizeIn: 10, supplierSku: "CP-10", weight: .26, weightUnit: "lb", length: 8, width: 5, height: 5, dimensionUnit: "in", declaredUnitValueMinor: 800, nameEn: "Pillow", nameCn: "抱枕", hsCode: "" }] };
  const saved = await centerApi<{ id: string }>("logistics/documents/profiles", { factoryId: order.factoryId, expectedVersion: 0, profile, idempotencyKey: randomUUID() });
  await page.goto(`/logistics?orderId=${orderId}#documents`);
  const documents = page.getByRole("region", { name: "工厂导单与物流表", exact: true });
  await documents.getByLabel("导单工厂", { exact: true }).selectOption(saved.id);
  await documents.getByRole("button", { name: "预检包裹与表格" }).click();
  await expect(documents.getByRole("status").filter({ hasText: "预检通过" })).toBeVisible();
  await documents.getByRole("button", { name: "生成表格", exact: true }).click();
  await expect(documents.getByRole("status").filter({ hasText: "文件已生成" })).toBeVisible();
  const history = await centerApi<{ exports: DocumentExportView[] }>(`logistics/documents/exports?orderId=${orderId}`);
  const panel = documents.locator("details.document-config").filter({ has: page.locator("summary", { hasText: "云途单号、面单与义彩交付" }) }); await panel.locator("summary").click();
  await panel.getByLabel("对应的云途导出", { exact: true }).selectOption(history.exports[0]!.id);
  await panel.getByRole("button", { name: "核对当前收件资料" }).click();
  await panel.getByLabel("云途跟踪号", { exact: true }).fill("SYNTHETICYUN20261104");
  const pdf = Buffer.from("%PDF-1.4\n% Synthetic isolated carrier label\n%%EOF\n");
  await panel.getByLabel("官方 PDF 面单", { exact: true }).setInputFiles({ name: "synthetic-yun.pdf", mimeType: "application/pdf", buffer: pdf });
  await panel.getByRole("checkbox", { name: /已核对 PDF/ }).check();
  await panel.getByRole("button", { name: "保存单号与面单" }).click();
  await expect(panel.getByRole("status")).toContainText("已登记");
  await panel.getByRole("button", { name: "读取本单正式生产交付包" }).click();
  await panel.locator(".logistics-form > label input[type=checkbox]").check();
  const pending = page.waitForEvent("download"); await panel.getByRole("button", { name: "下载义彩订单文件夹" }).click();
  const downloaded = await pending, zip = await JSZip.loadAsync(await readFile((await downloaded.path())!));
  expect(await zip.file(`${order.externalId}/云途面单.pdf`)!.async("nodebuffer")).toEqual(pdf);
  const manifest = JSON.parse(await zip.file(`${order.externalId}/交付清单.json`)!.async("string"));
  expect(manifest.items).toHaveLength(1); expect(manifest.items[0].declaredLongestCm).toBe(25.4);
  const jpg = await zip.file(manifest.items[0].name)!.async("nodebuffer"); expect(sha(jpg)).toBe(original.items[0]!.snapshot!.file.checksum);
  expect(zip.file(`原生产交付清单/${original.id}.json`)).not.toBeNull();
  const denied = await page.request.post("/api/logistics/documents/labels", { headers: { origin: "https://invalid.example", "content-type": "application/json" }, data: {} });
  if (process.env.WEB_AUTH_MODE === "personal") {
    expect(denied.status()).toBe(400);
    expect(await denied.json()).toMatchObject({ code: "login_invalid" });
  } else expect(denied.status()).toBe(403);
  expect((await page.request.get("/api/logistics/documents/options?tenantId=ignored")).status()).toBe(400);
  await page.screenshot({ path: testInfo.outputPath("yicai-handoff-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("order documents imports existing ZIPs through the report owner and skips repeated intake", async ({ page }) => {
  const account = await centerApi<MarketplaceAccountView>("marketplace-accounts", { platform: "amazon", displayName: `Archive ${randomUUID().slice(0, 8)}`, region: "NA", marketplaceIds: ["ATVPDKIKX0DER"], authorizationMode: "amazon_private", requestedScopes: [] });
  const orderId = `111-0000000-${String(Date.now()).slice(-7)}`, itemId = "123456789012345";
  const batch = await centerApi<AmazonReportBatchView>("orders/reports/import", { accountId: account.id, marketplaceId: "ATVPDKIKX0DER", fileName: "synthetic-archive.txt", content: `order-id\torder-item-id\tpurchase-date\tsku\tproduct-name\tquantity-purchased\tcurrency\titem-price\n${orderId}\t${itemId}\t${new Date().toISOString()}\tCHANGED-SKU\tSynthetic pillow\t1\tUSD\t8.00` });
  const archive = new JSZip(); archive.file("order.json", JSON.stringify({ orderId, orderItemId: itemId, text: "Synthetic buyer customization" }));
  const bytes = await archive.generateAsync({ type: "nodebuffer" });
  await page.goto("/orders?view=reports");
  await page.getByLabel("订单所属店铺", { exact: true }).selectOption(account.id);
  const panel = page.locator("details.ar-archive-import"); await panel.locator("summary").click();
  await panel.getByLabel("选择已下载的原始 ZIP", { exact: true }).setInputFiles([{ name: `${orderId}_${itemId}.zip`, mimeType: "application/zip", buffer: bytes }, { name: "unmatched.zip", mimeType: "application/zip", buffer: bytes }]);
  await expect(panel).toContainText("可承接 1 个");
  await panel.getByRole("button", { name: "开始承接", exact: true }).click();
  await expect(panel.getByRole("status")).toContainText("成功 1 · 跳过 1 · 未完成 0");
  const first = await centerApi<AmazonReportWorkspaceView>(`orders/reports/workspace?accountId=${account.id}&batchId=${batch.id}`);
  expect(first.lines).toHaveLength(1); expect(first.lines[0]!.reviewed).toBe(false);
  const version = first.lines[0]!.versionNumber;
  await panel.getByLabel("选择已下载的原始 ZIP", { exact: true }).setInputFiles({ name: `${orderId}_${itemId}.zip`, mimeType: "application/zip", buffer: bytes });
  await expect(panel).toContainText("已有可读取的定制内容 保留当前版本");
  await expect(panel.getByRole("button", { name: "开始承接", exact: true })).toBeDisabled();
  const second = await centerApi<AmazonReportWorkspaceView>(`orders/reports/workspace?accountId=${account.id}&batchId=${batch.id}`);
  expect(second.lines[0]!.versionNumber).toBe(version);
});
