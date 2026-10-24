import { PodExecutableToolKeySchema, type PodExecutableToolKey } from "@yummyai/contracts";

export function enabledPodArtworkTools(
  environment: Record<string, string | undefined> = process.env,
): ReadonlySet<PodExecutableToolKey> {
  if (
    !environment.POD_PROCESSOR_DEPLOYMENT_ID?.trim() ||
    !environment.POD_PROCESSOR_URL?.trim() ||
    !environment.POD_PROCESSOR_API_KEY?.trim()
  )
    return new Set();
  return new Set(
    PodExecutableToolKeySchema.array().parse(
      environment.POD_ENABLED_TOOLS?.split(",")
        .map((value) => value.trim())
        .filter(Boolean) ?? [],
    ),
  );
}
