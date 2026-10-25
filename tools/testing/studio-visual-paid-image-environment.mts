import process from "node:process";
import { requireStudioPaidImageEnvironment } from "./studio-paid-image-environment.mjs";

export function requireStudioVisualPaidImageEnvironment(environment = process.env) {
  const isolated = requireStudioPaidImageEnvironment(environment);
  if (environment.E2E_STUDIO_VISUAL_PAID_IMAGE_ISOLATED !== "1")
    throw new Error("studio_visual_paid_image_explicit_isolation_required");
  return isolated;
}
