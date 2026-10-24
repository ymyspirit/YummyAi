import { parseStoreNodeConfiguration } from "./config.js";
import { safeStoreNodeCode } from "./error.js";
import { enrollStoreNode, initializeStoreNode, runStoreNode, workStoreNode } from "./node.js";
import { storeNodeAmazonApplication, storeNodeEtsyApplication } from "./sealed-credential.js";

async function main(): Promise<void> {
  const configuration = parseStoreNodeConfiguration(process.argv.slice(2));
  const controller = new AbortController();
  const stop = () => controller.abort(); process.once("SIGINT", stop); process.once("SIGTERM", stop);
  try {
    if (configuration.operation === "init") process.stdout.write(JSON.stringify(await initializeStoreNode(configuration)) + "\n");
    else if (configuration.operation === "enroll") process.stdout.write(JSON.stringify(await enrollStoreNode({ ...configuration, bundlePath: configuration.bundlePath!, signal: controller.signal })) + "\n");
    else if (configuration.operation === "work") await workStoreNode({ ...configuration, signal: controller.signal, etsy: storeNodeEtsyApplication(process.env),
      amazonApplication: storeNodeAmazonApplication(process.env),
      onState: state => process.stdout.write(JSON.stringify(state) + "\n"), onExecutionState: state => process.stdout.write(JSON.stringify(state) + "\n") });
    else await runStoreNode({ ...configuration, signal: controller.signal, onState: state => process.stdout.write(JSON.stringify(state) + "\n") });
  } finally { process.off("SIGINT", stop); process.off("SIGTERM", stop); }
}
void main().catch(error => { process.stderr.write(safeStoreNodeCode(error) + "\n"); process.exitCode = 1; });
