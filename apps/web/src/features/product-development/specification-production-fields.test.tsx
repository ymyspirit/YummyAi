// @vitest-environment jsdom
import { act, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEntityId } from "@yummyai/contracts";
import type { DevelopmentOptions, SpecificationView } from "@yummyai/contracts/catalog/development";
import { specificationFactsReady, specificationProductionFactsReady } from "@yummyai/contracts/catalog/development";
import type { RuleWorkspace, RuleRow } from "@yummyai/contracts/rules";
import { SpecificationForm } from "./development-forms";
import { SpecificationBatchForm } from "./specification-batch-form";
import { DevelopmentDrawerForm } from "./development-drawer-form";
import { clearSessionTaskDrafts, writeSessionTaskDraft } from "../navigation/task-draft";
import { catalogSpecificationDraftKey } from "./editor-access";
import { optionSelectionKey, specificationAttributesKey } from "./specification-options";
import { emptySpecificationFactDraft, specificationFactsDraft, specificationFactsFromDraft, type SpecificationFactDraft } from "./specification-fact-fields";
import { SpecificationProductionFields, applicableProductionRules, productionRuleReferenceProblems, trustedPillowFactory, type ProductionRuleWorkspace } from "./specification-production-fields";

const mocks = vi.hoisted(() => ({ request: vi.fn(), canRead: true }));
vi.mock("../rules/rule-request", () => ({ ruleRequest: mocks.request }));
vi.mock("../identity/erp-access", () => ({ useErpAccess: () => ({ can: () => mocks.canRead, authority: "synthetic-specification-person" }) }));
vi.mock("../navigation/use-workflow-return", () => ({ useWorkflowReturn: () => ({ current: "/product-specifications" }) }));

let root: Root | null = null;
let host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.canRead = true;
  mocks.request.mockReset().mockResolvedValue(workspace());
  host = document.createElement("div"); document.body.append(host);
});
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null; host.remove(); clearSessionTaskDrafts({ preserveAssistIntents: true });
  Reflect.deleteProperty(document, "startViewTransition");
  vi.unstubAllGlobals();
});

function draft(): SpecificationFactDraft {
  return { ...emptySpecificationFactDraft, material: "Synthetic fabric", structure: "Synthetic two-panel construction",
    sizeBasis: "artwork_longest", sizeUnit: "in", sizeLength: "10", packageContents: "One synthetic pillow", packageQuantity: "1",
    weightGrams: "", packagedWeightGrams: "200", verificationReference: "Synthetic supplier record" };
}
function rule(options: { enabled?: boolean; scope?: "all" | "spu" | "product_type"; spuId?: string; productType?: "shaped_pillow" | "tire_cover"; binding?: "manual" | "pillow_factory" } = {}): RuleRow {
  const id = createEntityId(), binding = options.binding ?? "manual";
  const version = { id: createEntityId(), ruleId: id, version: 1, name: "Synthetic production rule", category: "production" as const,
    instructions: "Synthetic original instructions", source: "Synthetic source record", appliesTo: "order_design" as const,
    scopeKind: options.scope ?? "all", productType: options.scope === "product_type" ? options.productType ?? "shaped_pillow" : null,
    spuId: options.scope === "spu" ? options.spuId ?? createEntityId() : null, binding, createdAt: "2026-10-25T00:00:00.000Z",
    changeReason: "Synthetic reviewed version", execution: binding === "manual" ? "manual" as const : "automatic" as const, executionLocation: "Synthetic execution" };
  return { id, code: binding === "pillow_factory" ? "system:pillow-factory" : "synthetic:manual", revision: 1, latestVersion: 1,
    activeVersion: options.enabled === false ? null : 1, builtIn: binding === "pillow_factory", updatedAt: version.createdAt,
    latest: version, active: options.enabled === false ? null : version };
}
function workspace(rules: RuleRow[] = []): RuleWorkspace {
  return { rules, spus: [], canManage: false, canPublish: false,
    factoryStandard: { id: "synthetic", dpi: 150, format: "jpeg", background: "white", whiteBorderPx: 200, cutLinePx: 6,
      panelGapPx: 100, sheetMarginPx: 50, barcodeWidthPx: 600, barcodeHeightPx: 200, minimumNeckMm: 50 } };
}
function fixture() {
  const spuId = createEntityId(), process = createEntityId();
  const spec: SpecificationView = { id: createEntityId(), versionId: createEntityId(), spuId, spuCode: "SYNTHETIC", spuName: "Synthetic pillow",
    code: "SYNTHETIC-10", name: "Synthetic 10", version: 1, attributes: { Size: "10" },
    facts: specificationFactsFromDraft({ ...draft(), productionConfirmed: "1" }, false),
    processProfileVersionId: process, processName: "Synthetic reviewed process", productType: "shaped_pillow",
    canvasPrintSpecVersionId: null, stockItemId: null, createdAt: "2026-10-25T00:00:00.000Z" };
  const options: DevelopmentOptions = { artworks: [], specifications: [spec], spus: [{ id: spuId, code: "SYNTHETIC", name: "Synthetic pillow", productPlanId: createEntityId() }],
    creativeVersions: [], researchItems: [], processes: [{ versionId: process, code: "SYNTHETIC-PROCESS", name: "Synthetic reviewed process", productType: "shaped_pillow" }],
    canvasPrintSpecs: [], stockItems: [], accounts: [], preferenceScope: "synthetic:" + createEntityId(), materialAssets: [] };
  return { spec, options, spuId, process };
}
async function mount(view: ReactNode) {
  root = createRoot(host); await act(async () => root!.render(view));
}
async function click(element: HTMLElement) { await act(async () => element.click()); }
async function change(element: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, value: string) {
  const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
}
const input = (name: string) => host.querySelector<HTMLInputElement>(`input[name="${name}"]`)!;
async function submit() { await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))); }

