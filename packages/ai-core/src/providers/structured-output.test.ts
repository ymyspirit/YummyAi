import { expect, it } from "vitest";
import { z } from "zod";
import { parseStructuredOutput } from "./shared.js";
const schema = z.object({passed: z.boolean()}).strict();
it("rejects truncated, missing and malformed output without exposing provider content", () => {
  expect(() => parseStructuredOutput({choices: [{finish_reason: "length", message: {content: "sensitive"}}]}, schema)).toThrow("model_output_truncated");
  expect(() => parseStructuredOutput({status: "incomplete"}, schema)).toThrow("model_output_truncated");
  expect(() => parseStructuredOutput({choices: [{message: {content: ""}}]}, schema)).toThrow("model_output_missing");
  expect(() => parseStructuredOutput({choices: [{message: {content: "sensitive"}}]}, schema)).toThrow("model_output_invalid_json");
});
it("validates complete responses and chat outputs against the same schema", () => {
  expect(parseStructuredOutput({output_text: '{"passed":true}'}, schema)).toEqual({passed: true});
  expect(parseStructuredOutput({choices: [{message: {content: '{"passed":false}'}}]}, schema)).toEqual({passed: false});
  expect(() => parseStructuredOutput({output_text: '{"passed":"yes"}'}, schema)).toThrow();
});
