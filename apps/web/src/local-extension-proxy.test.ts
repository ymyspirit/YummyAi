import { describe, expect, it } from "vitest";

import { isTrustedLocalExtensionRequest } from "./local-extension-proxy";

describe("isTrustedLocalExtensionRequest", () => {
  it("accepts only the configured local Chrome extension origin", () => {
    const request = new Request("http://localhost:3000/v1/captures", {
      headers: {
        origin: "chrome-extension://pbfkpadkdjbjgmibceaelflmgjhclnhl",
        "x-yummyai-extension-id": "pbfkpadkdjbjgmibceaelflmgjhclnhl",
      },
      method: "POST",
    });

    expect(isTrustedLocalExtensionRequest(request)).toBe(true);
  });

  it("rejects a browser page or a different extension", () => {
    const request = new Request("http://localhost:3000/v1/captures", {
      headers: { origin: "http://localhost:3000" },
      method: "POST",
    });

    expect(isTrustedLocalExtensionRequest(request)).toBe(false);
  });
});
