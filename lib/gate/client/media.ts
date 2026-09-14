// Camera capture and image handling on the phone.

/**
 * Shrink a captured frame before it ever enters the outbox.
 *
 * A raw phone photo is 3-5MB. Queue twenty of those on a bad-signal day and the
 * outbox fills the device. At ~1000px and quality 0.7 the same image is around
 * 300KB — still plenty to identify an item or a face in a dispute, and roughly
 * a tenth of the upload over the guard's own data.
 */
export async function compress(source: CanvasImageSource, maxEdge = 1000, quality = 0.7): Promise<Blob> {
  const w = (source as HTMLVideoElement).videoWidth || (source as HTMLCanvasElement).width;
  const h = (source as HTMLVideoElement).videoHeight || (source as HTMLCanvasElement).height;
  const scale = Math.min(1, maxEdge / Math.max(w, h));
  const c = document.createElement("canvas");
  c.width = Math.round(w * scale);
  c.height = Math.round(h * scale);
  c.getContext("2d")!.drawImage(source, 0, 0, c.width, c.height);
  return new Promise((res) =>
    c.toBlob((b) => res(b ?? new Blob()), "image/jpeg", quality));
}

/** Best-effort position. Never blocks the flow: a phone against a metal shutter
 *  often cannot get a fix, and refusing the scan would push the guard to paper. */
export function position(timeoutMs = 4000): Promise<GeolocationPosition | null> {
  if (!navigator.geolocation) return Promise.resolve(null);
  return new Promise((res) => {
    const done = (v: GeolocationPosition | null) => res(v);
    const timer = setTimeout(() => done(null), timeoutMs);
    navigator.geolocation.getCurrentPosition(
      (p) => { clearTimeout(timer); done(p); },
      () => { clearTimeout(timer); done(null); },
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 30_000 }
    );
  });
}

/**
 * A short click for any deliberate action.
 *
 * Quieter and shorter than the scan tone deliberately -- a gate is noisy, the
 * guard is looking at the item rather than the screen, and a button that makes
 * the same noise as a successful scan would make the two indistinguishable.
 */
export function click() {
  try {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const c = new Ctx(), o = c.createOscillator(), g = c.createGain();
    o.frequency.value = 660;
    o.connect(g); g.connect(c.destination);
    g.gain.setValueAtTime(0.05, c.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + 0.045);
    o.start(); o.stop(c.currentTime + 0.05);
  } catch { /* audio is a nicety; never let it break an action */ }
  navigator.vibrate?.(8);
}

/** Confirmation the guard can FEEL. They are looking at the item, not the
 *  screen, so the beep and the buzz are the real interface. */
export function feedback(ok: boolean) {
  try {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (Ctx) {
      const c = new Ctx(), o = c.createOscillator(), g = c.createGain();
      o.frequency.value = ok ? 1180 : 520;
      o.connect(g); g.connect(c.destination);
      g.gain.setValueAtTime(0.14, c.currentTime);
      g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + (ok ? 0.09 : 0.22));
      o.start(); o.stop(c.currentTime + (ok ? 0.1 : 0.24));
    }
  } catch { /* audio is a nicety; never let it break a scan */ }
  navigator.vibrate?.(ok ? 18 : [30, 50, 30]);
}

/**
 * Is a photo clear enough to show how stock sits in a vehicle?
 *
 * Two cheap checks on a 160px-wide greyscale copy: mean brightness (a truck bed
 * at night, a lens covered by a thumb) and the variance of a Laplacian — the
 * standard sharpness measure; a smeared frame has almost no edges. The limits
 * are deliberately loose and the caller lets a guard use the photo anyway after
 * two tries: this is a nudge to retake, never a wall between a guard and a
 * truck that has to leave.
 */
export async function photoQuality(blob: Blob): Promise<{ dark: boolean; blurry: boolean }> {
  try {
    const bmp = await createImageBitmap(blob);
    const w = 160, h = Math.max(1, Math.round((bmp.height / bmp.width) * 160));
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const ctx = c.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(bmp, 0, 0, w, h);
    const d = ctx.getImageData(0, 0, w, h).data;
    const g = new Float32Array(w * h);
    let sum = 0;
    for (let i = 0; i < w * h; i++) { g[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]; sum += g[i]; }
    const mean = sum / (w * h);
    let lsum = 0, lsq = 0, n = 0;
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const l = g[i - w] + g[i + w] + g[i - 1] + g[i + 1] - 4 * g[i];
      lsum += l; lsq += l * l; n++;
    }
    const variance = n ? lsq / n - (lsum / n) ** 2 : 0;
    return { dark: mean < QUALITY.minBrightness, blurry: variance < QUALITY.minSharpness };
  } catch {
    // An image the browser cannot decode here is not proof of a bad photo.
    return { dark: false, blurry: false };
  }
}

/** Starting limits, to be tuned on real gate photos: 0–255 brightness, and
 *  Laplacian variance on the 160px copy. */
export const QUALITY = { minBrightness: 40, minSharpness: 30 };
