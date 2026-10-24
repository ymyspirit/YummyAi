import { publicationSubmitProxy } from "../../proxy";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ requestId: string }> };
export const GET = async (request: Request, context: Context) => publicationSubmitProxy(request, "view", (await context.params).requestId);
export const HEAD = async (request: Request, context: Context) => publicationSubmitProxy(request, "view", (await context.params).requestId);
