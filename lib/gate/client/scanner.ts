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
    BarcodeDetector?: new (o?: { formats?: string[] }) => BarcodeDetectorLike;
  }
}

let native: BarcodeDetectorLike | null = null;
let jsqr: typeof import("jsqr").default | null = null;

export async function initScanner(): Promise<"native" | "fallback"> {
  if (typeof window !== "undefined" && window.BarcodeDetector) {
    try {
      native = new window.BarcodeDetector({ formats: ["qr_code"] });
      return "native";
    } catch { native = null; }
  }
  jsqr = (await import("jsqr")).default;
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
      return found[0]?.rawValue ? { value: found[0].rawValue } : null;
    } catch { /* fall through to the JS decoder */ }
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
