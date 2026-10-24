import process from "node:process";
import {fileURLToPath, URL} from "node:url";
import {requirePublicationNodePreviewEnvironment} from "./publication-node-preview-environment.mjs";
export const AMAZON_PUBLIC_NODE_LANE=fileURLToPath(new URL("../../tmp/amazon-public-node-20261023-3d7f9a21/qa",import.meta.url));
/** Pure preflight, before opening any application, database or provider connection. */
export function requireAmazonPublicNodeEnvironment(env=process.env,browser=false){
 if(env.E2E_AMAZON_PUBLIC_NODE_ISOLATED!=="1"||env.E2E_LEGACY_SCHEMA_TARGET!=="current")throw new Error("Amazon public node requires its current disposable family before connection");
 return {...requirePublicationNodePreviewEnvironment(env,"current",browser),lane:AMAZON_PUBLIC_NODE_LANE};
}
