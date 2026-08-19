import { describe, expect, it } from "vitest";
import { pinoRedactPaths, redactLogRecord } from "./redaction.js";

describe("observability redaction", () => {
  it("redacts credentials recursively and excludes raw prompt content", () => {
    const output = redactLogRecord({ req: { headers: { authorization: "Bearer secret" } }, apiKey: "key", job: { data: { payload: { credentials: { password: "pw" }, userPrompt: "private product idea" } } } });
    expect(JSON.stringify(output)).not.toContain("Bearer secret"); expect(JSON.stringify(output)).not.toContain("private product idea");
    expect(output).toMatchObject({ apiKey: "[REDACTED]", job: { data: { payload: { credentials: "[REDACTED]", userPrompt: "[CONTENT OMITTED]" } } } });
    expect(pinoRedactPaths).toContain("job.data.payload.credentials");
  });
});
