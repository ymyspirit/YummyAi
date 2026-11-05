import { OrderSyncPageSchema } from "@yummyai/contracts/order/sync";
import { STORE_NODE_EXECUTION_RESULT_BYTES } from "@yummyai/contracts/marketplace/store-node-execution";
import { AmazonOrdersAdapter, createStoreNodeOrdersTransport, StoreNodeOrdersPolicyError,
  storeNodeAmazonGatewayEnvironment, type StoreNodeOrdersTransportOptions } from "@yummyai/marketplace-connectors";
import { nodeCheck } from "./error.js";

export async function executeStoreNodeOrderSync(options: StoreNodeOrdersTransportOptions) {
  const secrets = new Set(Object.entries(options.seed.credential).filter(([key, value]) => /token|secret|password/i.test(key) && value).map(([, value]) => value));
  if (options.amazonApplication) secrets.add(options.amazonApplication.clientSecret);
  let policyFailure: StoreNodeOrdersPolicyError | undefined;
  const guarded = createStoreNodeOrdersTransport({ ...options, observeSecret: value => { secrets.add(value); options.observeSecret?.(value); } });
  const request: typeof fetch = async (...args) => {
    try { return await guarded(...args); } catch (error) { if (error instanceof StoreNodeOrdersPolicyError) policyFailure ??= error; throw error; }
  };
  const adapter = new AmazonOrdersAdapter(request, storeNodeAmazonGatewayEnvironment(options.seed, options.amazonApplication));
  let raw;
  try { raw = await adapter.fetchPage({ ...options.seed.account, accountId: options.lease.accountId },
    { withCredential: callback => callback(options.seed.credential) }, options.lease.input.request, options.signal ?? new AbortController().signal); }
  catch (error) { throw policyFailure ?? error; }
  const result = OrderSyncPageSchema.parse(raw), text = JSON.stringify(result);
  nodeCheck(Buffer.byteLength(text) <= STORE_NODE_EXECUTION_RESULT_BYTES, "store_node_result_too_large");
  nodeCheck(![...secrets].some(value => text.includes(value) || text.includes(JSON.stringify(value).slice(1, -1))), "store_node_secret_output_rejected");
  return result;
}
