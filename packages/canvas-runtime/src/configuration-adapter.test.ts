import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { adaptConfiguration } from "../configuration-adapter";
const source = (name: string) => readFileSync(new URL(`../vendor/src/${name}`, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), "utf8").replaceAll("\r\n", "\n");

describe("pinned upstream configuration compatibility", () => {
  it("adapts upstream components without exposing unsupported protocols or provider scripts", () => {
    const name = "components/layout/channel-editor-drawer.tsx";
    const adapted = adaptConfiguration(source(name), name);
    expect(adapted).toContain("await onSave(");
    expect(adapted).toContain("selectedNames={selectedNames}");
    expect(adapted).not.toContain("<ModelScriptEditor");
    expect(adapted).not.toContain('{ label: "Gemini"');
    expect(adapted).toContain("凭据已保存；留空保留原 Key");
  });
  it("uses ERP discovery with existing server credentials and fails closed on upstream drift", () => {
    const name = "components/layout/model-select-modal.tsx", code = source(name);
    expect(adaptConfiguration(code, name)).toContain("isSavedSettingsChannel(channel.id)");
    expect(() => adaptConfiguration(code.replace("!channel.apiKey.trim()", "false"), name)).toThrow("requires upstream review");
    expect(adaptConfiguration(source("services/api/image.ts"), "services/api/image.ts")).toContain("return discoverChannelModels(channel)");
  });
});
