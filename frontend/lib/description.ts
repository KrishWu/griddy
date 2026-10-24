/** A sentence segment that really ends at an initial ("S. L. A. C.") or a common abbreviation, not a full stop. */
const ABBREVIATION_END = /(?:^|[\s(])(?:[A-Z]|U\.S|St|No|Inc|Corp|Co|Jr|Sr|Mt|vs|approx|e\.g|i\.e)\.$/;

/** Short dashboard copy. Reports retain the original descriptions. */
export function shortDescription(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  const sentences = new Intl.Segmenter("en", { granularity: "sentence" }).segment(normalized);
  let first = "";
  for (const { segment } of sentences) {
    first += segment;
    if (!ABBREVIATION_END.test(first.trimEnd())) break;
  }
  first ||= normalized;
  const clause = first.split(";")[0].trim();
  return /[.!?]$/.test(clause) ? clause : `${clause}.`;
}
