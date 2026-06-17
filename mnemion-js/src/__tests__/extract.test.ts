// Document text extraction: content-type routing, text decode, PDF via unpdf
// (runs in workerd), and the recordExtraction RPC making contents searchable.

import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import type { HiveDO } from "../../entities/Hive/hive";
import { isTextLike, isPdf, extractionPlan, decodeText, extractPdfText, capText, TEXT_CHARS_CAP } from "../../shared/IO/extract";

// Minimal valid single-page PDF with one text line; xref offsets computed so
// pdf.js parses it on the happy path (no recovery mode).
function buildPdf(text: string): Uint8Array {
  const enc = new TextEncoder();
  const stream = `BT /F1 24 Tf 72 700 Td (${text}) Tj ET`;
  const objects = [
    `<< /Type /Catalog /Pages 2 0 R >>`,
    `<< /Type /Pages /Kids [3 0 R] /Count 1 >>`,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>`,
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`,
  ];
  let body = `%PDF-1.4\n`;
  const offsets: number[] = [];
  objects.forEach((obj, i) => { offsets.push(enc.encode(body).length); body += `${i + 1} 0 obj\n${obj}\nendobj\n`; });
  const xrefStart = enc.encode(body).length;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) xref += `${String(off).padStart(10, "0")} 00000 n \n`;
  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return enc.encode(body + xref + trailer);
}

function getStore(): DurableObjectStub<HiveDO> {
  return env.MNEMION_HIVE.get(env.MNEMION_HIVE.idFromName(`user:test:${crypto.randomUUID()}`));
}
async function createDoc(store: DurableObjectStub<HiveDO>, data: Record<string, unknown>) {
  return JSON.parse(await store.mutate("_documents", "create", JSON.stringify(data)));
}

// === Content-type routing (pure) ===

describe("extraction routing", () => {
  it("classifies text-family content types", () => {
    for (const ct of ["text/plain", "text/markdown", "text/csv", "application/json", "application/ld+json", "image/svg+xml", "application/xml"]) {
      expect(isTextLike(ct), ct).toBe(true);
      expect(extractionPlan(ct), ct).toBe("text");
    }
  });
  it("classifies PDFs", () => {
    expect(isPdf("application/pdf")).toBe(true);
    expect(extractionPlan("application/pdf")).toBe("pdf");
  });
  it("treats binary/office as unsupported", () => {
    for (const ct of ["image/png", "application/octet-stream", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"]) {
      expect(extractionPlan(ct), ct).toBe("unsupported");
    }
  });
  it("caps text at the limit", () => {
    expect(capText("x".repeat(TEXT_CHARS_CAP + 50)).length).toBe(TEXT_CHARS_CAP);
    expect(capText("short")).toBe("short");
  });
  it("decodes UTF-8 bytes", () => {
    expect(decodeText(new TextEncoder().encode("héllo").buffer)).toBe("héllo");
  });
});

// === PDF extraction in workerd ===

describe("extractPdfText", () => {
  it("pulls text out of a real PDF", async () => {
    const text = await extractPdfText(buildPdf("Contents of the report").buffer);
    expect(text).toContain("Contents of the report");
  });
});

// === recordExtraction RPC → searchable contents ===

describe("recordExtraction", () => {
  it("stores extracted text + status and makes contents searchable", async () => {
    const store = getStore();
    const doc = await createDoc(store, { title: "report.txt" });
    const rec = JSON.parse(await store.recordExtraction(doc.entry.id, "the mitochondria is the powerhouse of the cell", "done"));
    expect(rec.recorded).toBe(true);

    // search (FTS over text facets, all patterns) finds the document by its CONTENTS
    const hits = JSON.parse(await store.search("powerhouse", "", 10));
    const found = hits.results.find((r: any) => r.pattern === "_documents" && r.entry.id === doc.entry.id);
    expect(found).toBeDefined();
    expect(found.entry.extraction_status).toBe("done");
    expect(found.matched_facets).toContain("extracted_text");
  });

  it("refuses agent attempts to set extracted_text / extraction_status via mutate", async () => {
    const store = getStore();
    const doc = await createDoc(store, { title: "x" });
    const r = JSON.parse(await store.mutate("_documents", "update", JSON.stringify({ id: doc.entry.id, extracted_text: "forged" })));
    expect(r.error).toBe(true);
    expect(r.message).toMatch(/extracted_text/);
  });

  it("returns an error for an unknown document", async () => {
    const store = getStore();
    const r = JSON.parse(await store.recordExtraction(99999, "text", "done"));
    expect(r.error).toBe(true);
  });
});
