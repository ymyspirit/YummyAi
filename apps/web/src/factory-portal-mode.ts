const id = "[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const routes = new RegExp(
  `^(/factory-work-items/?|/api/factory-auth/(login|callback|logout)|/api/factory-portal/(session|work-items(/${id}(/file|/feedback)?)?))$`,
  "i",
);
/** Independent public deployment of the same artifact; never exposes the internal ERP proxy. */
export function factoryPortalOnly() {
  return process.env.FACTORY_PORTAL_ONLY === "1";
}
export function factoryPublicPath(path: string) {
  if (path.startsWith("/_next/static/")) {
    try {
      const decoded = decodeURIComponent(path);
      return (
        !decoded.includes("%") &&
        !decoded.includes("\\") &&
        !decoded.split("/").some((segment) => segment === ".." || segment === ".") &&
        /^\/_next\/static\/[A-Za-z0-9_./@[\]()-]+$/.test(decoded)
      );
    } catch {
      return false;
    }
  }
  if (
    path.includes("%") ||
    path.includes("\\") ||
    path.split("/").some((segment) => segment === ".." || segment === ".")
  )
    return false;
  return routes.test(path) || path === "/favicon.ico";
}