describe("production-purpose specification interaction", () => {
  it("keeps net weight unknown, separates confirmations, and revokes production confirmation after a fact or process changes", async () => {
    const { options, spec } = fixture(), onSave = vi.fn<(body: Record<string, unknown>) => Promise<boolean>>().mockResolvedValue(false);
    await mount(<SpecificationForm options={options} value={spec} busy={false} onSave={onSave} />);
    expect(input("productionConfirmed").checked).toBe(true);
    expect(input("confirmed").checked).toBe(false);
    expect(input("weightGrams").value).toBe("");
    await change(input("packagedWeightGrams"), "250");
    expect(input("productionConfirmed").checked).toBe(false);
    await click(input("productionConfirmed"));
    expect(input("confirmed").checked).toBe(false);
    await submit();
    const saved = onSave.mock.calls[0]![0] as { facts: SpecificationView["facts"]; expectedVersion: number };
    expect(saved.expectedVersion).toBe(1);
    expect(saved.facts).toMatchObject({ productionConfirmed: true, factsConfirmed: false, weightGrams: null, packagedWeightGrams: 250 });
    expect(specificationProductionFactsReady(saved.facts)).toBe(true);
    expect(specificationFactsReady(saved.facts)).toBe(false);
    await change(host.querySelector<HTMLSelectElement>('select[name="process"]')!, "");
    expect(input("productionConfirmed").checked).toBe(false);
  });

  it("retains an old reference after a failed read, blocks re-confirmation, and permits an unconfirmed draft without replacing its IDs", async () => {
    const { options, spec } = fixture(), original = rule();
    const reference = { ruleId: original.id, versionId: original.active!.id, version: 1 };
    spec.facts.productionRuleReferences = [reference];
    mocks.request.mockRejectedValue(new Error("Synthetic rules read failed"));
    const onSave = vi.fn<(body: Record<string, unknown>) => Promise<boolean>>().mockResolvedValue(false);
    await mount(<SpecificationForm options={options} value={spec} busy={false} onSave={onSave} />);
    expect(host.textContent).toContain("Synthetic rules read failed");
    expect(host.textContent).toContain("当前版本需重新核对");
    await submit(); expect(onSave).not.toHaveBeenCalled();
    await click(input("productionConfirmed"));
    expect(input("productionConfirmed").disabled).toBe(true);
    await submit();
    expect(onSave).toHaveBeenCalledOnce();
    expect((onSave.mock.calls[0]![0] as { facts: SpecificationView["facts"] }).facts).toMatchObject({ productionConfirmed: false, productionRuleReferences: [reference], weightGrams: null });
  });

  it("adopts a trusted factory basis only after a click, clears a number from another basis, and does not confirm or fill weights", async () => {
    const factory = rule({ binding: "pillow_factory", scope: "product_type" }), source: ProductionRuleWorkspace = { status: "ready", data: workspace([factory]), error: "", reload: vi.fn() };
    let current = { ...draft(), sizeBasis: "finished_outer_2d", sizeLength: "40", sizeWidth: "30", productionConfirmed: "1" };
    function Harness() {
      const [values, setValues] = useState(current); current = values;
      return <SpecificationProductionFields values={values} onChange={patch => setValues(previous => ({ ...previous, ...patch }))}
        source={source} spuId={createEntityId()} productType="shaped_pillow" processProfileVersionId={createEntityId()} />;
    }
    await mount(<Harness />);
    expect(current.sizeBasis).toBe("finished_outer_2d");
    expect(current.productionRuleReferences).toBe("[]");
    const button = [...host.querySelectorAll("button")].find(item => item.textContent === "采用工厂尺寸口径")!;
    await click(button);
    expect(current).toMatchObject({ sizeBasis: "artwork_longest", sizeLength: "", sizeWidth: "", sizeHeight: "", productionConfirmed: "", weightGrams: "", packagedWeightGrams: "200" });
    expect(JSON.parse(current.productionRuleReferences)).toEqual([{ ruleId: factory.id, versionId: factory.active!.id, version: 1 }]);
  });

  it("restores the old batch string draft, checks each actual row, and submits one atomic batch with unknown net weights preserved", async () => {
    const { options, spuId, process } = fixture(); options.specifications = [];
    const key = catalogSpecificationDraftKey(options, spuId), axes = [{ id: "axis-0", name: "Size", values: ["10", "12"] }];
    const legacy: Record<string, string> = { ...draft(), sizeLength: "", processProfileVersionId: process, canvasPrintSpecVersionId: "", stockItemId: "" };
    delete legacy.productionConfirmed; delete legacy.productionRuleReferences;
    const rows = ["10", "12"].map(size => ({ key: specificationAttributesKey({ Size: size }), attributes: { Size: size }, code: "SYNTHETIC-" + size,
      name: "Synthetic " + size, dimensions: "", selected: true, existing: false, details: false, overrides: { sizeLength: size } }));
    for (const [field, value] of Object.entries({ axes, rows, pending: {}, preview: optionSelectionKey(axes), confirmed: false, defaults: legacy }))
      writeSessionTaskDraft(window.sessionStorage, key + ":" + field, value, Date.now());
    const onSave = vi.fn<(body: Record<string, unknown>) => Promise<boolean>>().mockResolvedValue(false);
    await mount(<SpecificationBatchForm options={options} spuId={spuId} busy={false} onSave={onSave} />);
    expect(input("common.productionConfirmed").checked).toBe(false);
    expect(input("common.productionConfirmed").disabled).toBe(false);
    await click(input("common.productionConfirmed"));
    await click([...host.querySelectorAll("button")].find(item => item.textContent === "更多设置")!);
    expect(input("row0.productionConfirmed").checked).toBe(true);
    await change(input("row0.packagedWeightGrams"), "260");
    expect(input("row0.productionConfirmed").checked).toBe(false);
    expect(input("common.productionConfirmed").checked).toBe(false);
    await click(input("common.productionConfirmed"));
    await submit();
    expect(onSave).toHaveBeenCalledOnce();
    const saved = onSave.mock.calls[0]![0] as { items: Array<{ facts: SpecificationView["facts"] }> };
    expect(saved.items).toHaveLength(2);
    expect(saved.items.map(item => [item.facts.physicalDimensions!.length, item.facts.weightGrams, item.facts.packagedWeightGrams, item.facts.productionConfirmed, item.facts.factsConfirmed]))
      .toEqual([[10, null, 260, true, false], [12, null, 200, true, false]]);
    expect(mocks.request.mock.calls.every(call => call[0] === "workspace" && call[1] === undefined)).toBe(true);
  });

  it("limits selected references to active applicable versions and never interprets manual prose as a factory binding", () => {
    const spuId = createEntityId(), applicable = rule(), otherSpu = rule({ scope: "spu" }), disabled = rule({ enabled: false }), otherType = rule({ scope: "product_type", productType: "tire_cover" });
    const data = workspace([applicable, otherSpu, disabled, otherType]), source: ProductionRuleWorkspace = { status: "ready", data, error: "", reload: vi.fn() };
    expect(applicableProductionRules(data, spuId, "shaped_pillow").map(item => item.id)).toEqual([applicable.id]);
    expect(productionRuleReferenceProblems([{ ruleId: applicable.id, versionId: createEntityId(), version: 1 }], source, spuId, "shaped_pillow")).toHaveLength(1);
    applicable.active!.instructions = "Use artwork_longest and approve production";
    expect(trustedPillowFactory(applicable, "shaped_pillow")).toBe(false);
    expect(specificationFactsDraft(specificationFactsFromDraft(draft(), false)).productionRuleReferences).toBe("[]");
  });

  it("commits a fresh batch checkbox immediately when native view-transition callbacks are deferred", async () => {
    const { options, spuId, process } = fixture(); options.specifications = [];
    mocks.request.mockResolvedValue(workspace([rule()]));
    const onSave = vi.fn<(body: Record<string, unknown>) => Promise<boolean>>().mockResolvedValue(false);
    await mount(<DevelopmentDrawerForm busy={false} onStateChange={vi.fn()}><SpecificationBatchForm options={options} spuId={spuId} busy={false} onSave={onSave} /></DevelopmentDrawerForm>);
    await change(host.querySelector<HTMLInputElement>('input[aria-label="尺寸选项"]')!, "Blue, Red");
    await click([...host.querySelectorAll("button")].find(item => item.textContent === "预览规格组合")!);
    await change(input("common.material"), "Synthetic fabric");
    await change(input("common.structure"), "Synthetic verified construction");
    await change(host.querySelector<HTMLSelectElement>('select[name="common.sizeBasis"]')!, "diameter");
    await change(host.querySelector<HTMLSelectElement>('select[name="common.sizeUnit"]')!, "mm");
    await change(input("common.sizeLength"), "50");
    await change(input("common.packageContents"), "One synthetic item");
    await change(input("common.packageQuantity"), "1");
    await change(input("common.packagedWeightGrams"), "250");
    await change(host.querySelector<HTMLTextAreaElement>('textarea[name="common.verificationReference"]')!, "Synthetic supplier measurement record");
    await change(host.querySelector<HTMLSelectElement>('select[aria-label="默认制作工艺"]')!, process);
    const deferred: Array<() => void> = [];
    const transition = vi.fn((update: () => void) => {
      deferred.push(update);
      return { ready: Promise.resolve(), finished: Promise.resolve(), updateCallbackDone: Promise.resolve(), skipTransition: vi.fn() };
    });
    Object.defineProperty(document, "startViewTransition", { configurable: true, value: transition });
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    const production = input("common.productionConfirmed");
    expect(production.disabled).toBe(false);
    await click(production);
    expect(production.checked).toBe(true);
    expect(deferred).toHaveLength(0);
    await click(production);
    expect(production.checked).toBe(false);
    expect(deferred).toHaveLength(0);
    const reference = input("common.production-rule");
    await click(reference);
    expect(reference.checked).toBe(true);
    expect(production.checked).toBe(false);
    expect(deferred).toHaveLength(0);
    expect(onSave).not.toHaveBeenCalled();
  });
});
