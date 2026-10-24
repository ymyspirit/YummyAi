import { publicationSubmitProxy } from "../../../proxy";

export const dynamic = "force-dynamic";
export const POST = async (request: Request, context: { params: Promise<{ requestId: string }> }) => publicationSubmitProxy(request, "status", (await context.params).requestId);
