import { publicationSubmitProxy } from "../proxy";

export const dynamic = "force-dynamic";
export const GET = (request: Request) => publicationSubmitProxy(request, "status-receipt");
export const HEAD = (request: Request) => publicationSubmitProxy(request, "status-receipt");
