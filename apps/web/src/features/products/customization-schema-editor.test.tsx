import type { CustomizationField } from "@yummyai/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CustomizationSchemaEditor, isCustomizationFieldVisible } from "./customization-schema-editor";

const conditional: CustomizationField = {
  key: "gift_message",
  label: "Gift message",
  type: "long_text",
  required: false,
  visibleWhen: { fieldKey: "is_gift", operator: "equals", value: "yes" },
};

describe("CustomizationSchemaEditor", () => {
  it("evaluates conditional fields against current values", () => {
    expect(isCustomizationFieldVisible(conditional, { is_gift: "yes" })).toBe(true);
    expect(isCustomizationFieldVisible(conditional, { is_gift: "no" })).toBe(false);
  });

  it("supports contains and non-empty visibility operators", () => {
    expect(isCustomizationFieldVisible({ ...conditional, visibleWhen: { fieldKey: "extras", operator: "contains", value: "box" } }, { extras: ["box", "card"] })).toBe(true);
    expect(isCustomizationFieldVisible({ ...conditional, visibleWhen: { fieldKey: "name", operator: "not_empty" } }, { name: "Ada" })).toBe(true);
  });

  it("renders conditional references and every addable field type", () => {
    const html = renderToStaticMarkup(<CustomizationSchemaEditor initialSchema={{ version: 1, fields: [
      { key: "is_gift", label: "Gift", type: "single_choice", required: false, options: [{ value: "yes", label: "Yes" }] },
      conditional,
    ] }} />);
    expect(html).toContain("gift_message");
    expect(html).toContain("显示条件");
    for (const label of ["短文本", "长文本", "图片", "日期", "颜色", "单选", "多选"]) expect(html).toContain(label);
  });
});
