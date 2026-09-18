// Reading the QR code off the sticker.
//
// TWO PATHS, because the guards use their own phones and you will have both:
//
//   BarcodeDetector   built into Chrome on Android. Native speed, nothing to
//                     download, decodes in a few milliseconds.
//   jsQR              Safari on iOS has no BarcodeDetector at all. Pure JS,
//                     loaded only when the native one is missing.
//
// Either way this is a DECODE, not OCR: a QR carries error correction, so it
// returns the exact string or nothing. It never returns a wrong one. That is
// the entire reason this project retires the handwriting problem rather than
// improving it.

type Detected = { value: string } | null;

interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<{ rawValue: string }[]>;
}
declare global {
  interface Window {
    BarcodeDetector?: (new (o?: { formats?: string[] }) => BarcodeDetectorLike) & {
      getSupportedFormats?: () => Promise<string[]>;
    };
  }
}

let native: BarcodeDetectorLike | null = null;
let jsqr: typeof import("jsqr").default | null = null;
let frame = 0;

// A BROWSER CAN CLAIM TO READ QR CODES AND NEVER DO IT. 18 Sep 2026: Mahesh's
// Realme phone opened the app in its own HeyTap browser (a Chrome 115 fork).
// It has BarcodeDetector, so the app used it — and it returned "nothing in
// view" for every frame, without ever throwing, because the forks ship the
// API without the decoder behind it. The camera showed the sticker and nothing
// registered. So: ask which formats are really supported, and keep the JS
// decoder loaded on EVERY phone, trying it on alternate frames whenever the
// native one comes back empty. A real Chrome still decodes natively in
// milliseconds; a hollow one now falls back instead of failing silently.
export async function initScanner(): Promise<"native" | "fallback"> {
  jsqr = (await import("jsqr")).default;
  const BD = typeof window !== "undefined" ? window.BarcodeDetector : undefined;
  if (BD) {
    try {
      const formats = BD.getSupportedFormats ? await BD.getSupportedFormats() : ["qr_code"];
      if (formats.includes("qr_code")) {
        native = new BD({ formats: ["qr_code"] });
        return "native";
      }
    } catch { native = null; }
  }
  native = null;
  return "fallback";
}

export async function openCamera(video: HTMLVideoElement): Promise<MediaStream> {
  // The rear camera, and a resolution high enough to resolve a QR at arm's
  // length without making every frame expensive to decode.
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: false,
  });
  video.srcObject = stream;
  // iOS refuses to play an un-muted inline video without a gesture.
  video.setAttribute("playsinline", "true");
  video.muted = true;
  await video.play();
  return stream;
}

/** Decode one frame. Returns null when there is nothing in view — the common
 *  case, called many times a second, so it must stay cheap. */
export async function decodeFrame(
  video: HTMLVideoElement, work: HTMLCanvasElement
): Promise<Detected> {
  if (!video.videoWidth) return null;

  if (native) {
    try {
      const found = await native.detect(video);
      if (found[0]?.rawValue) return { value: found[0].rawValue };
    } catch { /* fall through to the JS decoder */ }
    // Native saw nothing. Usually true — nothing is in view — but on a
    // hollow detector it is always "nothing", so give the JS decoder every
    // other frame. Half rate keeps a real Chrome's camera smooth.
    if ((frame++ & 1) === 0) return null;
  }
  if (!jsqr) return null;

  // Downscale before decoding: the fallback is pure JS and scanning a full
  // 1280x720 frame every tick would drop the frame rate to the point the guard
  // notices. 480px wide still resolves a 14-character QR comfortably.
  const scale = Math.min(1, 480 / video.videoWidth);
  work.width = Math.round(video.videoWidth * scale);
  work.height = Math.round(video.videoHeight * scale);
  const ctx = work.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(video, 0, 0, work.width, work.height);
  const img = ctx.getImageData(0, 0, work.width, work.height);
  const r = jsqr(img.data, img.width, img.height, { inversionAttempts: "dontInvert" });
  return r?.data ? { value: r.data } : null;
}

export function stopCamera(stream: MediaStream | null) {
  stream?.getTracks().forEach((t) => t.stop());
}
