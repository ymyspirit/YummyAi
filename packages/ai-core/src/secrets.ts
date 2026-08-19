import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const REDACTED = "[REDACTED]";
const SENSITIVE_KEY = /(api[-_]?key|authorization|secret|token|credential|password)/i;

export class SecretVault {
  private readonly encryptionKey: Buffer;

  constructor(encryptionKey: Uint8Array) {
    if (encryptionKey.byteLength !== 32) throw new TypeError("Secret encryption key must be exactly 32 bytes");
    this.encryptionKey = Buffer.from(encryptionKey);
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.encryptionKey, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return ["v1", iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(".");
  }

  withSecret<T>(encrypted: string, callback: (secret: string) => T): T {
    const parts = encrypted.split(".");
    if (parts.length !== 4 || parts[0] !== "v1") throw new TypeError("Unsupported encrypted secret envelope");
    const iv = Buffer.from(parts[1]!, "base64url");
    const tag = Buffer.from(parts[2]!, "base64url");
    const ciphertext = Buffer.from(parts[3]!, "base64url");
    const decipher = createDecipheriv("aes-256-gcm", this.encryptionKey, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    try {
      return callback(plaintext.toString("utf8"));
    } finally {
      plaintext.fill(0);
    }
  }
}

export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, SENSITIVE_KEY.test(key) ? REDACTED : redactSecrets(child)]),
  );
}
