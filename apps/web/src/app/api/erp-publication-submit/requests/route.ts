import { publicationSubmitProxy } from "../proxy";

export const dynamic = "force-dynamic";
export const POST = (request: Request) => publicationSubmitProxy(request, "create");
