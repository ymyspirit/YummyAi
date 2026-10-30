// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ErpSessionView } from "@yummyai/contracts/auth/session";
import { SpecificationFactsSchema, type DevelopmentOptions, type SpecificationView } from "@yummyai/contracts/catalog/development";
import { ErpIdentityContext } from "../identity/erp-access";
import { SpuDetailPanel } from "./spu-detail-panel";

vi.mock("../navigation/use-workflow-return", () => ({ useWorkflowReturn: () => ({ current: "/product-specifications?spu=synthetic" }) }));

const id = (suffix: number) => `019f1000-0000-7000-8000-${suffix.toString(16).padStart(12, "0")}`;
const owner = id(90), spuId = id(1), secondSpu = id(2), emptySpu = id(3), referenceRule = id(91);
const sourceDescription = "Synthetic original product explanation kept for review. ".repeat(12);
let root: Root | null = null, host: HTMLDivElement;
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); host = document.createElement("div"); document.body.append(host); });
afterEach(async () => { if (root) await act(async () => root?.unmount()); root = null; host.remove(); vi.unstubAllGlobals(); });

function fixture(): DevelopmentOptions {
  const specifications: SpecificationView[] = [20, 12, 24, 10, 22, 14, 18, 16].map(size => ({
    id: id(100 + size), versionId: id(200 + size), version: 4, spuId, spuCode: "SYNTHETIC-PILLOW", spuName: "Synthetic pillow",
    code: `CP-${size}`, name: `${size} 英寸`, attributes: { 尺寸: `${size} 英寸` },
    facts: SpecificationFactsSchema.parse({ formatVersion: 2, material: "Synthetic original material record", structure: "Synthetic two-panel construction record",
      dimensions: `${size} in · 图案主体最长边`, physicalDimensions: { basis: "artwork_longest", unit: "in", length: size, width: null, height: null },
      packageContents: "One synthetic pillow", packageQuantity: 1, factsConfirmed: false, productionConfirmed: true,
      weightGrams: null, packagedWeightGrams: size === 12 ? null : 123.456789, packageDimensions: "30 × 20 × 5 cm",
      packageMeasurements: { unit: "cm", length: 30, width: 20, height: 5 }, verificationReference: `Synthetic original measurement ${size}`,
      productionRuleReferences: [{ ruleId: referenceRule, versionId: id(92), version: 3 }] }),
    factVerification: null, productionVerification: { confirmedByUserId: owner, confirmedAt: "2026-10-30T00:00:00.000Z", reference: `Synthetic pinned production proof ${size}` },
    processProfileVersionId: size === 24 ? null : id(93), processName: "Synthetic current process", productType: "shaped_pillow",
    canvasPrintSpecVersionId: null, stockItemId: null, createdAt: "2026-10-30T00:00:00.000Z",
  }));
  return { artworks: [], specifications, spus: [spuId, secondSpu, emptySpu].map((value, index) => ({ id: value, code: `SYNTHETIC-${index}`, name: `Synthetic product ${index}`,
    productPlanId: id(10 + index), ownerUserId: owner, description: sourceDescription, revision: "a".repeat(64),
    capabilities: { processes: "Synthetic process evidence", customizationScope: "Synthetic customization scope", packaging: "Synthetic original packaging instructions" } })),
  creativeVersions: [], researchItems: [], processes: [], canvasPrintSpecs: [], stockItems: [], accounts: [], preferenceScope: "synthetic-layout", materialAssets: [] };
}

