import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { expect, test } from "@playwright/test";
import { JSDOM } from "jsdom";

import { amazonParser } from "../src/parsers/amazon.js";
import { etsyParser } from "../src/parsers/etsy.js";

test("Chrome-compatible parser captures the supported Amazon fixture", async () => {
  const draft = await parse("tools/fixtures/amazon/product-basic.html", "https://www.amazon.com/dp/B0ABC12345", amazonParser);
  expect(draft.platform).toBe("amazon"); expect(draft.title).toBeTruthy(); expect(draft.domain).toBe("research"); expect(status(draft)).toMatch(/complete|partial/);
});

test("Chromium and Edge-compatible parser diagnoses the Etsy personalization fixture", async () => {
  const draft = await parse("tools/fixtures/etsy/product-personalized.html", "https://www.etsy.com/listing/1234567890/personalized-gift", etsyParser);
  expect(draft.platform).toBe("etsy"); expect(draft.title).toBeTruthy(); expect(draft.contentBlocks.some((block) => block.kind === "personalization")).toBe(true); expect(status(draft)).toMatch(/complete|partial/);
});

async function parse(path: string, url: string, parser: typeof amazonParser) { const html = await readFile(resolve(process.cwd(), path), "utf8"); const dom = new JSDOM(html, { url }); return parser.parse(dom.window.document, new URL(url)); }
function status(draft: { diagnostics: Array<{ severity: string }> }) { return draft.diagnostics.some((item) => item.severity === "error") ? "partial" : "complete"; }
