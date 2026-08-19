import { createHash } from "node:crypto";

export function checksumSha256(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}
