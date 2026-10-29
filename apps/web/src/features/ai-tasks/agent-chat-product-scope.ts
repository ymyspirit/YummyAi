import type { AgentChatWorkspace } from "@yummyai/contracts/ai/agent-chat";
import type { AssistView } from "@yummyai/contracts/ai/assist";

type Product = NonNullable<AgentChatWorkspace["products"]>[number];

/** Literal catalog names only. Ambiguous names and partial catalogues are not guesses. */
export function exactAgentChatProduct(
  message: string,
  products: readonly Product[],
  hasMore = false,
): Product | null {
  if (hasMore) return null;
  const matches = products.filter((product) => {
    const name = product.name.trim();
    const names = [name, name.replace(/^定制\s*/, "").trim()].filter(Boolean);
    return names.some((alias) => {
      let start = -1;
      while ((start = message.indexOf(alias, start + 1)) >= 0) {
        const before = message[start - 1] ?? "",
          after = message[start + alias.length] ?? "";
        if (
          (/^[A-Za-z0-9_]/.test(alias) && /[A-Za-z0-9_]/.test(before)) ||
          (/[A-Za-z0-9_]$/.test(alias) && /[A-Za-z0-9_]/.test(after))
        )
          continue;
        return true;
      }
      return false;
    });
  });
  return matches.length === 1 ? matches[0]! : null;
}

/** Read the original request, never infer a historical product from the newest question. */
export function restoredAgentChatProduct(turns: readonly AssistView[]): {
  id: string;
  blockedReason: string;
} {
  if (!turns.length) return { id: "", blockedReason: "" };
  const first = turns[0]!.request;
  if (first?.kind !== "knowledge_answer")
    return { id: "", blockedReason: "原对话适用商品尚不可核对 请读取原任务后继续" };
  const products = first.search.spuIds;
  if (products.length > 1)
    return { id: "", blockedReason: "原对话包含多个商品 请到知识库原问答入口继续" };
  const expected = JSON.stringify(products);
  if (
    turns.some(
      (turn) =>
        turn.request?.kind === "knowledge_answer" &&
        JSON.stringify(turn.request.search.spuIds) !== expected,
    )
  )
    return { id: "", blockedReason: "原历史存在不同商品范围 请到知识库核对后继续" };
  return { id: products[0] ?? "", blockedReason: "" };
}
