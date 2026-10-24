import { publicationSubmitProxy } from "../proxy";

export const dynamic = "force-dynamic";
export const GET = (request: Request) => publicationSubmitProxy(request, "workspace");
export const HEAD = (request: Request) => publicationSubmitProxy(request, "workspace");
