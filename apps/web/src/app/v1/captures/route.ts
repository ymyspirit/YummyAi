import { localExtensionOptions, proxyLocalExtensionPost } from "../../../local-extension-proxy";

export function OPTIONS(request: Request) {
  return localExtensionOptions(request);
}

export function POST(request: Request) {
  return proxyLocalExtensionPost(request, "/v1/captures");
}
