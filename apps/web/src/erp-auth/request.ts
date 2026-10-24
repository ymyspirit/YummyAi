import { headers } from "next/headers.js";
import { erpRequestIdentity } from "./server";
export async function erpAmbientIdentity() {
  const current = await headers();
  return erpRequestIdentity(
    new Request("https://request-context.invalid", { headers: new Headers(current) }),
  );
}
export async function hasNextRequestContext() {
  try {
    await headers();
    return true;
  } catch (error) {
    if (error instanceof Error && error.message.includes("outside a request scope")) return false;
    throw error;
  }
}
