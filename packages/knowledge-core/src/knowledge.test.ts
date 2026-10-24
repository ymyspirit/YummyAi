import { describe, expect, it, vi } from "vitest";
import JSZip from "jszip";
import type { KnowledgeFields } from "@yummyai/contracts/knowledge";
import {
  parseKnowledgeDocument,
  redactKnowledgeText,
  knowledgeCandidatesFromText,
} from "./documents.js";
import { knowledgeScopeMatches } from "./governance.js";
import {
  knowledgeOfficialUrl,
  knowledgePublicAddress,
  normalizeKnowledgeHtml,
  readKnowledgeOfficialSource,
} from "./sources.js";
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "127.0.0.1", family: 4 }]),
}));
const fields: KnowledgeFields = {
  title: "Fixture",
  summary: "",
  body: "Fixture",
  topic: "operations",
  platform: "amazon",
  market: "US",
  spuId: null,
  sourceType: "team",
  sourceLabel: "Fixture SOP",
  sourceUrl: "",
  owner: "Fixture operator",
  verifiedOn: "2026-01-01",
  reviewDueOn: "2099-12-31",
  tags: [],
};
describe("knowledge documents and scoped governance safety", () => {
  it("preserves UTF-8 SOP sections and positions without publishing extraction", async () => {
    const value = await parseKnowledgeDocument(
      Buffer.from("# 照片\n\n保留照片原件。\n\n# 文案\n\n只使用批准产品事实。"),
      "sop.md",
    );
    const candidates = knowledgeCandidatesFromText(value.text, fields);
    expect(candidates.map((c) => c.fields.title)).toEqual(["照片", "文案"]);
    expect(candidates[0]?.locator).toContain("第 1");
    expect(candidates[1]?.fields.body).toContain("批准产品事实");
    expect(candidates[0]?.excerpt).toContain("保留照片原件");
  });
  it("rejects invalid UTF-8, legacy Word and oversized documents", async () => {
    await expect(parseKnowledgeDocument(Uint8Array.from([0xff]), "bad.txt")).rejects.toThrow();
    await expect(parseKnowledgeDocument(Buffer.from("word"), "old.doc")).rejects.toThrow("DOC");
    await expect(
      parseKnowledgeDocument(new Uint8Array(5 * 1024 * 1024 + 1), "huge.pdf"),
    ).rejects.toThrow("5 MB");
  });
  it("extracts DOCX text without fetching relationships or executing document code", async () => {
    const zip = new JSZip();
    zip.file(
      "word/document.xml",
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Fixture SOP 中文</w:t></w:r></w:p><w:p><w:r><w:t>Approved product facts</w:t></w:r></w:p></w:body></w:document>',
    );
    zip.file(
      "word/_rels/document.xml.rels",
      '<Relationships><Relationship Target="http://127.0.0.1/private"/></Relationships>',
    );
    expect(
      (await parseKnowledgeDocument(await zip.generateAsync({ type: "uint8array" }), "sop.docx"))
        .text,
    ).toContain("中文\n\nApproved");
  });
  it("rejects Word external entities and inflated ZIP payloads", async () => {
    const zip = new JSZip();
    zip.file(
      "word/document.xml",
      '<!DOCTYPE foo [<!ENTITY x SYSTEM "file:///secret">]><w:p>&x;</w:p>',
    );
    await expect(
      parseKnowledgeDocument(await zip.generateAsync({ type: "uint8array" }), "entity.docx"),
    ).rejects.toThrow("外部实体");
    zip.file("word/document.xml", "A".repeat(2_000_000));
    await expect(
      parseKnowledgeDocument(
        await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" }),
        "bomb.docx",
      ),
    ).rejects.toThrow("解压");
  });
  it("extracts real PDF text and reports empty scan pages explicitly", async () => {
    expect((await parseKnowledgeDocument(pdf("Fixture operating SOP"), "sop.pdf")).text).toContain(
      "Fixture operating SOP",
    );
    await expect(parseKnowledgeDocument(pdf(""), "scan.pdf")).rejects.toThrow("OCR");
  });
  it("redacts report identity and credential columns, preserves dates and is idempotent", () => {
    const value = redactKnowledgeText(
      "date,customer_name,email,api_key,revenue\n2026-10-01,Alice,alice@example.test,SYNTHETIC_PRIVATE,125.40",
    );
    expect(value.text).not.toContain("Alice");
    expect(value.text).not.toContain("SYNTHETIC_PRIVATE");
    expect(value.text).toContain("125.40");
    expect(value.text).toContain("2026-10-01");
    expect(redactKnowledgeText(value.text).text).toBe(value.text);
    expect(
      redactKnowledgeText(
        "Authorization: Bearer fixture-secret\nCustomer name: Alice\nphone: +1 555 123 4567",
      ).text,
    ).not.toContain("fixture-secret");
  });
  it("never expands a narrow document into a wider market or product scope", () => {
    const scope = {
      query: "sop",
      topic: "all" as const,
      platform: "amazon" as const,
      market: "US",
      spuIds: [],
    };
    expect(knowledgeScopeMatches(fields, scope)).toBe(true);
    expect(knowledgeScopeMatches(fields, { ...scope, market: "ALL" })).toBe(false);
    expect(knowledgeScopeMatches({ ...fields, platform: "etsy" }, scope)).toBe(false);
  });
  it("blocks private, loopback, metadata, credentials and DNS rebind destinations", async () => {
    for (const ip of [
      "127.0.0.1",
      "10.0.0.1",
      "100.64.0.1",
      "169.254.169.254",
      "192.168.1.1",
      "::1",
      "::ffff:127.0.0.1",
      "2001:db8::1",
      "2001::1",
    ])
      expect(knowledgePublicAddress(ip)).toBe(false);
    expect(knowledgePublicAddress("8.8.8.8")).toBe(true);
    expect(knowledgePublicAddress("2606:4700:4700::1111")).toBe(true);
    for (const url of [
      "http://example.com",
      "https://127.1",
      "https://localhost",
      "https://user:password@example.com",
      "https://example.com?access_token=x",
    ])
      expect(() => knowledgeOfficialUrl(url)).toThrow();
    await expect(readKnowledgeOfficialSource("https://official.example.com/sop")).rejects.toThrow(
      "非公开地址",
    );
  });
  it("ignores official page navigation noise while preserving policy paragraphs", () => {
    const first = normalizeKnowledgeHtml(
      "<header>v1</header><main><p>Policy A</p><p>Approved SOP</p></main><footer>timestamp1</footer>",
    );
    const second = normalizeKnowledgeHtml(
      "<header>v2</header><main><p>Policy A</p><p>Approved SOP</p></main><footer>timestamp2</footer>",
    );
    expect(first).toBe(second);
    expect(first).toBe("Policy A\n\nApproved SOP");
  });
});
function pdf(text: string): Uint8Array {
  const stream = text ? "BT /F1 12 Tf 30 100 Td (" + text + ") Tj ET" : "";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Length " + stream.length + " >>\nstream\n" + stream + "\nendstream",
  ];
  let value = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(value));
    value += i + 1 + " 0 obj\n" + body + "\nendobj\n";
  });
  const start = Buffer.byteLength(value);
  value +=
    "xref\n0 6\n0000000000 65535 f \n" +
    offsets
      .slice(1)
      .map((o) => String(o).padStart(10, "0") + " 00000 n \n")
      .join("") +
    "trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n" +
    start +
    "\n%%EOF";
  return Buffer.from(value);
}
