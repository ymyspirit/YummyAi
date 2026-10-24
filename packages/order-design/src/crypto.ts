import { createHash } from "node:crypto";
import { encryptProductionBytes, decryptProductionBytes } from "@yummyai/production-editor";
export const fingerprint=(value:unknown)=>createHash("sha256").update(typeof value==="string" || value instanceof Uint8Array ? value : JSON.stringify(value)).digest("hex");
export const seal=(key:Uint8Array,value:unknown)=>encryptProductionBytes(key,Buffer.from(JSON.stringify(value))).toString("base64");
export const open=<T>(key:Uint8Array,value:string):T=>JSON.parse(decryptProductionBytes(key,Buffer.from(value,"base64")).toString("utf8")) as T;
