import { StoreNodePublicationResultSchema, type StoreNodePublicationResult } from "@yummyai/contracts/marketplace/publication-preview";
import { STORE_NODE_EXECUTION_RESULT_BYTES } from "@yummyai/contracts/marketplace/store-node-execution";
import { HttpMarketplaceDraftGateway, StoreNodePublicationPolicyError, createStoreNodePublicationTransport,
  storeNodeAmazonGatewayEnvironment, type StoreNodePublicationTransportOptions } from "@yummyai/marketplace-connectors";
import { nodeCheck } from "./error.js";

/** Runs the original Amazon result parser through the existing durable exchange port. */
export async function executeStoreNodePublication(options: StoreNodePublicationTransportOptions): Promise<StoreNodePublicationResult> {
  const secrets = new Set(Object.entries(options.seed.credential)
    .filter(([name, value]) => /token|secret|password/i.test(name) && value).map(([, value]) => value));
  if (options.amazonApplication) secrets.add(options.amazonApplication.clientSecret);
  let policyFailure: StoreNodePublicationPolicyError | undefined;
  const guarded = createStoreNodePublicationTransport({ ...options,
    observeSecret: value => { secrets.add(value); options.observeSecret?.(value); } });
  const request: typeof fetch = async (...args) => {
    try { return await guarded(...args); }
    catch (error) { if (error instanceof StoreNodePublicationPolicyError) policyFailure ??= error; throw error; }
  };
  const externalAccountId = options.seed.account.externalAccountId;
  nodeCheck(externalAccountId, "store_node_policy_rejected");
  let raw: Awaited<ReturnType<HttpMarketplaceDraftGateway["create"]>>;
  try { raw = await new HttpMarketplaceDraftGateway(request, storeNodeAmazonGatewayEnvironment(options.seed, options.amazonApplication))
    .create({ ...options.seed.account, externalAccountId }, options.seed.credential, options.lease.input.payload); }
  catch (error) { throw policyFailure ?? error; }
  const result = StoreNodePublicationResultSchema.parse({ publicationRequestId: options.lease.input.publicationRequestId,
    payloadChecksum: options.lease.input.target.payloadChecksum, status: raw.status, externalState: raw.externalState, issues: [...raw.issues],
    ...(raw.externalListingId ? { externalListingId: raw.externalListingId } : {}),
    ...(raw.externalSubmissionId ? { externalSubmissionId: raw.externalSubmissionId } : {}),
    ...(raw.quota ? { quota: raw.quota } : {}), submittedAt: raw.submittedAt.toISOString() });
  const text = JSON.stringify(result);
  nodeCheck(Buffer.byteLength(text) <= STORE_NODE_EXECUTION_RESULT_BYTES, "store_node_result_too_large");
  nodeCheck(![...secrets].some(value => text.includes(value) || text.includes(JSON.stringify(value).slice(1, -1))), "store_node_secret_output_rejected");
  return result;
}
