import { STORE_NODE_PUBLICATION_SUBMIT_OPERATION, StoreNodeAmazonSubmissionResultSchema, StoreNodeAmazonStatusResultSchema,
  type StoreNodeAmazonSubmissionResult, type StoreNodeAmazonStatusResult } from "@yummyai/contracts/marketplace/publication-submit";
import { STORE_NODE_EXECUTION_RESULT_BYTES } from "@yummyai/contracts/marketplace/store-node-execution";
import { HttpMarketplaceDraftGateway, MarketplaceConnectorError, StoreNodeSubmissionPolicyError, createStoreNodeSubmissionTransport,
  storeNodeAmazonGatewayEnvironment, type StoreNodeSubmissionTransportOptions } from "@yummyai/marketplace-connectors";
import { nodeCheck } from "./error.js";

/** Original submit/status parsers over the shared, durable per-HTTP exchange. */
export async function executeStoreNodeSubmission(options: StoreNodeSubmissionTransportOptions): Promise<StoreNodeAmazonSubmissionResult | StoreNodeAmazonStatusResult> {
  const secrets = new Set(Object.entries(options.seed.credential).filter(([name, value]) => /token|secret|password/i.test(name) && value).map(([, value]) => value));
  if (options.amazonApplication) secrets.add(options.amazonApplication.clientSecret);
  let policyFailure: StoreNodeSubmissionPolicyError | undefined;
  const guarded = createStoreNodeSubmissionTransport({ ...options, observeSecret: value => { secrets.add(value); options.observeSecret?.(value); } });
  const request: typeof fetch = async (...args) => {
    try { return await guarded(...args); } catch (error) { if (error instanceof StoreNodeSubmissionPolicyError) policyFailure ??= error; throw error; }
  };
  const externalAccountId = options.seed.account.externalAccountId;
  nodeCheck(externalAccountId, "store_node_policy_rejected");
  const gateway = new HttpMarketplaceDraftGateway(request, storeNodeAmazonGatewayEnvironment(options.seed, options.amazonApplication));
  let raw: Awaited<ReturnType<HttpMarketplaceDraftGateway["submit"]>>;
  try {
    raw = options.lease.operation === STORE_NODE_PUBLICATION_SUBMIT_OPERATION
      ? await gateway.submit({ ...options.seed.account, externalAccountId }, options.seed.credential, options.lease.input.payload)
      : await gateway.getStatus({ ...options.seed.account, externalAccountId }, options.seed.credential, options.lease.input.payload, options.lease.input.target.sku);
  } catch (error) { throw policyFailure ?? error; }
  const base = { publicationRequestId: options.lease.input.publicationRequestId, payloadChecksum: options.lease.input.target.payloadChecksum,
    externalListingId: raw.externalListingId, externalState: raw.externalState, status: raw.status, issues: [...raw.issues],
    ...(raw.quota ? { quota: raw.quota } : {}), submittedAt: raw.submittedAt.toISOString() };
  const parsed = options.lease.operation === STORE_NODE_PUBLICATION_SUBMIT_OPERATION
    ? StoreNodeAmazonSubmissionResultSchema.safeParse({ ...base, externalSubmissionId: raw.externalSubmissionId })
    : StoreNodeAmazonStatusResultSchema.safeParse({ ...base, sourceSubmissionId: options.lease.input.target.sourceSubmissionId });
  if (!parsed.success || parsed.data.externalListingId !== options.lease.input.target.sku)
    throw new MarketplaceConnectorError("amazon", "upstream_terminal", "Original publication result did not match its fixed request", undefined,
      options.lease.operation === STORE_NODE_PUBLICATION_SUBMIT_OPERATION);
  const text = JSON.stringify(parsed.data);
  nodeCheck(Buffer.byteLength(text) <= STORE_NODE_EXECUTION_RESULT_BYTES, "store_node_result_too_large");
  nodeCheck(![...secrets].some(value => text.includes(value) || text.includes(JSON.stringify(value).slice(1, -1))), "store_node_secret_output_rejected");
  return parsed.data;
}
