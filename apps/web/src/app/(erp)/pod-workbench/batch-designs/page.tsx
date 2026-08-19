import { redirect } from "next/navigation";

export default async function LegacyBatchDesignPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const query = new URLSearchParams();
  if (typeof params.batch === "string") query.set("batch", params.batch);
  redirect(`/creative-designs${query.size ? `?${query.toString()}` : ""}`);
}
