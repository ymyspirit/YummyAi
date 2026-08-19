import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { DesignCreatePanel } from "./design-create-panel";

describe("DesignCreatePanel", () => {
  it("prefills the sole research record as a non-publishable reference", () => {
    const html = renderToStaticMarkup(
      <DesignCreatePanel
        initialSkuId="019f9a00-560d-7360-a08a-56eb7f1e8c42"
        researchSample={{
          id: "019f760e-8721-7743-9fdc-10f6df830337",
          shopName: "ThePineTroveGifts",
          title: "Personalized Name Pillow Cover Gift",
        }}
        skus={[{
          id: "019f9a00-560d-7360-a08a-56eb7f1e8c42",
          code: "P1G-PILLOW-STD",
          productName: "P1-G UI verification",
        }]}
      />,
    );

    expect(html).toContain("当前研究样例");
    expect(html).toContain("ThePineTroveGifts");
    expect(html).toContain("RESEARCH ONLY");
    expect(html).toContain("不复制竞品图片或文案");
    expect(html).toContain("P1G-PILLOW-STD");
    expect(html).toContain("创建设计任务");
  });

  it("blocks task creation until a real SKU exists", () => {
    const html = renderToStaticMarkup(<DesignCreatePanel skus={[]} />);

    expect(html).toContain("还没有可用 SKU");
    expect(html).toContain("请先在产品目录完成立项并创建 SPU/SKU");
    expect(html).toContain("返回产品开发");
    expect(html).not.toContain('type="submit"');
  });
});
