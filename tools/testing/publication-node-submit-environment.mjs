import process from "node:process";
import {isAbsolute,resolve} from "node:path";
import {fileURLToPath,URL} from "node:url";
import {requireDisposableIntegrationEnvironment} from "./require-disposable-integration.mjs";
const root=fileURLToPath(new URL("../../",import.meta.url));
export const PUBLICATION_NODE_SUBMIT_LANE=resolve(root,"tmp/publication-node-submit-20261023-74c2e8b1/qa");
/** Pure preflight. A family flag, nonce resources and exact legacy source are checked before connection. */
export function requirePublicationNodeSubmitEnvironment(env=process.env,target="current",browser=false){
 const database=new URL(requireDisposableIntegrationEnvironment(env)),nonce=/^\/order_daily_e2e_([a-f0-9]{32})$/.exec(database.pathname)?.[1],local=["localhost","127.0.0.1","[::1]"];
 if(env.E2E_PUBLICATION_NODE_SUBMIT_ISOLATED!=="1"||env.E2E_ISOLATED_DAILY!=="1"||!["current","pre-0183"].includes(target)||env.E2E_LEGACY_SCHEMA_TARGET!==target||!nonce||!local.includes(database.hostname)
  ||env.S3_PRIVATE_BUCKET!=="order-daily-e2e-"+nonce||env.E2E_DISPOSABLE_REDIS_CONTAINER!=="yummyai-daily-"+nonce||!env.E2E_DISPOSABLE_REDIS_URL||env.REDIS_URL!==env.E2E_DISPOSABLE_REDIS_URL)
  throw new Error("Publication node submit requires exact disposable family resources before connection");
 const redis=new URL(env.E2E_DISPOSABLE_REDIS_URL);if(!["redis:","rediss:"].includes(redis.protocol)||!local.includes(redis.hostname)||redis.username||redis.password||redis.hash||redis.search)throw new Error("Publication node submit Redis is invalid");
 if(target==="pre-0183"){const source=env.E2E_PUBLICATION_NODE_SUBMIT_LEGACY_SOURCE;if(!source||!isAbsolute(source)||resolve(source)!==resolve(root,"tmp/publication-node-submit-20261023-74c2e8b1/old182-source"))throw new Error("Publication node submit requires exact original182 source");}
 if(browser){const api=new URL(env.API_BASE_URL??"https://invalid.invalid");if(target!=="current"||env.E2E_COMPILED_WEB!=="1"||env.WEB_AUTH_MODE!=="personal"||api.protocol!=="http:"||!local.includes(api.hostname)||api.port!=="8130"||api.pathname!=="/"||api.search||api.hash||api.username||api.password||!env.ERP_FIXTURE_ACTORS)throw new Error("Publication node submit browser requires compiled personal3130/8130 and actual members");}
 return {url:database.href,name:database.pathname.slice(1),nonce,lane:PUBLICATION_NODE_SUBMIT_LANE};
}
