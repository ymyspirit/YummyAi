import { factoryPortalOnly } from "./factory-portal-mode";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import {AdHistoryRecordQuerySchema} from "@yummyai/contracts/advertising/history";
import { AdAnalysisInputSchema, AdGoalFieldsSchema, AdMarketplaceSchema, AdProductScopeSchema,
  AdReportTypeSchema } from "@yummyai/contracts/advertising";
export function localServiceAuth() {
  return (
    !factoryPortalOnly() &&
    process.env.WEB_AUTH_MODE === "local-service" &&
    process.env.NODE_ENV !== "production"
  );
}
export function invalidWebAuthMode() {
  return (
    !factoryPortalOnly() &&
    ((process.env.WEB_AUTH_MODE !== undefined &&
      !["personal", "local-service"].includes(process.env.WEB_AUTH_MODE)) ||
      (process.env.WEB_AUTH_MODE === "local-service" && process.env.NODE_ENV === "production"))
  );
}
/** Only the disposable acceptance process may prepare fixtures outside Next request scope. */
export function isolatedWebFixture() {
  try {
    const database = new URL(process.env.DATABASE_URL ?? ""),
      token = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(database.pathname)?.[1];
    return (
      process.env.NODE_ENV !== "production" &&
      process.env.E2E_ISOLATED_DAILY === "1" &&
      !!token &&
      process.env.S3_PRIVATE_BUCKET === `order-daily-e2e-${token}`
    );
  } catch {
    return false;
  }
}
export function localServiceRequest(request: Request) {
  const url = new URL(request.url),
    forwarded = request.headers.get("x-forwarded-for"),
    host = request.headers.get("x-forwarded-host");
  return (
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
    !request.headers.has("forwarded") &&
    (!forwarded || ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(forwarded)) &&
    (!host || host === url.host)
  );
}
export function erpReturnPath(value: string | null | undefined, depth = 0): string {
  if (
    !value ||
    value.length > 2000 ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    /[\\\r\n]/.test(value) ||
    /%(?:5c|0d|0a)/i.test(value) ||
    /%2f/i.test(value.split(/[?#]/, 1)[0] ?? "")
  )
    return "/";
  try {
    const u = new URL(value, "https://erp.invalid");
    if (
      u.origin !== "https://erp.invalid" ||
      /^\/(?:api|auth|login|_next|v1)(?:\/|$)/.test(u.pathname)
    )
      return "/";
    const kept = new URLSearchParams();
    for (const key of [
      "line",
      "project",
      "task",
      "plan",
      "order",
      "factoryId",
      "view",
      "tab",
      "module",
      "page",
      "status",
      "sku",
      "spu",
      "spuId",
      "artwork",
      "artworkVersionId",
      "specificationVersionId",
    ]) {
      const values = u.searchParams.getAll(key);
      if (values.length === 1 && /^[a-zA-Z0-9_-]{1,100}$/.test(values[0]!))
        kept.set(key, values[0]!);
    }
    for (const key of ["form", "compose", "editSpu", "archived"]) {
      if (u.searchParams.getAll(key).length === 1 && u.searchParams.get(key) === "1")
        kept.set(key, "1");
    }
    if (["/customer-intelligence","/customer-intelligence/","/advertising/originals","/advertising/originals/"].includes(u.pathname)) {
      // Personal login sanitizes the target more than once. Preserve the exact
      // account and measurement filters, without authorizing access to them.
      const fields = [
        ["account", EntityIdSchema], ["run", EntityIdSchema],
        ["from", AdAnalysisInputSchema.shape.periodStart], ["to", AdAnalysisInputSchema.shape.periodEnd],
        ["site", AdMarketplaceSchema], ["currency", AdProductScopeSchema.shape.currency],
        ["report", AdReportTypeSchema], ["mode", AdGoalFieldsSchema.shape.mode],
      ] as const;
      for (const [key, schema] of fields) {
        const values = u.searchParams.getAll(key);
        if (values.length !== 1) continue;
        const parsed = schema.safeParse(values[0]);
        if (parsed.success) kept.set(key, parsed.data);
      }
      const details=u.searchParams.getAll("detail");
      if(details.length===1&&kept.has("account")){
        const parts=details[0]!.split(":"),recordId=parts.at(-1),parsedId=EntityIdSchema.safeParse(recordId);
        if(parsedId.success){
          if(parts.length===1)kept.set("detail",parsedId.data.toLowerCase());
          else if(parts[0]==="command"&&parts.length===2)kept.set("detail",`command:${parsedId.data.toLowerCase()}`);
          else if(parts[0]==="history"&&(parts.length===3||parts.length===4)&&u.pathname.startsWith("/customer-intelligence")){
            const parsed=AdHistoryRecordQuerySchema.safeParse({accountId:kept.get("account"),kind:parts[1],...(parts.length===4?{parentId:parts[2]}:{})});
            if(parsed.success)kept.set("detail",`history:${parsed.data.kind}:${parsed.data.parentId?`${parsed.data.parentId.toLowerCase()}:`:""}${parsedId.data.toLowerCase()}`);
          }
        }
      }
    }
    if (u.pathname === "/ai-tasks" || u.pathname === "/ai-tasks/") {
      const values = u.searchParams.getAll("agentRun");
      if (values.length === 1) {
        const parsed = EntityIdSchema.safeParse(values[0]);
        if (parsed.success) kept.set("agentRun", parsed.data.toLowerCase());
      }
      const commands = u.searchParams.getAll("agentCommand");
      if (commands.length === 1) {
        const parsed = EntityIdSchema.safeParse(commands[0]);
        if (parsed.success) kept.set("agentCommand", parsed.data.toLowerCase());
      }
      const plans = u.searchParams.getAll("agentPlan");
      if (plans.length === 1) {
        const parsed = EntityIdSchema.safeParse(plans[0]);
        if (parsed.success) kept.set("agentPlan", parsed.data.toLowerCase());
      }
      const dependencies = u.searchParams.getAll("agentDependencyPlan");
      if (dependencies.length === 1) {
        const parsed = EntityIdSchema.safeParse(dependencies[0]);
        if (parsed.success) kept.set("agentDependencyPlan", parsed.data.toLowerCase());
      }
      const nativeRuns=u.searchParams.getAll("agentNative");
      if(nativeRuns.length===1){const parsed=EntityIdSchema.safeParse(nativeRuns[0]);if(parsed.success)kept.set("agentNative",parsed.data.toLowerCase());}
      const nativeV2Runs=u.searchParams.getAll("agentNativeV2");
      if(nativeV2Runs.length===1){const parsed=EntityIdSchema.safeParse(nativeV2Runs[0]);if(parsed.success)kept.set("agentNativeV2",parsed.data.toLowerCase());}
      const nativeV3Runs=u.searchParams.getAll("agentNativeV3");
      if(nativeV3Runs.length===1){const parsed=EntityIdSchema.safeParse(nativeV3Runs[0]);if(parsed.success)kept.set("agentNativeV3",parsed.data.toLowerCase());}
    }
    const listingPath = /^\/listings\/([0-9a-f-]+)\/?$/i.exec(u.pathname);
    const originalFulfillmentPage=["/production","/production/","/shipments","/shipments/","/orders","/orders/"].includes(u.pathname);
    const v4References=u.searchParams.getAll("agentNativeV4"),v4Run=v4References.length===1?EntityIdSchema.safeParse(v4References[0]):null;
    if(v4Run?.success && (originalFulfillmentPage || ["/ai-tasks","/ai-tasks/"].includes(u.pathname))){
      kept.set("agentNativeV4",v4Run.data.toLowerCase());
      const referenceKeys=originalFulfillmentPage?["agentNativeV4Item","agentFulfillmentCommand","delivery"]:["agentFulfillmentCommand"];
      for(const key of referenceKeys){
        const values=u.searchParams.getAll(key),parsed=values.length===1?EntityIdSchema.safeParse(values[0]):null;
        if(parsed?.success)kept.set(key,parsed.data.toLowerCase());
      }
    }
    const exactListing = Boolean(listingPath && EntityIdSchema.safeParse(listingPath[1]).success);
    if (exactListing) {
      for (const key of ["listingVersionId", "publicationRequestId", "agentNativeV3", "agentCommand", "accountId"]) {
        const values = u.searchParams.getAll(key), parsed = values.length === 1 ? EntityIdSchema.safeParse(values[0]) : null;
        if (parsed?.success) kept.set(key, parsed.data.toLowerCase());
      }
      const markets = u.searchParams.getAll("marketplaceId");
      if (markets.length === 1 && /^[a-zA-Z0-9_-]{1,80}$/.test(markets[0]!)) kept.set("marketplaceId", markets[0]!);
    }
    if (depth < 2 && (exactListing || originalFulfillmentPage && v4Run?.success || ["/ai-tasks", "/ai-tasks/"].includes(u.pathname))) {
      const sources = u.searchParams.getAll("returnTo");
      if (sources.length === 1) {
        const source = erpReturnPath(sources[0], depth + 1), target = new URL(source, "https://erp.invalid");
        if (["/ai-tasks", "/ai-tasks/"].includes(target.pathname) || /^\/listings\/[0-9a-f-]+\/?$/i.test(target.pathname) && EntityIdSchema.safeParse(target.pathname.split("/")[2]).success)
          kept.set("returnTo", source);
      }
    }
    if (u.pathname === "/pod-workbench/production-editor") {
      for (const key of ["projectId", "versionId", "reportLineId"]) {
        const values = u.searchParams.getAll(key);
        if (values.length === 1 && /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(values[0]!))
          kept.set(key, values[0]!);
      }
      if (!kept.has("projectId")) kept.delete("versionId");
      const kinds = u.searchParams.getAll("kind");
      if (kinds.length === 1 && ["tire_cover", "shaped_pillow", "rectangular_print"].includes(kinds[0]!))
        kept.set("kind", kinds[0]!);
    }
    if (u.pathname === "/manufacturing-recipes") {
      for (const key of ["recipe", "specificationId"]) {
        const values = u.searchParams.getAll(key);
        if (values.length === 1 && /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(values[0]!))
          kept.set(key, values[0]!);
      }
      if (!kept.has("recipe") && u.searchParams.getAll("new").length === 1 && u.searchParams.get("new") === "1")
        kept.set("new", "1");
    }
    if (u.pathname === "/sales-plans") {
      if (u.searchParams.getAll("new").length === 1 && u.searchParams.get("new") === "1")
        kept.set("new", "1");
      const step = u.searchParams.getAll("step");
      if (step.length === 1 && /^[0-4]$/.test(step[0]!)) kept.set("step", step[0]!);
    }
    return u.pathname + (kept.size ? `?${kept}` : "");
  } catch {
    return "/";
  }
}
