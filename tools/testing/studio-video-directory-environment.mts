import process from "node:process";
import { fileURLToPath } from "node:url";
import { requireStudioPersonalEnvironment } from "./require-studio-personal-environment.mjs";

export function requireStudioVideoDirectoryEnvironment(environment = process.env, browser = false) {
  const isolated = requireStudioPersonalEnvironment(environment, browser);
  if (environment.E2E_STUDIO_VIDEO_DIRECTORY_ISOLATED !== "1") throw new Error("studio_video_fixture_explicit_isolation_required");
  return { ...isolated, lane: fileURLToPath(new URL("../../tmp/studio-video-directory-20261024-b6e9a3f2/qa", import.meta.url)) };
}
