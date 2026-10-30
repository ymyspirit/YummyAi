// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ErpSessionView } from "@yummyai/contracts/auth/session";
import { emptyModelDefaults, type ConfigurationRpc, type ConfigurationSnapshot } from "@yummyai/contracts/ai/model-configuration";
import { ASSIST_INTENT_CLEAR_EVENT } from "@yummyai/contracts/ai/assist-recovery";
import { ErpIdentityContext } from "../identity/erp-access";
import { ModelSettingsWorkbench } from "./model-settings-workbench";

const id = (suffix: number) => `019f3100-0000-7000-8000-${suffix.toString(16).padStart(12, "0")}`;
const channelId = id(1), firstId = id(2), secondId = id(3);
let root: Root | null = null, host: HTMLDivElement;
const originalShow = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "showModal"), originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "close");
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value(this: HTMLDialogElement) { this.setAttribute("open", ""); } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value(this: HTMLDialogElement) { this.removeAttribute("open"); } });
  vi.spyOn(window, "confirm").mockReturnValue(true);
  window.history.replaceState(null, "", "/settings/ai");
  host = document.createElement("div"); document.body.append(host);
});
afterEach(async () => {
  if (root) await act(async () => root?.unmount()); root = null; host.remove();
  for (const [name, descriptor] of [["showModal", originalShow], ["close", originalClose]] as const) {
    if (descriptor) Object.defineProperty(HTMLDialogElement.prototype, name, descriptor);
    else Reflect.deleteProperty(HTMLDialogElement.prototype, name);
  }
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});
function snapshot(): ConfigurationSnapshot {
  return { channels: [{ id: channelId, name: "Synthetic private channel", baseUrl: "https://synthetic.example.test/v1", provider: "openai",
    textProtocol: "responses", hasCredential: true, status: "enabled", revision: "a".repeat(64), dependentRoutes: [], analysisModels: [], models: [
      { id: firstId, name: "image-looking-text-id", label: "Synthetic first text", capability: "text" },
      { id: secondId, name: "second-text", label: "Synthetic second text", capability: "text" },
    ] }], analysisModels: [
    { id: firstId, label: "Synthetic first text", model: "image-looking-text-id", providerLabel: "Synthetic private channel", providerConfigId: channelId },
    { id: secondId, label: "Synthetic second text", model: "second-text", providerLabel: "Synthetic private channel", providerConfigId: channelId },
  ], defaults: { ...emptyModelDefaults(), purposeDefaults: { knowledge_answer: firstId } }, defaultsRevision: 7 };
}
function session(configure = true): ErpSessionView {
  const permissions = configure ? ["design:read", "model:configure"] : ["design:read"];
  return { authenticated: true, canUseErp: true, userId: id(90), tenantId: id(91), displayName: "Synthetic model operator", organizationName: "Synthetic settings tenant", permissions,
    dataScope: "tenant", permissionScopes: Object.fromEntries(permissions.map(permission => [permission, "tenant" as const])) };
}
async function render(value: ErpSessionView | null = session()) {
  root ??= createRoot(host);
  const onState = vi.fn();
  await act(async () => root!.render(<ErpIdentityContext.Provider value={{ session: value, localDevelopment: false, logout: vi.fn() }}>
    <ModelSettingsWorkbench revision={0} advanced={<p>Fixture legacy adapter</p>} billing={<p>Fixture existing billing workspace</p>} onState={onState} />
  </ErpIdentityContext.Provider>));
  return onState;
}
function button(name: string, scope: ParentNode = host) {
  const found = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(item => (item.getAttribute("aria-label") ?? item.textContent?.trim()) === name);
  if (!found) throw new Error(`Missing synthetic settings button ${name}`);
  return found;
}
function field(name: string, scope: ParentNode = host) {
  const label = [...scope.querySelectorAll("label")].find(item => item.textContent?.trim().startsWith(name));
  const result = label?.querySelector<HTMLInputElement | HTMLSelectElement>("input,select");
  if (!result) throw new Error(`Missing synthetic settings field ${name}`);
  return result;
}
async function click(element: HTMLElement) { await act(async () => element.click()); }
async function fill(element: HTMLInputElement | HTMLSelectElement, value: string) {
  await act(async () => {
    const prototype = element instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLSelectElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event(element instanceof HTMLInputElement ? "input" : "change", { bubbles: true }));
  });
}
function fixture() {
  const state = { snapshot: snapshot(), commands: [] as ConfigurationRpc[], failWrite: false, holdWrite: false, finishWrite: null as (() => void) | null, writeSignal: null as AbortSignal | null };
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) !== "/api/creative-studio/configuration") throw new Error("Unexpected request outside synthetic configuration boundary");
    const command = JSON.parse(String(init?.body)) as ConfigurationRpc;
    state.commands.push(command);
    const authority = new Headers(init?.headers).get("x-yummyai-context-authority")!;
    const response = (json: unknown, status = 201) => Response.json(json, { status, headers: { "x-yummyai-context-authority": authority } });
    if (command.operation === "configuration.get") return response(state.snapshot);
    if (command.operation === "channel.save") {
      state.writeSignal = init?.signal ?? null;
      if (state.holdWrite) await new Promise<void>(resolve => { state.finishWrite = resolve; });
      if (state.failWrite) return response({ error: "PRIVATE_UNKNOWN_WRITE_DIAGNOSTIC" }, 502);
      state.snapshot = { ...state.snapshot, channels: [{ ...state.snapshot.channels[0]!, name: command.name, revision: "b".repeat(64) }] };
    } else if (command.operation === "purpose-defaults.save") {
      state.snapshot = { ...state.snapshot, defaults: { ...state.snapshot.defaults, purposeDefaults: { ...state.snapshot.defaults.purposeDefaults, ...command.defaults } }, defaultsRevision: state.snapshot.defaultsRevision + 1 };
    }
    return response(state.snapshot);
  }));
  return state;
}

