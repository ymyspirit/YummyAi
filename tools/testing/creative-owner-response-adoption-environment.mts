import process from "node:process";
import { requireStudioPaidImageEnvironment } from "./studio-paid-image-environment.mjs";

/** The four real owner fixtures compose the existing single-image producer.
 * Both explicit family gates and the exact nonce resources remain necessary. */
export function requireCreativeOwnerResponseAdoptionEnvironment(environment = process.env, browser = false) {
  if (environment.E2E_CREATIVE_OWNER_RESPONSE_ADOPTION_ISOLATED !== "1")
    throw new Error("creative_owner_response_adoption_explicit_isolation_required");
  return requireStudioPaidImageEnvironment(environment, browser);
}
