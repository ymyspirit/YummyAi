import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CustomizationSchema } from "@yummyai/contracts";
import { OrderWorkImageBinding } from "./order-work-image-binding";

const fields = CustomizationSchema.parse({ version: 1, fields: [
  { key: "buyer_photo", label: "顾客原图", type: "image", required: true,
    validation: { allowedMediaTypes: ["image/png"], maxFiles: 1, maxBytes: 1_000_000 } },
] }).fields;
const render = (usage: string | undefined, options = fields) => renderToStaticMarkup(
  <OrderWorkImageBinding fields={options} usage={usage} disabled={false} onChange={() => undefined} />,
);

describe("image assignment explains selection separately from schema binding", () => {
  it("shows an unknown existing use verbatim and offers the actual required image field", () => {
    const html = render("正面 · 保留完整人物");
    expect(html).toContain("对应图片字段");
    expect(html).toContain("原用途：正面 · 保留完整人物");
    expect(html).toContain("顾客原图（必填）</option>");
    expect(html).toContain("已选此图，尚未绑定图片字段");
    expect(html).not.toContain("已绑定 顾客原图");
  });

  it("shows a canonical binding and leaves multiple image fields explicitly unassigned", () => {
    expect(render("buyer_photo")).toContain("已绑定 顾客原图");
    const html = render("", [...fields, { ...fields[0]!, key: "back_photo", label: "背面参考图" }]);
    expect(html).toContain("请选择这张图片对应的字段");
    expect(html).toContain("背面参考图（必填）</option>");
    expect(html).toContain("尚未绑定图片字段");
  });

  it("keeps the general use input for products without image schema and hides unselected controls", () => {
    const html = render("正面", []);
    expect(html).toContain("制作用途");
    expect(html).toContain('value="正面"');
    expect(html).not.toContain("对应图片字段");
    expect(render(undefined)).toContain('hidden=""');
    expect(render(undefined)).toContain('disabled=""');
  });
});
