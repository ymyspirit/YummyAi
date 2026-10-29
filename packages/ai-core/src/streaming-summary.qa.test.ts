import { describe, expect, it } from "vitest";
import { createStreamingSummary, rootStringPrefix } from "./streaming-summary.js";

describe("root summary streaming preview", () => {
  it("publishes real root text before the JSON response completes and emits only its new suffix", async () => {
    const chunks: string[] = [],
      preview = createStreamingSummary((text) => {
        chunks.push(text);
      });
    await preview('{"summary":"先核对');
    expect(chunks).toEqual(["先核对"]);
    await preview("本单要求");
    expect(chunks).toEqual(["先核对", "本单要求"]);
    await preview('","findings":[{"detail":"private extra field"}]}');
    expect(chunks.join("")).toBe("先核对本单要求");
  });

  it("decodes escaped newlines, quotes and backslashes across arbitrary delta boundaries", async () => {
    const text = '第一行\n"quoted" 与路径 C:\\source',
      chunks: string[] = [];
    const preview = createStreamingSummary((part) => {
      chunks.push(part);
    });
    const wire = JSON.stringify({ summary: text, findings: ["Not part of the visible summary"] });
    for (const character of wire) await preview(character);
    expect(chunks.join("")).toBe(text);
    expect(chunks.join("")).not.toContain("Not part");
  });

  it("withholds a split unicode escape surrogate until its complete pair is available", async () => {
    const chunks: string[] = [],
      preview = createStreamingSummary((text) => {
        chunks.push(text);
      });
    await preview('{"summary":"\\uD83D');
    expect(chunks).toEqual([]);
    await preview("\\uDC36");
    expect(chunks).toEqual(["🐶"]);
    await preview('"}');
    expect(chunks).toEqual(["🐶"]);
  });

  it("withholds a split literal surrogate instead of displaying replacement characters", async () => {
    const chunks: string[] = [],
      preview = createStreamingSummary((text) => {
        chunks.push(text);
      });
    await preview('{"summary":"pet ' + "\uD83D");
    expect(chunks.join("")).toBe("pet ");
    await preview("\uDC36" + '"}');
    expect(chunks.join("")).toBe("pet 🐶");
    expect(
      chunks.some((part) => /^[\uDC00-\uDFFF]/.test(part) || /[\uD800-\uDBFF]$/.test(part)),
    ).toBe(false);
  });

  it("never displays nested summaries, private findings or JSON keys as the assistant answer", async () => {
    const chunks: string[] = [],
      preview = createStreamingSummary((text) => {
        chunks.push(text);
      });
    await preview(
      '{"details":{"summary":"nested private text"},"analysis":"private reasoning","summary":"visible answer","other":"suffix"}',
    );
    expect(chunks).toEqual(["visible answer"]);
    expect(rootStringPrefix('{"analysis":"private reasoning"}', "summary")).toBeNull();
    expect(rootStringPrefix('{"summary":42}', "summary")).toBeNull();
  });

  it("keeps each display chunk bounded without breaking unicode pairs", async () => {
    const chunks: string[] = [],
      preview = createStreamingSummary((text) => {
        chunks.push(text);
      });
    const summary = "字".repeat(4095) + "🐶" + "界".repeat(5000);
    await preview(JSON.stringify({ summary }));
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((text) => text.length <= 4096)).toBe(true);
    expect(
      chunks.some((text) => /^[\uDC00-\uDFFF]/.test(text) || /[\uD800-\uDBFF]$/.test(text)),
    ).toBe(false);
    expect(chunks.join("")).toBe(summary);
  });

  it("stops preview on its memory ceiling without treating the buffer as a completed answer", async () => {
    const chunks: string[] = [],
      preview = createStreamingSummary((text) => {
        chunks.push(text);
      });
    await preview(" ".repeat(4 * 1024 * 1024 + 1));
    await preview('{"summary":"too late"}');
    expect(chunks).toEqual([]);
  });

  it("surfaces an unavailable preview sink rather than pretending its text was delivered", async () => {
    const preview = createStreamingSummary(() => {
      throw new Error("synthetic_display_disconnected");
    });
    await expect(preview('{"summary":"real delta')).rejects.toThrow(
      "synthetic_display_disconnected",
    );
  });
});
