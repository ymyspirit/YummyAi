import { ForbiddenError } from "@yummyai/authz";

export async function readOrderSection<T>(action: () => Promise<T>, name: string) {
  try { return { data: await action(), error: null }; }
  catch (error) { return { data: null, error: error instanceof ForbiddenError ? `无权查看${name}` : `${name}暂时无法读取，请重试` }; }
}
