/** Short dashboard copy. Reports retain the original descriptions. */
export function shortDescription(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  const sentences = new Intl.Segmenter("en", { granularity: "sentence" }).segment(normalized);
  const first = sentences[Symbol.iterator]().next().value?.segment ?? normalized;
  const clause = first.split(";")[0].trim();
  return /[.!?]$/.test(clause) ? clause : `${clause}.`;
}
