import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/** Project-scoped authenticated encryption; erasing the wrapped project key erases every derivative. */
export function encryptProductionBytes(key: Uint8Array, bytes: Uint8Array): Buffer {
  if (key.byteLength !== 32) throw new Error("Invalid production project key");
  const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, nonce);
  const body = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return Buffer.concat([Buffer.from("PE01"), nonce, cipher.getAuthTag(), body]);
}

export function decryptProductionBytes(key: Uint8Array, input: Uint8Array): Buffer {
  const bytes = Buffer.from(input);
  if (key.byteLength !== 32 || bytes.byteLength < 32 || bytes.subarray(0, 4).toString() !== "PE01") throw new Error("Invalid production project envelope");
  const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(4, 16));
  decipher.setAuthTag(bytes.subarray(16, 32));
  return Buffer.concat([decipher.update(bytes.subarray(32)), decipher.final()]);
}