function session(writable: boolean): ErpSessionView {
  const permissions = writable ? ["product:read", "product:write"] : ["product:read"];
  return { authenticated: true, canUseErp: true, userId: owner, tenantId: id(99), displayName: "Synthetic product viewer", organizationName: "Synthetic tenant",
    permissions, dataScope: "tenant", permissionScopes: Object.fromEntries(permissions.map(permission => [permission, "tenant" as const])) };
}
async function render(options = fixture(), patch: Partial<ComponentProps<typeof SpuDetailPanel>> = {}, writable = true) {
  const props: ComponentProps<typeof SpuDetailPanel> = { options, spuId, busy: false, onEdit: vi.fn(), onBind: vi.fn(), onSpecification: vi.fn(), ...patch };
  root ??= createRoot(host);
  // The actual workspace keys this panel by selected SPU and caller authority.
  await act(async () => root!.render(<ErpIdentityContext.Provider value={{ session: session(writable), localDevelopment: false, logout: vi.fn() }}>
    <SpuDetailPanel key={props.spuId} {...props} />
  </ErpIdentityContext.Provider>));
  return props;
}
function button(name: string, within: ParentNode = host) {
  const result = [...within.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent?.trim() === name);
  if (!result) throw new Error(`Missing synthetic control: ${name}`);
  return result;
}
function details(summary: string) {
  const result = [...host.querySelectorAll("details")].find(item => item.querySelector("summary")?.textContent?.trim() === summary);
  if (!result) throw new Error(`Missing synthetic details: ${summary}`);
  return result;
}
function specificationDetails(name: string) {
  const toggle = host.querySelector<HTMLButtonElement>(`button[aria-label="${name} 完整资料与核验依据"]`)!;
  const region = host.querySelector<HTMLElement>(`[role="region"][aria-label="${name} 完整资料"]`)!;
  const container = region.closest("details")!;
  expect(document.getElementById(toggle.getAttribute("aria-controls")!)).not.toBeNull();
  return { toggle, region, container };
}
function rows() { return [...host.querySelectorAll<HTMLTableRowElement>('table[aria-label="产品规格对比"] tbody tr')].filter(row => [...row.querySelectorAll("button")].some(item => item.textContent?.trim() === "修改规格")); }
function filterInput() {
  const label = [...host.querySelectorAll("label")].find(item => item.textContent?.trim() === "筛选规格")!;
  return document.getElementById(label.htmlFor) as HTMLInputElement;
}
async function click(element: HTMLElement) { await act(async () => element.click()); }
async function filter(value: string) {
  const input = filterInput();
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
  return input;
}

