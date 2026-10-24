import type { KnowledgeFields, KnowledgeSearch } from "@yummyai/contracts/knowledge";

export function knowledgeToday(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}
export function knowledgeTerms(query: string) {
  const text = query.normalize("NFKC").toLowerCase();
  return [
    ...new Set(
      [...new Intl.Segmenter("zh", { granularity: "word" }).segment(text)]
        .filter(
          (segment) =>
            segment.isWordLike &&
            (segment.segment.length > 1 || /\p{Script=Han}/u.test(segment.segment)),
        )
        .map((segment) => segment.segment),
    ),
  ].slice(0, 60);
}
export function knowledgeEligible(fields: KnowledgeFields, input: KnowledgeSearch, today: string) {
  return (
    (input.topic === "all" || fields.topic === input.topic) &&
    fields.verifiedOn <= today &&
    fields.reviewDueOn >= today &&
    (fields.platform === "all" || fields.platform === input.platform) &&
    (fields.market === "ALL" || fields.market === input.market) &&
    (!fields.spuId || input.spuIds.includes(fields.spuId))
  );
}
/** Deterministic keyword retrieval. No embedding provider or paid call is made. */
export function scoreKnowledge(fields: KnowledgeFields, query: string) {
  const terms = knowledgeTerms(query),
    title = fields.title.normalize("NFKC").toLowerCase();
  const tags = fields.tags.join(" ").normalize("NFKC").toLowerCase();
  const summary = fields.summary.normalize("NFKC").toLowerCase(),
    body = fields.body.normalize("NFKC").toLowerCase();
  return terms.reduce(
    (score, term) =>
      score +
      (title.includes(term) ? 8 : 0) +
      (tags.includes(term) ? 6 : 0) +
      (summary.includes(term) ? 4 : 0) +
      (body.includes(term) ? 1 : 0),
    0,
  );
}
export function knowledgeExcerpt(body: string, query: string) {
  const normalized = body.toLowerCase(),
    term = knowledgeTerms(query).find((value) => normalized.includes(value));
  const start = term ? Math.max(0, normalized.indexOf(term) - 250) : 0;
  return `${start ? "…" : ""}${body.slice(start, start + 2000)}${body.length > start + 2000 ? "…" : ""}`;
}
