import { BadRequestException } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parseRequestSchema } from "./request-schema.js";

describe("HTTP request validation boundary", () => {
  it("rejects malformed input as a known 400 without exposing its raw values or unknown keys", () => {
    try { parseRequestSchema(z.object({ quantity: z.int().positive() }).strict(), { quantity: -1, synthetic_private_value: "synthetic-credential-must-not-be-returned" }); throw Error("Expected rejection"); }
    catch (cause) {
      expect(cause).toBeInstanceOf(BadRequestException);
      const rejection = cause as BadRequestException; expect(rejection.getStatus()).toBe(400);
      expect(JSON.stringify(rejection.getResponse())).not.toMatch(/synthetic_private_value|synthetic-credential/);
    }
  });
  it("keeps schema normalization and propagates actual implementation errors", () => {
    expect(parseRequestSchema(z.object({ flag: z.boolean().default(false) }), {})).toEqual({ flag: false });
    const broken = z.string().transform(() => { throw Error("Synthetic implementation failure"); });
    expect(() => parseRequestSchema(broken, "valid")).toThrow("Synthetic implementation failure");
  });
});