describe("SPU detail keeps production evidence accessible without expanding every record", () => {
  it("shows eight naturally ordered summaries and keeps original long facts inside closed native details", async () => {
    const options = fixture(), original = structuredClone(options);
    await render(options);
    expect(rows()).toHaveLength(8);
    expect(rows().map(row => options.specifications.find(spec => row.querySelector('th[scope="row"] strong')?.textContent === spec.name)!.id)).toEqual([10, 12, 14, 16, 18, 20, 22, 24].map(size => id(100 + size)));
    const description = details("产品说明与通用工艺"), first = specificationDetails("10 英寸");
    expect(description.open).toBe(false); expect(description.textContent).toContain(sourceDescription);
    expect(first.container.open).toBe(false); expect(first.toggle.getAttribute("aria-expanded")).toBe("false");
    expect(first.region.textContent).toContain("Synthetic original material record");
    expect(first.region.textContent).toContain("Synthetic two-panel construction record");
    expect(first.region.textContent).toContain("123.456789");
    expect(first.region.textContent).toContain("Synthetic original measurement 10");
    expect(first.region.textContent).toContain("Synthetic pinned production proof 10");
    expect(rows()[0]?.textContent).toContain("123.46 g");
    expect(rows()[1]?.textContent).toContain("待确认");
    const netWeight = [...first.region.querySelectorAll("dt")].find(term => term.textContent === "商品净重 原始记录")!.nextElementSibling;
    expect(netWeight?.textContent).toBe("未知");
    const rule = [...first.region.querySelectorAll<HTMLAnchorElement>("a")].find(link => new URL(link.href).pathname === "/settings/rules")!;
    expect(new URL(rule.href).searchParams.get("rule")).toBe(referenceRule);
    expect(new URL(rule.href).searchParams.get("version")).toBe("3");
    await click(description.querySelector("summary")!); await click(first.toggle);
    expect(description.open).toBe(true); expect(first.container.open).toBe(true); expect(first.toggle.getAttribute("aria-expanded")).toBe("true");
    expect(options).toEqual(original);
  });

  it("passes the original specification object and pinned version to its edit callback", async () => {
    const options = fixture(), props = await render(options), first = options.specifications.find(spec => spec.code === "CP-10")!;
    await click(button("修改规格", rows()[0]!));
    expect(props.onSpecification).toHaveBeenCalledOnce();
    expect(vi.mocked(props.onSpecification).mock.calls[0]![0]).toBe(first);
    expect(vi.mocked(props.onSpecification).mock.calls[0]![0].versionId).toBe(first.versionId);
    const manufacturing = [...rows()[0]!.querySelectorAll<HTMLAnchorElement>("a")].find(link => link.textContent === "本规格制造模板")!;
    expect(new URL(manufacturing.href).searchParams.get("specificationId")).toBe(first.id);
    expect(new URL(manufacturing.href).searchParams.get("returnTo")).toBe("/product-specifications?spu=synthetic");
  });

  it("keeps read-only and busy controls from invoking business writes while preserving read links", async () => {
    const options = fixture(), readonly = await render(options, {}, false);
    expect(host.textContent).not.toContain("编辑 SPU"); expect(host.textContent).not.toContain("绑定多个规格");
    expect([...host.querySelectorAll("a")].some(link => link.textContent === "新建销售方案")).toBe(false);
    expect([...host.querySelectorAll("a")].some(link => link.textContent === "查看销售方案")).toBe(true);
    const edit = button("修改规格", rows()[0]!); expect(edit.disabled).toBe(true); await click(edit);
    expect(readonly.onSpecification).not.toHaveBeenCalled();
    const busy = await render(options, { busy: true });
    for (const editButton of [...host.querySelectorAll<HTMLButtonElement>("button")].filter(item => ["修改规格", "编辑 SPU", "绑定多个规格"].includes(item.textContent?.trim() ?? ""))) {
      expect(editButton.disabled).toBe(true); await click(editButton);
    }
    expect(busy.onEdit).not.toHaveBeenCalled(); expect(busy.onBind).not.toHaveBeenCalled(); expect(busy.onSpecification).not.toHaveBeenCalled();
  });

  it("filters explicitly and resets the filter and all expanded details when the selected SPU changes", async () => {
    const options = fixture(); options.specifications.push({ ...options.specifications[0]!, id: id(400), versionId: id(401), spuId: secondSpu, code: "SECOND-30", name: "30 英寸" });
    await render(options);
    await click(details("产品说明与通用工艺").querySelector("summary")!);
    await click(specificationDetails("10 英寸").toggle);
    await filter("CP-10"); expect(rows()).toHaveLength(1);
    await filter("no-synthetic-match"); expect(rows()).toHaveLength(0);
    expect(host.textContent).toContain("没有匹配的规格 请调整筛选条件");
    await render(options, { spuId: secondSpu });
    expect(filterInput().value).toBe("");
    expect(rows()).toHaveLength(1); expect(rows()[0]!.textContent).toContain("30 英寸");
    expect([...host.querySelectorAll("details")].every(item => !item.open)).toBe(true);
    await render(options); expect(rows()).toHaveLength(8); expect([...host.querySelectorAll("details")].every(item => !item.open)).toBe(true);
  });

  it("does not carry an expanded old evidence version into a newly saved specification version", async () => {
    const options = fixture(); await render(options);
    await click(specificationDetails("10 英寸").toggle);
    expect(specificationDetails("10 英寸").container.open).toBe(true);
    const next = { ...options, specifications: options.specifications.map(spec => spec.code === "CP-10" ? { ...spec, version: 5, versionId: id(500) } : spec) };
    await render(next);
    expect(specificationDetails("10 英寸").container.open).toBe(false);
    expect(rows()[0]?.textContent).toContain("V5");
    expect(options.specifications.find(spec => spec.code === "CP-10")?.version).toBe(4);
  });

  it("keeps missing, empty and legacy SPU states explicit without enabling a legacy root edit", async () => {
    const options = fixture();
    await render(options, { spuId: id(999) }); expect(host.querySelector('[role="alert"]')?.textContent).toContain("此 SPU 当前不可用");
    await render(options, { spuId: emptySpu }); expect(host.textContent).toContain("此 SPU 尚无规格 点击绑定多个规格");
    await render(options, { spuId: emptySpu }, false); expect(host.textContent).toContain("此 SPU 尚无规格 当前账户只读");
    options.spus[0]!.legacyPlanAmbiguous = true;
    const props = await render(options);
    expect(host.querySelector('[role="status"]')?.textContent).toContain("历史商品关系待核对");
    expect(button("编辑 SPU").disabled).toBe(true); await click(button("编辑 SPU")); expect(props.onEdit).not.toHaveBeenCalled();
    expect(rows()).toHaveLength(8);
  });
});
