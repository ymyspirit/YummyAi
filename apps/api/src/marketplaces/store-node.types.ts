import { storeNodeEnrollmentProofText, type StoreNodeEnrollmentResult, type StoreNodeWorkspace } from "@yummyai/contracts/marketplace/store-node";

export interface StoreNodePeer { fingerprintSha256:string; publicKeySpkiSha256:string; certificatePem:string; }
export abstract class StoreNodeCertificateIssuer {
  abstract configuration():StoreNodeWorkspace["configuration"];
  abstract caCertificatePem():string;
  abstract issue(input:{nodeId:string;accountId:string;publicKeyPem:string;certificateGeneration:number;issuedAt:Date}):Promise<StoreNodeEnrollmentResult>;
}
/** Anchor certificate dates to the claim's database clock. A small backdate
 * absorbs native/JS clock differences without extending the 24h lifetime. */
export function storeNodeCertificateValidity(issuedAt: Date): { startsAt: Date; expiresAt: Date } {
  if (!Number.isFinite(issuedAt.getTime())) throw new Error("store_node_certificate_issue_time_invalid");
  const startsAt = new Date(Math.floor((issuedAt.getTime() - 30_000) / 1000) * 1000);
  return { startsAt, expiresAt: new Date(startsAt.getTime() + 86_400_000) };
}
/** Both peers sign this bounded tuple; the raw ticket never enters logs or a queue. */
export function storeNodeEnrollmentProof(nodeId:string,ticketSha256:string,publicKeySpkiSha256:string):Buffer {
  return Buffer.from(storeNodeEnrollmentProofText(nodeId,ticketSha256,publicKeySpkiSha256),"utf8");
}
