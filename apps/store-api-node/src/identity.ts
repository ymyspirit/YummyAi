import { createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, generateKeyPair,
  randomBytes, scrypt, X509Certificate, type KeyObject } from "node:crypto";
import { isIP } from "node:net";
import { promisify } from "node:util";
import { z } from "zod";
import { StoreNodeEnrollmentBundleSchema, StoreNodeEnrollmentResultSchema, type StoreNodeEnrollmentResult } from "@yummyai/contracts/marketplace/store-node";
import { checkStoreNodePassphrase, storeNodeOrigin } from "./config.js";
import { nodeCheck, StoreNodeError } from "./error.js";

const derive = promisify(scrypt);
const CipherSchema = z.object({ version: z.literal(1), salt: z.string(), iv: z.string(), tag: z.string(), cipher: z.string() }).strict();
export function storeNodeSpki(key: KeyObject): string { return createHash("sha256").update(createPublicKeyFor(key).export({ type: "spki", format: "der" })).digest("hex"); }
function createPublicKeyFor(key: KeyObject): KeyObject { return key.type === "public" ? key : createPublicKey(key); }
export async function generateStoreNodeKeys(passphrase: string): Promise<{ publicKeyPem: string; privateKeyPem: string; publicKeySpkiSha256: string }> {
  checkStoreNodePassphrase(passphrase);
  const pair = await new Promise<{ publicKey: KeyObject; privateKey: KeyObject }>((resolve, reject) =>
    generateKeyPair("rsa", { modulusLength: 3072, publicExponent: 0x10001 }, (error, publicKey, privateKey) => error ? reject(new StoreNodeError("store_node_key_generation_failed")) : resolve({ publicKey, privateKey })));
  return { publicKeyPem: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKeyPem: pair.privateKey.export({ type: "pkcs8", format: "pem", cipher: "aes-256-cbc", passphrase }).toString(), publicKeySpkiSha256: storeNodeSpki(pair.publicKey) };
}
export function loadStoreNodeKey(publicKeyPem: string, privateKeyPem: string, passphrase: string): KeyObject {
  try {
    checkStoreNodePassphrase(passphrase);
    nodeCheck(privateKeyPem.startsWith("-----BEGIN ENCRYPTED PRIVATE KEY-----\n"));
    const key = createPrivateKey({ key: privateKeyPem, format: "pem", passphrase });
    nodeCheck(key.asymmetricKeyType === "rsa" && (key.asymmetricKeyDetails?.modulusLength ?? 0) >= 3072
      && (key.asymmetricKeyDetails?.modulusLength ?? 0) <= 4096
      && createPublicKey(key).export({ type: "spki", format: "pem" }).toString() === publicKeyPem);
    return key;
  } catch { throw new StoreNodeError("store_node_identity_invalid"); }
}
export async function sealStoreNodeState(value: unknown, passphrase: string, spki: string): Promise<Buffer> {
  return sealLocal(value, passphrase, spki, "erp-store-node-state-v1", 65536);
}
export async function sealStoreNodeJournal(value: unknown, passphrase: string, spki: string): Promise<Buffer> {
  return sealLocal(value, passphrase, spki, "erp-store-node-execution-journal-v1", 48 * 1024 * 1024);
}
async function sealLocal(value: unknown, passphrase: string, spki: string, domain: string, maximum: number): Promise<Buffer> {
  checkStoreNodePassphrase(passphrase); nodeCheck(/^[a-f0-9]{64}$/.test(spki));
  const salt = randomBytes(16), iv = randomBytes(12), key = await derive(passphrase, salt, 32) as Buffer;
  const plain = Buffer.from(JSON.stringify(value));
  try {
    nodeCheck(plain.length <= maximum);
    const cipher = createCipheriv("aes-256-gcm", key, iv); cipher.setAAD(Buffer.from(`${domain}:${spki}`));
    const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
    return Buffer.from(JSON.stringify({ version: 1, salt: salt.toString("base64"), iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"), cipher: encrypted.toString("base64") }));
  } finally { key.fill(0); plain.fill(0); }
}
export async function openStoreNodeState(bytes: Uint8Array, passphrase: string, spki: string): Promise<unknown> {
  return openLocal(bytes, passphrase, spki, "erp-store-node-state-v1", 100000, 65536);
}
export async function openStoreNodeJournal(bytes: Uint8Array, passphrase: string, spki: string): Promise<unknown> {
  return openLocal(bytes, passphrase, spki, "erp-store-node-execution-journal-v1", 64 * 1024 * 1024, 48 * 1024 * 1024);
}
async function openLocal(bytes: Uint8Array, passphrase: string, spki: string, domain: string, maximum: number, maximumPlain: number): Promise<unknown> {
  let key: Buffer | undefined, plain: Buffer | undefined;
  try {
    nodeCheck(bytes.byteLength <= maximum); checkStoreNodePassphrase(passphrase); nodeCheck(/^[a-f0-9]{64}$/.test(spki));
    const envelope = CipherSchema.parse(JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes)));
    const salt = base64(envelope.salt, 16), iv = base64(envelope.iv, 12), tag = base64(envelope.tag, 16), cipher = base64(envelope.cipher, undefined, maximum);
    nodeCheck(cipher.length <= maximumPlain);
    key = await derive(passphrase, salt, 32) as Buffer;
    const decipher = createDecipheriv("aes-256-gcm", key, iv); decipher.setAAD(Buffer.from(`${domain}:${spki}`)); decipher.setAuthTag(tag);
    plain = Buffer.concat([decipher.update(cipher), decipher.final()]);
    return JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(plain));
  } catch { throw new StoreNodeError("store_node_identity_invalid"); }
  finally { key?.fill(0); plain?.fill(0); }
}
function base64(value: string, length?: number, maximum = 90000): Buffer {
  nodeCheck(value.length <= maximum && value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value));
  const bytes = Buffer.from(value, "base64"); nodeCheck(bytes.toString("base64") === value && (!length || bytes.length === length)); return bytes;
}
export function validateStoreNodeCa(caPem: string): X509Certificate {
  const parts = caPem.match(/-----BEGIN CERTIFICATE-----\n[A-Za-z0-9+/=\n]+-----END CERTIFICATE-----\n/g);
  nodeCheck(parts && parts.length >= 1 && parts.length <= 4 && parts.join("") === caPem, "store_node_certificate_invalid");
  const chain = parts.map(part => new X509Certificate(part));
  for (let index = 0; index < chain.length; index++) {
    const certificate = chain[index]!;
    nodeCheck(certificate.ca && certificate.toString() === parts[index] && new Date(certificate.validFrom).getTime() <= Date.now()
      && new Date(certificate.validTo).getTime() > Date.now(), "store_node_certificate_invalid");
    if (index + 1 < chain.length) nodeCheck(certificate.checkIssued(chain[index + 1]!) && certificate.verify(chain[index + 1]!.publicKey), "store_node_certificate_invalid");
    if (certificate.subject === certificate.issuer) nodeCheck(certificate.verify(certificate.publicKey), "store_node_certificate_invalid");
  }
  // The final certificate is the explicitly distributed deployment trust anchor;
  // it may be a dedicated intermediate rather than a public root CA.
  return chain[0]!;
}
export function validateStoreNodeBundle(raw: unknown, spki: string) {
  try {
    const bundle = StoreNodeEnrollmentBundleSchema.parse(raw);
    storeNodeOrigin(bundle.enrollmentOrigin); storeNodeOrigin(bundle.runtimeOrigin); validateStoreNodeCa(bundle.caCertificatePem);
    nodeCheck(bundle.publicKeySpkiSha256 === spki && Date.parse(bundle.expiresAt) > Date.now(), "store_node_enrollment_invalid"); return bundle;
  } catch { throw new StoreNodeError("store_node_enrollment_invalid"); }
}
export function validateStoreNodeIdentity(raw: unknown, key: KeyObject): StoreNodeEnrollmentResult {
  try {
    const result = StoreNodeEnrollmentResultSchema.parse(raw), ca = validateStoreNodeCa(result.caCertificatePem), certificate = new X509Certificate(result.certificatePem);
    storeNodeOrigin(result.runtimeOrigin);
    nodeCheck(!certificate.ca && certificate.checkIssued(ca) && certificate.verify(ca.publicKey) && certificate.checkPrivateKey(key)
      && certificate.subjectAltName === `URI:urn:yummyai:store-node:${result.nodeId}` && certificate.keyUsage?.length === 1
      && certificate.keyUsage[0] === "1.3.6.1.5.5.7.3.2" && new Date(certificate.validFrom).getTime() <= Date.now()
      && Date.parse(result.expiresAt) === new Date(certificate.validTo).getTime() && Date.parse(result.expiresAt) > Date.now()
      && new Date(certificate.validTo).getTime() - new Date(certificate.validFrom).getTime() <= 86400000, "store_node_certificate_invalid");
    return result;
  } catch { throw new StoreNodeError("store_node_certificate_invalid"); }
}
export function verifyStoreNodeServer(host: string, certificate: X509Certificate): boolean {
  return Boolean(isIP(host) ? certificate.checkIP(host) : certificate.checkHost(host));
}
