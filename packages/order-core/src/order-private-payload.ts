import { encryptProductionBytes, decryptProductionBytes } from "@yummyai/production-editor/private-envelope";
export interface OrderReadVault { withSecret<T>(encrypted:string,use:(plaintext:string)=>T):T }
export interface OrderSealingVault extends OrderReadVault { encrypt(plaintext:string):string }
export const sealWork = (key: Uint8Array, value: unknown) =>
  Buffer.from(encryptProductionBytes(key, Buffer.from(JSON.stringify(value)))).toString("base64");
export const openWork = <T>(key: Uint8Array, value: string): T =>
  JSON.parse(
    Buffer.from(decryptProductionBytes(key, Buffer.from(value, "base64"))).toString("utf8"),
  ) as T;
