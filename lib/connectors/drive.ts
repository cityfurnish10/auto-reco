// Google Drive mirror for guard-register PDFs. Supabase Storage stays the app's
// source of truth (the OCR reads from it, RLS-scoped per city); Drive is a
// human-browsable mirror — one folder per city under a main folder — using the
// SAME service account as the Sheets connector (GOOGLE_SERVICE_ACCOUNT_KEY).
//
// IMPORTANT: the folders MUST live in a Google Workspace **Shared Drive**. A
// service account has no personal ("My Drive") storage quota, so uploading into
// a My-Drive folder — even one shared with it — fails with "Service Accounts do
// not have storage quota". Add the SA's client_email as a Content Manager on the
// Shared Drive, then set GDRIVE_FOLDERS.
//
// Config (env):
//   GDRIVE_FOLDERS — JSON mapping city → Drive folder id, e.g.
//     {"DELHI":"1Ab..","MUMBAI":"1Cd..","PUNE":"..","HYDERABAD":"..","BANGALORE":".."}
//   GDRIVE_FOLDER_ID — optional single fallback folder for cities not in the map.
// When neither is set (or the SA key is missing) mirroring is a silent no-op.

import { google, type drive_v3 } from "googleapis";
import { Readable } from "node:stream";
import type { City } from "../sample-data";
import { normalizeCity } from "./types";
import { readServiceAccountKey } from "./google-service-account";

export interface DriveMirrorResult {
  status: "uploaded" | "exists" | "skipped" | "failed";
  fileId?: string;
  link?: string;
  reason?: string;
}

function folderForCity(city: City): string | null {
  const raw = process.env.GDRIVE_FOLDERS;
  if (raw) {
    try {
      const map = JSON.parse(raw) as Record<string, string>;
      for (const [k, id] of Object.entries(map)) {
        if (normalizeCity(k) === city && id) return id;
      }
    } catch {
      // fall through to the single-folder fallback
    }
  }
  return process.env.GDRIVE_FOLDER_ID?.trim() || null;
}

export function driveMirrorConfigured(): boolean {
  return !!readServiceAccountKey() && !!(process.env.GDRIVE_FOLDERS || process.env.GDRIVE_FOLDER_ID);
}

let drivePromise: Promise<drive_v3.Drive> | null = null;
function getDrive(): Promise<drive_v3.Drive> {
  if (!drivePromise) {
    const key = readServiceAccountKey();
    if (!key) throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY missing or invalid.");
    const auth = new google.auth.GoogleAuth({
      credentials: { client_email: key.client_email, private_key: key.private_key },
      // drive.file = least privilege: the app can only touch files it created.
      scopes: ["https://www.googleapis.com/auth/drive.file"],
    });
    drivePromise = Promise.resolve(google.drive({ version: "v3", auth }));
  }
  return drivePromise;
}

// Look up a previously-mirrored file by the guard upload id (stored as an
// appProperty), so re-processing the same upload never uploads a duplicate.
async function findExisting(drive: drive_v3.Drive, uploadId: string): Promise<drive_v3.Schema$File | null> {
  const res = await drive.files.list({
    q: `appProperties has { key='guardUploadId' and value='${uploadId}' } and trashed = false`,
    fields: "files(id, webViewLink)",
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    pageSize: 1,
  });
  return res.data.files?.[0] ?? null;
}

// Best-effort: push one guard PDF to its city's Drive folder. Idempotent per
// upload id. NEVER throws — Drive misconfig/quota/network yields a "failed"
// result the caller can log, without affecting the Supabase upload or OCR.
export async function mirrorGuardPdf(
  bytes: Uint8Array,
  city: City,
  fileName: string,
  uploadId: string
): Promise<DriveMirrorResult> {
  try {
    if (!readServiceAccountKey()) return { status: "skipped", reason: "no service account key" };
    const folderId = folderForCity(city);
    if (!folderId) return { status: "skipped", reason: `no Drive folder configured for ${city}` };

    const drive = await getDrive();
    const existing = await findExisting(drive, uploadId);
    if (existing?.id) {
      return { status: "exists", fileId: existing.id, link: existing.webViewLink ?? undefined };
    }

    const res = await drive.files.create({
      requestBody: {
        name: fileName,
        parents: [folderId],
        appProperties: { guardUploadId: uploadId },
      },
      media: { mimeType: "application/pdf", body: Readable.from(Buffer.from(bytes)) },
      fields: "id, webViewLink",
      supportsAllDrives: true,
    });
    return { status: "uploaded", fileId: res.data.id ?? undefined, link: res.data.webViewLink ?? undefined };
  } catch (err) {
    return { status: "failed", reason: err instanceof Error ? err.message : String(err) };
  }
}
