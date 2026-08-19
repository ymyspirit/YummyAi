import { describe, expect, it } from "vitest";

import { MockupTemplatePolicyError, assertPsdHeader } from "./policy.js";

function psdHeader(version = 1) {
  const bytes = new Uint8Array(26);
  bytes.set([56, 66, 80, 83, 0, version]);
  return bytes;
}

describe("controlled PSD policy", () => {
  it("accepts PSD v1 and rejects PSB", () => {
    expect(() => assertPsdHeader(psdHeader())).not.toThrow();
    expect(() => assertPsdHeader(psdHeader(2))).toThrowError(MockupTemplatePolicyError);
  });

  it("rejects non-PSD bytes", () => {
    expect(() => assertPsdHeader(new Uint8Array([1, 2, 3]))).toThrowError(/Photoshop document/);
  });
});
