// Azure AI Vision — Computer Vision v3.2 "Read" API client (async, submit-then-poll).
// This is the ONLY Azure Vision variant that natively accepts multi-page PDF —
// the newer v4.0 Image Analysis API is synchronous but images-only. Since the
// guard register is a multi-page PDF, this module targets v3.2 specifically.
//
// Submit → 202 + an Operation-Location header (the operation URL) → poll that
// URL until status is "succeeded"/"failed". One page in → one entry in
// analyzeResult.readResults[], in page order — this gives us page boundaries
// for free, which the rest of the pipeline relies on for per-page direction.
//
// Requires: AZURE_VISION_ENDPOINT (e.g. https://<resource>.cognitiveservices.azure.com),
// AZURE_VISION_API_KEY.

export interface OcrPoint {
  x: number;
  y: number;
}

export interface OcrLine {
  text: string;
  confidence?: number;
  box: OcrPoint[]; // 4 corner points, clockwise from top-left
}

export function azureVisionConfigured(): boolean {
  return !!process.env.AZURE_VISION_ENDPOINT && !!process.env.AZURE_VISION_API_KEY;
}

function baseUrl(): string {
  const url = process.env.AZURE_VISION_ENDPOINT;
  if (!url) throw new Error("AZURE_VISION_ENDPOINT not set.");
  return url.replace(/\/+$/, "");
}

function apiKey(): string {
  const key = process.env.AZURE_VISION_API_KEY;
  if (!key) throw new Error("AZURE_VISION_API_KEY not set.");
  return key;
}

// Submits a PDF for OCR. Returns the operation URL to poll (stored verbatim in
// guard_uploads.ocr_operation_id — simpler than re-deriving it from an id).
export async function submitReadJob(pdfBytes: Uint8Array): Promise<{ operationUrl: string }> {
  const res = await fetch(`${baseUrl()}/vision/v3.2/read/analyze`, {
    method: "POST",
    headers: {
      "Ocp-Apim-Subscription-Key": apiKey(),
      "Content-Type": "application/pdf",
    },
    // Buffer.from(...) — plain Uint8Array doesn't structurally satisfy
    // fetch's BodyInit typing in this TS/Node setup; Buffer does. Node-only
    // module (Node runtime route), so this is always available.
    body: Buffer.from(pdfBytes),
  });

  if (res.status !== 202) {
    throw new Error(`Azure Read submit failed: HTTP ${res.status} ${await res.text()}`);
  }
  const operationUrl = res.headers.get("operation-location");
  if (!operationUrl) {
    throw new Error("Azure Read submit succeeded but no Operation-Location header was returned.");
  }
  return { operationUrl };
}

// v3.2 boundingBox is a flat [x1,y1,x2,y2,x3,y3,x4,y4] array — normalize to
// OcrPoint[] so table-reconstruct.ts never has to know the wire format.
function toBox(flat: number[]): OcrPoint[] {
  const pts: OcrPoint[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) {
    pts.push({ x: flat[i], y: flat[i + 1] });
  }
  return pts;
}

interface AzureReadWord {
  text: string;
  boundingBox: number[];
  confidence?: number;
}
interface AzureReadLine {
  text: string;
  boundingBox: number[];
  words?: AzureReadWord[];
}
interface AzureReadPage {
  page: number;
  lines: AzureReadLine[];
}
interface AzureReadOperation {
  status: "notStarted" | "running" | "succeeded" | "failed";
  analyzeResult?: { readResults: AzureReadPage[] };
}

export interface ReadJobResult {
  status: "running" | "succeeded" | "failed";
  pages?: OcrLine[][]; // pages[i] = page i+1's lines
}

export async function checkReadJob(operationUrl: string): Promise<ReadJobResult> {
  const res = await fetch(operationUrl, {
    headers: { "Ocp-Apim-Subscription-Key": apiKey() },
  });
  if (!res.ok) {
    throw new Error(`Azure Read poll failed: HTTP ${res.status} ${await res.text()}`);
  }
  const json = (await res.json()) as AzureReadOperation;

  if (json.status === "notStarted" || json.status === "running") {
    return { status: "running" };
  }
  if (json.status === "failed") {
    return { status: "failed" };
  }

  const readResults = json.analyzeResult?.readResults ?? [];
  const pages: OcrLine[][] = readResults.map((page) =>
    page.lines.map((line) => {
      const confidences = (line.words ?? [])
        .map((w) => w.confidence)
        .filter((c): c is number => typeof c === "number");
      const confidence =
        confidences.length > 0
          ? confidences.reduce((a, b) => a + b, 0) / confidences.length
          : undefined;
      return { text: line.text, confidence, box: toBox(line.boundingBox) };
    })
  );

  return { status: "succeeded", pages };
}
