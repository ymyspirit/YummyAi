import { constants, createCipheriv, createDecipheriv, createHash, createPublicKey, privateDecrypt, publicEncrypt, randomBytes,
  type KeyObject } from "node:crypto";
import { STORE_NODE_EXECUTION_RESULT_BYTES, StoreNodeCipherSchema, StoreNodeExecutionCredentialSchema, StoreNodeSealedCredentialSchema,
  storeNodeExecutionCipherText, storeNodeExecutionSealText, type StoreNodeCipher, type StoreNodeExecutionCredential,
  type StoreNodeExecutionLease, type StoreNodeSealedCredential } from "@yummyai/contracts/marketplace/store-node-execution";

type SealPins = Pick<StoreNodeExecutionLease, "id" | "nodeId" | "certificateGeneration" | "requestChecksum" | "claimId">;
type Purpose = "checkpoint" | "completion";
export class StoreNodeExecutionSealError extends Error { readonly code = "store_node_execution_failed"; constructor() { super("store_node_execution_failed"); } }

export function createStoreNodeSealedCredential(payload: StoreNodeExecutionCredential, lease: SealPins, publicKeyPem: string): { sealed: StoreNodeSealedCredential; key: Buffer } {
  const key = randomBytes(32);
  try {
    const publicKey = createPublicKey(publicKeyPem), bits = publicKey.asymmetricKeyDetails?.modulusLength ?? 0;
    if (publicKey.asymmetricKeyType !== "rsa" || bits < 3072 || bits > 4096) throw new StoreNodeExecutionSealError();
    const cipher = seal(StoreNodeExecutionCredentialSchema.parse(payload), key, lease, "credential");
    const wrappedKey = publicEncrypt({ key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, key).toString("base64url");
    return { sealed: StoreNodeSealedCredentialSchema.parse({ ...cipher, wrappedKey }), key };
  } catch { key.fill(0); throw new StoreNodeExecutionSealError(); }
}
export function openStoreNodeSealedCredential(sealed: StoreNodeSealedCredential, lease: SealPins, privateKey: KeyObject): { payload: StoreNodeExecutionCredential; key: Buffer } {
  let key: Buffer | undefined;
  try {
    const value = StoreNodeSealedCredentialSchema.parse(sealed), bits = privateKey.asymmetricKeyDetails?.modulusLength ?? 0;
    if (privateKey.asymmetricKeyType !== "rsa" || bits < 3072 || bits > 4096) throw new StoreNodeExecutionSealError();
    key = privateDecrypt({ key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, decode(value.wrappedKey));
    if (key.length !== 32) throw new StoreNodeExecutionSealError();
    const payload = StoreNodeExecutionCredentialSchema.parse(open({ nonce: value.nonce, tag: value.tag, ciphertext: value.ciphertext }, key, lease, "credential"));
    return { payload, key };
  } catch { key?.fill(0); throw new StoreNodeExecutionSealError(); }
}
export function openStoreNodeExecutionCredentialSeed(cipher: StoreNodeCipher, key: Buffer, lease: SealPins): StoreNodeExecutionCredential {
  try { return StoreNodeExecutionCredentialSchema.parse(open(cipher, key, lease, "credential")); }
  catch { throw new StoreNodeExecutionSealError(); }
}
export function sealStoreNodeExecutionPayload(raw: unknown, key: Buffer, lease: SealPins, purpose: Purpose): StoreNodeCipher { return seal(raw, key, lease, purpose); }
export function openStoreNodeExecutionPayload(cipher: StoreNodeCipher, key: Buffer, lease: SealPins, purpose: Purpose): unknown { return open(cipher, key, lease, purpose); }
export function storeNodeExecutionPayloadChecksum(cipher: StoreNodeCipher): string { return createHash("sha256").update(storeNodeExecutionCipherText(cipher)).digest("hex"); }

function seal(raw: unknown, key: Buffer, lease: SealPins, purpose: "credential" | Purpose): StoreNodeCipher {
  let plain: Buffer | undefined;
  try {
    if (key.length !== 32) throw new StoreNodeExecutionSealError();
    plain = Buffer.from(JSON.stringify(raw), "utf8");
    if (!plain.length || plain.length > STORE_NODE_EXECUTION_RESULT_BYTES) throw new StoreNodeExecutionSealError();
    const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(Buffer.from(storeNodeExecutionSealText(lease, purpose)));
    const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
    return StoreNodeCipherSchema.parse({ nonce: nonce.toString("base64url"), ciphertext: ciphertext.toString("base64url"), tag: cipher.getAuthTag().toString("base64url") });
  } catch { throw new StoreNodeExecutionSealError(); }
  finally { plain?.fill(0); }
}
function open(raw: StoreNodeCipher, key: Buffer, lease: SealPins, purpose: "credential" | Purpose): unknown {
  let plain: Buffer | undefined;
  try {
    if (key.length !== 32) throw new StoreNodeExecutionSealError();
    const value = StoreNodeCipherSchema.parse(raw), nonce = decode(value.nonce), tag = decode(value.tag), ciphertext = decode(value.ciphertext);
    if (nonce.length !== 12 || tag.length !== 16 || ciphertext.length > STORE_NODE_EXECUTION_RESULT_BYTES) throw new StoreNodeExecutionSealError();
    const decipher = createDecipheriv("aes-256-gcm", key, nonce); decipher.setAAD(Buffer.from(storeNodeExecutionSealText(lease, purpose))); decipher.setAuthTag(tag);
    plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plain));
  } catch { throw new StoreNodeExecutionSealError(); }
  finally { plain?.fill(0); }
}
function decode(value: string): Buffer { const bytes = Buffer.from(value, "base64url"); if (bytes.toString("base64url") !== value) throw new StoreNodeExecutionSealError(); return bytes; }