describe("native settings workflow uses the shared authority-scoped configuration", () => {
  it("does not read or expose configuration without a current model configuration grant", async () => {
    const state = fixture(); await render(session(false));
    expect(state.commands).toEqual([]);
    expect(host.querySelectorAll("input,select,[role='tab']")).toHaveLength(0);
    expect(host.textContent).toContain("配置与填写已隐藏");
  });

  it("shows four semantic destinations and keeps local search and compatibility opening free of provider calls", async () => {
    const state = fixture(); await render();
    expect([...host.querySelectorAll('[role="tab"]')].map(item => item.textContent?.trim())).toEqual(["渠道连接", "模型库", "业务默认", "用量与费用"]);
    expect(state.commands.map(command => command.operation)).toEqual(["configuration.get"]);
    expect(host.textContent).not.toContain("Fixture legacy adapter");
    await click(button("模型库"));
    await fill(field("搜索模型或渠道"), "image-looking-text-id");
    expect(host.textContent).toContain("Synthetic first text");
    expect(host.textContent).toContain("文本任务");
    expect(host.textContent).toContain("能力未实测");
    expect([...host.querySelectorAll("button")].filter(item => item.textContent?.trim() === "删除模型").every(item => item.closest("details")?.open === false)).toBe(true);
    await click(button("用量与费用"));
    expect(host.textContent).toContain("Fixture existing billing workspace");
    expect(host.textContent).toMatch(/缺失用量.*未知/);
    expect(state.commands.map(command => command.operation)).toEqual(["configuration.get"]);
  });

  it("saves a purpose selection at the captured revision and retains unrelated personal purposes", async () => {
    const state = fixture(); await render(); await click(button("业务默认"));
    const select = field("订单定制信息解析");
    await fill(select, secondId);
    expect(button("保存业务用途默认").disabled).toBe(false);
    await click(button("保存业务用途默认"));
    expect(state.commands.filter(command => command.operation !== "configuration.get")).toEqual([{ operation: "purpose-defaults.save", revision: 7, defaults: { knowledge_answer: firstId, order_review: secondId } }]);
    expect(host.textContent).toContain("本人业务用途默认已保存");
    expect(button("保存业务用途默认").disabled).toBe(true);
    expect(state.snapshot.defaults.purposeDefaults?.knowledge_answer).toBe(firstId);
  });

  it("keeps a failed channel draft until a readback and never repeats an unknown write automatically", async () => {
    const state = fixture(); state.failWrite = true; await render();
    await click(button("编辑渠道 Synthetic private channel"));
    const dialog = host.querySelector<HTMLDialogElement>("dialog")!;
    await fill(field("渠道名称", dialog), "Synthetic unsaved channel");
    await click(button("保存渠道与模型", dialog));
    expect(state.commands.filter(command => command.operation === "channel.save")).toHaveLength(1);
    expect(host.textContent).toContain("配置结果尚未核对");
    expect(host.textContent).not.toContain("PRIVATE_UNKNOWN_WRITE_DIAGNOSTIC");
    expect((field("渠道名称", dialog) as HTMLInputElement).value).toBe("Synthetic unsaved channel");
    expect(button("保存渠道与模型", dialog).disabled).toBe(true);
    expect(dialog.open).toBe(true);
    const recheck = [...host.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent?.trim() === "读取原配置核对")!;
    await click(recheck);
    expect(state.commands.filter(command => command.operation === "channel.save")).toHaveLength(1);
    expect(state.commands.filter(command => command.operation === "configuration.get")).toHaveLength(2);
    expect((field("渠道名称", dialog) as HTMLInputElement).value).toBe("Synthetic unsaved channel");
  });

  it("clears private inputs on session invalidation and discards a late successful write response", async () => {
    const state = fixture(); await render();
    await click(button("编辑渠道 Synthetic private channel"));
    const dialog = host.querySelector<HTMLDialogElement>("dialog")!;
    await fill(field("渠道名称", dialog), "Synthetic input must disappear");
    state.holdWrite = true;
    await click(button("保存渠道与模型", dialog));
    expect(state.finishWrite).toBeTypeOf("function");
    await act(async () => window.dispatchEvent(new Event(ASSIST_INTENT_CLEAR_EVENT)));
    expect(state.writeSignal?.aborted).toBe(true);
    expect(host.querySelector("dialog")).toBeNull();
    expect(host.querySelectorAll("input,select")).toHaveLength(0);
    await act(async () => state.finishWrite!());
    expect(host.textContent).not.toContain("Synthetic private channel");
    expect(host.textContent).not.toContain("Synthetic input must disappear");
    expect(host.textContent).toContain("配置与填写已隐藏");
    expect(state.commands.filter(command => command.operation === "channel.save")).toHaveLength(1);
  });

  it("recovers an unknown channel creation by opening the saved channel instead of creating a duplicate", async () => {
    const state = fixture(); state.failWrite = true; await render();
    await click(button("添加渠道"));
    let dialog = host.querySelector<HTMLDialogElement>("dialog")!;
    await fill(field("渠道名称", dialog), "Synthetic recovered channel");
    await fill(field("接口地址", dialog), "https://synthetic-recovered.example.test/v1");
    await fill(field("API Key", dialog), "synthetic-new-draft-only");
    await click(button("保存渠道与模型", dialog));
    expect(state.commands.filter(command => command.operation === "channel.save")).toHaveLength(1);
    state.snapshot.channels.push({ ...state.snapshot.channels[0]!, id: id(40), name: "Synthetic recovered channel", baseUrl: "https://synthetic-recovered.example.test/v1", models: [], analysisModels: [] });
    await click(button("读取原配置核对", dialog));
    expect(host.textContent).toContain("渠道名称已存在");
    expect(button("保存渠道与模型", dialog).disabled).toBe(true);
    await click(button("放弃当前填写 打开已保存渠道核对", dialog));
    dialog = host.querySelector<HTMLDialogElement>("dialog")!;
    expect(dialog.querySelector("h2")?.textContent).toBe("编辑渠道 · Synthetic recovered channel");
    expect((field("API Key", dialog) as HTMLInputElement).value).toBe("");
    expect(state.commands.filter(command => command.operation === "channel.save")).toHaveLength(1);
  });
});
