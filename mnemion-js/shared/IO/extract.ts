// Document text extraction: bytes → searchable text.
//
// The extracted text lands in the _documents.extracted_text facet, where it's
// covered by `search` (FTS over text facets) and `prime` (embedEntry embeds
// text facets). So extraction is the only missing piece — indexing is free.
//
// Two tiers run inline-cheap vs async-heavy:
//   - text-family (text/*, json, xml, csv, markdown): decode the bytes, no deps.
//   - PDF: unpdf (serverless pdf.js) — runs in workerd (spiked), but CPU-heavier,
//     so the caller runs it off the response path (waitUntil).
// Anything else (images, office docs) is unsupported for now.
//
// @why Inline text extraction runs synchronously but PDF extraction is deferred
// to the DO's waitUntil off the response path, because only the Durable Object
// has waitUntil and PDF parsing is slow; extracted text is capped to stay under
// the 1 MB entry limit. Extraction is the only missing piece for document
// search/recall — once text lands in _documents.extracted_text, search (FTS)
// and prime (embedding) cover it for free.

// Cap stored text well under the 1 MB entry limit (length×2 bytes); enough to
// cover the searchable substance of most documents.
export const TEXT_CHARS_CAP = 100_000;

export function capText(s: string): string {
  return s.length > TEXT_CHARS_CAP ? s.slice(0, TEXT_CHARS_CAP) : s;
}

const TEXT_LIKE = [
  "text/",
  "application/json",
  "application/xml",
  "application/javascript",
  "application/x-ndjson",
];

/** True for content types we can read directly as UTF-8 text. */
export function isTextLike(contentType: string): boolean {
  const ct = contentType.toLowerCase();
  if (TEXT_LIKE.some((p) => ct.startsWith(p))) return true;
  // structured suffixes: application/foo+json, image/svg+xml, etc.
  if (/\+(json|xml)\b/.test(ct)) return true;
  return false;
}

export function isPdf(contentType: string): boolean {
  return contentType.toLowerCase().startsWith("application/pdf");
}

/** Decode raw bytes as UTF-8 text (lossy on invalid sequences). */
export function decodeText(bytes: ArrayBuffer): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

/** Extract text from a PDF via unpdf (serverless pdf.js). Pages merged. */
export async function extractPdfText(bytes: ArrayBuffer): Promise<string> {
  const { getDocumentProxy, extractText } = await import("unpdf");
  const doc = await getDocumentProxy(new Uint8Array(bytes));
  const { text } = await extractText(doc, { mergePages: true });
  return typeof text === "string" ? text : Array.isArray(text) ? text.join("\n") : "";
}

export type ExtractionStatus = "done" | "empty" | "failed" | "pending" | "unsupported";

/** Classify what extraction a content type gets, without doing the work. */
export function extractionPlan(contentType: string): "text" | "pdf" | "unsupported" {
  if (isTextLike(contentType)) return "text";
  if (isPdf(contentType)) return "pdf";
  return "unsupported";
}
