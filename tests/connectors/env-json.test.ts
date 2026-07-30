import { describe, expect, it } from "vitest";
import { parseJsonEnv } from "../../lib/connectors/google-service-account";
import { registerAttachments } from "../../lib/email/register-pdf";

describe("parseJsonEnv", () => {
  it("reads ordinary JSON", () => {
    expect(parseJsonEnv<{ a: number }>('{"a":1}')).toEqual({ a: 1 });
  });

  it("recovers the backslash-escaped form", () => {
    // The exact shape SHEETS_CONFIG was stored in, which took the ops sheet
    // offline from 27 Jul 2026 without a single message naming it.
    const raw = '{\\"DELHI\\":{\\"spreadsheetId\\":\\"abc123\\"}}';
    expect(parseJsonEnv<Record<string, { spreadsheetId: string }>>(raw)).toEqual({
      DELHI: { spreadsheetId: "abc123" },
    });
  });

  it("leaves a payload whose own values contain escaped quotes alone", () => {
    // The recovery must not fire here: this parses cleanly, and rewriting \"
    // inside a value would corrupt it. The guard is the leading `{\"`.
    const raw = '{"note":"he said \\"hi\\""}';
    expect(parseJsonEnv<{ note: string }>(raw)).toEqual({ note: 'he said "hi"' });
  });

  it("returns null for genuine garbage rather than throwing", () => {
    expect(parseJsonEnv("not json at all")).toBeNull();
    expect(parseJsonEnv('{\\"a\\": }')).toBeNull();
  });
});

describe("registerAttachments", () => {
  it("always explains an absent register", () => {
    // null = buildRegisterPdfs threw and the caller swallowed it. Returning {}
    // meant the email carried no attachment AND no reason.
    expect(registerAttachments(null).attachmentNote).toBeTruthy();
    expect(registerAttachments({ pdfs: [], reason: "no rows" }).attachmentNote).toBe("no rows");
  });

  it("carries the note only when there is nothing to attach", () => {
    const res = registerAttachments({
      pdfs: [
        { city: "DELHI", bytes: new Uint8Array([1, 2]), filename: "r.pdf", rowCount: 2 },
      ],
    });
    expect(res.attachments).toHaveLength(1);
    expect(res.attachmentNote).toBeUndefined();
  });
});
