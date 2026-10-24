import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import process from "node:process";
import { log } from "node:console";
import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { URL, fileURLToPath, pathToFileURL } from "node:url";

export const sourceHash = value => createHash("sha256").update(String(value).replaceAll("\r\n", "\n")).digest("hex");
const expressions = [["bearer_literal", /Bearer [A-Za-z0-9._-]{20,}/g], ["api_key_literal", /sk-[A-Za-z0-9]{20,}/g],
  ["private_key_marker", /BEGIN (?:RSA |EC )?PRIVATE KEY/g]];
export function sourceSecretFindings(file, source, baseline = []) {
  const text = source.replaceAll("\r\n", "\n"), fileSha256 = sourceHash(text), observed = [];
  for (const [kind, regex] of expressions) for (const match of text.matchAll(new RegExp(regex))) {
    observed.push({ file, kind, line: text.slice(0, match.index).split("\n").length, literalSha256: sourceHash(match[0]),
      literalBytes: Buffer.byteLength(match[0]), fileSha256 });
  }
  return observed.filter(row => !baseline.some(pin => pin.file === row.file && pin.kind === row.kind && pin.line === row.line
    && pin.literalSha256 === row.literalSha256 && pin.literalBytes === row.literalBytes && pin.fileSha256 === row.fileSha256));
}

export async function scanTrackedSources(root) {
  const file = path.join(root, "tools/testing/synthetic-secret-literals.json"), baseline = JSON.parse(await fs.readFile(file, "utf8"));
  if (baseline.algorithm !== "sha256-normalized-lf-source-v1" || baseline.entries.length !== 11) throw new Error("Invalid reviewed synthetic baseline");
  const names = [...new Set(execFileSync("git", ["ls-files", "-c", "--others", "--exclude-standard", "-z"],
    { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }).split("\0").filter(Boolean))];
  const findings = []; let scanned = 0;
  for (const name of names) {
    if (name === "pnpm-lock.yaml") continue;
    if (/(?:^|\/)\.env(?:$|\.)/.test(name) && !name.endsWith(".env.example")) { findings.push({ file: name, kind: "private_environment_file" }); continue; }
    const at = path.join(root, name), stat = await fs.lstat(at).catch(error => error.code === "ENOENT" ? null : Promise.reject(error));
    if (!stat) continue;
    if (!stat.isFile()) throw new Error("Only regular tracked source files may be published");
    const bytes = await fs.readFile(at); if (bytes.includes(0)) continue;
    scanned++; findings.push(...sourceSecretFindings(name, bytes.toString("utf8"), baseline.entries));
  }
  return { scanned, reviewedSyntheticLiterals: baseline.entries.length, findings };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = fileURLToPath(new URL("../../", import.meta.url)), result = await scanTrackedSources(root);
  log(JSON.stringify(result)); if (result.findings.length) process.exitCode = 1;
}
