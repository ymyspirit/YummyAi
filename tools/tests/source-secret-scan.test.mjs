import assert from "node:assert/strict";
import test from "node:test";
import { sourceHash, sourceSecretFindings } from "../scripts/source-secret-scan.mjs";

const content = 'const synthetic = "' + "Bearer " + "fixture".repeat(5) + '";\n';
const finding = sourceSecretFindings("fixture.test.ts", content)[0];
test("only an exact reviewed synthetic literal in its whole reviewed source is admitted", () => {
  assert.deepEqual(sourceSecretFindings("fixture.test.ts", content, [finding]), []);
  assert.equal(sourceSecretFindings("another.test.ts", content, [finding]).length, 1);
  assert.equal(sourceSecretFindings("fixture.test.ts", content.replace("fixture", "changed"), [finding]).length, 1);
});
test("editing reviewed source or duplicating an occurrence requires a fresh review", () => {
  assert.equal(sourceSecretFindings("fixture.test.ts", content + "// added\n", [finding]).length, 1);
  assert.equal(sourceSecretFindings("fixture.test.ts", content + content, [finding]).length, 2);
});
test("a private key body cannot inherit an exception for a negative header assertion", () => {
  const header = ["BEGIN ", "PRIVATE KEY"].join(""), original = 'expect(output).not.toContain("' + header + '");\n';
  const pin = sourceSecretFindings("key.test.ts", original)[0];
  assert.deepEqual(sourceSecretFindings("key.test.ts", original, [pin]), []);
  assert.equal(sourceSecretFindings("key.test.ts", original + "synthetic-added-key-material", [pin]).length, 1);
});
test("new API key literals remain rejected and line endings do not vary the source pin", () => {
  assert.equal(sourceSecretFindings("config.ts", 'const key="' + "sk-" + "q".repeat(32) + '";')[0].kind, "api_key_literal");
  assert.equal(sourceHash(content), sourceHash(content.replaceAll("\n", "\r\n")));
});
