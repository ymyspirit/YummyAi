import { isDeepStrictEqual } from "node:util";
import type { SecretVault } from "@yummyai/ai-core";
import { CreativeResponseArchiveSchema, POD_MAX_RESPONSE_BYTES, type CreativeResponse } from "@yummyai/contracts/harness/creative-response";
import type { CreativeOwnerResponseSourcePin } from "@yummyai/database";
import { decodePodResponse, hashPodResponse, parseCreativeResponse } from "@yummyai/pod-core";
import { structuredResultChecksum } from "./creative-response-adoption-original.js";

/** Cryptographic archive admission shared by every non-candidate owner. Business
 * role, full raster/manifest decoding, current rights and scans remain mandatory. */
export function inspectCreativeOwnerOriginal(input:{pin:CreativeOwnerResponseSourcePin;tenantId:string;
  encryptedBytes:Uint8Array;vault:Pick<SecretVault,"withSecret">;signal:AbortSignal}):CreativeResponse {
  const {pin,tenantId,encryptedBytes,vault,signal}=input;
  const invalid=():never=>{throw new Error("CREATIVE_OWNER_ADOPTION_ARCHIVE_INVALID");};
  signal.throwIfAborted();
  if(!encryptedBytes.byteLength||encryptedBytes.byteLength>2*POD_MAX_RESPONSE_BYTES
    ||pin.responseObjectKey!==`tenants/${tenantId}/quarantine/${pin.encryptedChecksum}/${pin.executionId}-pod-response.pe`
    ||hashPodResponse(encryptedBytes)!==pin.encryptedChecksum)return invalid();
  const raw=vault.withSecret(new TextDecoder("utf-8",{fatal:true}).decode(encryptedBytes),text=>{
    signal.throwIfAborted();if(Buffer.byteLength(text)>2*POD_MAX_RESPONSE_BYTES)return invalid();
    return JSON.parse(text) as unknown;
  });
  signal.throwIfAborted();
  const archive=CreativeResponseArchiveSchema.parse(raw);
  if(archive.tenantId!==tenantId||archive.executionId!==pin.executionId||archive.inputFingerprint!==pin.inputFingerprint)return invalid();
  const response=parseCreativeResponse(archive.response);
  if(response.kind==="local"){
    const original=(raw as {response:unknown}).response;
    if(pin.effect!=="internal_write"||pin.receipt||hashPodResponse(JSON.stringify(original))!==pin.responseChecksum)return invalid();
  }else{
    const receipt=response.kind==="pod"?response.checkpoint.receipt:response.receipt;
    if(pin.effect!=="external_request"||!pin.receipt||!isDeepStrictEqual(receipt,pin.receipt)
      ||receipt.responseChecksum!==pin.responseChecksum)return invalid();
    if(response.kind==="pod"){
      const decoded=decodePodResponse(response.checkpoint);
      if(response.checkpoint.kind==="result"&&structuredResultChecksum(response.checkpoint.rawBody,decoded)!==pin.responseChecksum
        ||decoded.modelKey!==receipt.modelKey||decoded.modelVersion!==receipt.modelVersion)return invalid();
    }
  }
  signal.throwIfAborted();return response;
}
