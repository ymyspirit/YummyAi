// Return destinations are local ERP pages, never external URLs or API endpoints.
const destinations =
  /^\/(?:orders(?:\/import)?|business-tasks|ai-tasks|order-artwork|production|shipments|after-sales|products|sales-plans|product-development|product-specifications|manufacturing-recipes|print-library|process-library|content-projects|creative-designs(?:\/canvas|\/studio\/[a-z-]+)?|pod-workbench(?:\/(?:mockup-batches|production-editor))?|listings(?:\/[a-zA-Z0-9-]+)?|procurement|product-supply|suppliers(?:\/[a-zA-Z0-9-]+)?|stores(?:\/[a-zA-Z0-9-]+)?|finance|inventory|channel-inventory|supplier-performance|operating-cockpit|customer-intelligence|research|competitors|analysis\/[a-zA-Z0-9-]+|design|workflows(?:\/(?:runs|templates)\/[a-zA-Z0-9-]+(?:\/edit)?)?|settings\/(?:ai|rules))$/;

export function returnHref(value: string | null | undefined, depth = 0): string | null {
  if (
    !value ||
    value.length > 16000 ||
    !value.startsWith("/") ||
    value.includes("\\") ||
    [...value].some((char) => char.charCodeAt(0) < 32)
  )
    return null;
  try {
    const url = new URL(value, "https://erp.invalid");
    if (
      url.origin !== "https://erp.invalid" ||
      (url.pathname !== "/" && !destinations.test(url.pathname))
    )
      return null;
    const parent = depth < 3 ? returnHref(url.searchParams.get("returnTo"), depth + 1) : null;
    if (parent) url.searchParams.set("returnTo", parent);
    else url.searchParams.delete("returnTo");
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return null;
  }
}

export function workflowHref(target: string, source: string | null | undefined): string {
  const origin = returnHref(source);
  if (!origin) return target;
  const url = new URL(target, "https://erp.invalid");
  if (url.origin !== "https://erp.invalid") return target;
  url.searchParams.set("returnTo", origin);
  return `${url.pathname}${url.search}${url.hash}`;
}

export function readQueue(value: string | null, selected: string): string[] | null {
  if (!value) return null;
  const ids = [...new Set(value.split(","))];
  return ids.length <= 100 &&
    ids.includes(selected) &&
    ids.every((id) => /^[a-zA-Z0-9-]{1,64}$/.test(id))
    ? ids
    : null;
}
