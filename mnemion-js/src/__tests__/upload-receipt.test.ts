import { describe, expect, it } from "vitest";
import { upload, uploadDocument } from "../../shared/Routing/routes/io";

describe("upload capability receipts", () => {
  it("text upload never returns a row from the hive response", async () => {
    const response = await upload({
      request: new Request("https://test.local/upload/token", { method: "POST", body: "ok" }),
      params: { token: "token" },
      hive: {
        consumeUpload: async () => JSON.stringify({
          uploaded: true, bytes: 2,
          target: { pattern: "notes", id: 7, facet: "body" }, mode: "replace",
          entry: { body: "private", secret: "must not leave" },
        }),
      },
    } as any);

    expect(await response.json()).toEqual({
      uploaded: true, bytes: 2,
      target: { pattern: "notes", id: 7, facet: "body" }, mode: "replace",
    });
  });

  it("document upload never returns metadata or the R2 key", async () => {
    const response = await uploadDocument({
      request: new Request("https://test.local/f/token", {
        method: "POST", body: "abc",
        headers: { "Content-Type": "application/octet-stream" },
      }),
      params: { token: "token" },
      env: { DOCUMENTS: { put: async () => undefined } },
      hive: {
        consumeDocumentUpload: async () => JSON.stringify({
          uploaded: true, id: 5, bytes: 3, content_type: "application/octet-stream",
          entry: { title: "private", r2_key: "documents/internal" },
        }),
        recordExtraction: async () => "{}",
      },
    } as any);

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      uploaded: true, id: 5, bytes: 3, content_type: "application/octet-stream",
    });
  });
});
