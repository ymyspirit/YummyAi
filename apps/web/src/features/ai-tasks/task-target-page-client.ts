import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { AssistTargetPageQuerySchema, AssistTargetPageViewSchema, type AssistTargetPageQuery, type AssistTargetPageItem, type AssistTargetPageSelection } from "@yummyai/contracts/ai/task-target-page";
import { AssistRequestError } from "../ai-assist/assist-client";

export type AssistTargetCollection = {
  query: AssistTargetPageSelection; contextAuthority: string; checkedAt: string; collectionFingerprint: string;
  items: AssistTargetPageItem[]; total: number; readCount: number; complete: boolean; nextCursor: string | null;
};
/** Retains only one unchanged collection; partial pages never imply completeness. */
export function mergeAssistTargetPage(previous: AssistTargetCollection | null, raw: unknown, requested: AssistTargetPageQuery, authority: string): AssistTargetCollection {
  const query = AssistTargetPageQuerySchema.parse(requested), parsed = AssistTargetPageViewSchema.safeParse(raw);
  if (!parsed.success) throw new AssistRequestError(502, "业务对象页未通过核对 本轮结果未采用");
  const page = parsed.data, { cursor, ...selection } = query;
  if (page.contextAuthority !== authority) throw new AssistRequestError(409, "当前权限已变化 原对象列表已隐藏", "authority_changed");
  if (canonicalJson(page.query) !== canonicalJson(query) || (cursor ? !previous || previous.nextCursor !== cursor : previous !== null))
    throw new AssistRequestError(502, "业务对象页不属于原查询或原续页 本轮结果未采用");
  if (previous && (previous.contextAuthority !== authority || canonicalJson(previous.query) !== canonicalJson(selection) ||
    previous.collectionFingerprint !== page.collectionFingerprint || previous.total !== page.total || previous.complete))
    throw new AssistRequestError(409, "业务对象集合已变化 请清除旧页并从第一页读取", "assist_target_collection_changed");
  const items = [...(previous?.items ?? []), ...page.items];
  if (new Set(items.map(item => item.id)).size !== items.length || page.readCount !== items.length || page.readCount !== (previous?.readCount ?? 0) + page.items.length)
    throw new AssistRequestError(502, "业务对象页存在重复或累计数量不一致 本轮结果未采用");
  return { query: selection, contextAuthority: authority, checkedAt: page.checkedAt, collectionFingerprint: page.collectionFingerprint,
    items, total: page.total, readCount: page.readCount, complete: page.complete, nextCursor: page.nextCursor };
}
