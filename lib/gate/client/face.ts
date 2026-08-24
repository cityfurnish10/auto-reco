// On-device face verification.
//
// WHAT TRAVELS, AND WHAT DOES NOT. The phone never receives a photograph of
// anybody. At enrolment the manager's browser turns the reference photo into a
// DESCRIPTOR — 128 numbers describing that face — and only the descriptor is
// stored and sent out.
//
// That matters more since devices became shared: the roster at a gate lists
// every guard working there, so sending photos would cache each guard's face on
// every colleague's personal phone. Descriptors are a fraction of the size, they
// cannot be turned back into a picture, and no one's photograph ends up on
// someone else's device.
//
// The comparison itself runs entirely in the browser. Nothing is uploaded for
// matching, which is the cleanest position under India's data protection rules
// and also means check-in works with no signal.
//
// ~6.7MB of model weights, served from /models/face and cached by the browser
// after the first load.

import type * as FaceApi from "@vladmandic/face-api";

const MODEL_URL = "/models/face";

let api: typeof FaceApi | null = null;
let ready: Promise<void> | null = null;

/** Load once. The weights are large enough that a second load would be felt. */
export async function initFace(): Promise<void> {
  if (ready) return ready;
  ready = (async () => {
    api = await import("@vladmandic/face-api");
    await Promise.all([
      // The TINY detector, not the accurate one: it is 190KB against 5.4MB and
      // we are looking for one large, close, centred face — the easy case —
      // not counting strangers in a crowd.
      api.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
      api.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
      api.nets.faceRecognitionNet.loadFromUri(MODEL_URL),
    ]);
  })();
  return ready;
}

/** The 128-number signature of the single largest face in an image. */
export async function describe(
  input: HTMLVideoElement | HTMLImageElement | HTMLCanvasElement
): Promise<Float32Array | null> {
  await initFace();
  if (!api) return null;
  const opts = new api.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.4 });
  const found = await api
    .detectSingleFace(input as HTMLCanvasElement, opts)
    .withFaceLandmarks()
    .withFaceDescriptor();
  return found?.descriptor ?? null;
}

export type Verdict = "pass" | "review" | "fail" | "no_face";

/**
 * Thresholds, and why they are set where they are.
 *
 * face-api's own guidance is that a euclidean distance below 0.6 is the same
 * person. We deliberately split that into three bands rather than two:
 *
 *   < 0.45   pass    comfortably the same face
 *   < 0.62   review  probably them, but a human should glance
 *   >= 0.62  review  probably not them — STILL only a review, never a refusal
 *
 * NOTHING HERE LOCKS A GUARD OUT. Gate lighting at night is poor and a false
 * rejection at 9pm in the rain is how a guard stops using the app for good —
 * and then there is no attendance record at all, which is worse than an
 * uncertain one. Everything short of a clean pass goes to a manager to look at.
 *
 * These numbers are a starting point, not a finding. The raw score is stored
 * with every check precisely so they can be re-tuned against real gate
 * lighting later without having thrown the evidence away.
 */
export const PASS_BELOW = 0.45;
export const LIKELY_BELOW = 0.62;

export interface MatchResult { verdict: Verdict; score: number | null }

export function compare(live: Float32Array | null, reference: Float32Array | null): MatchResult {
  if (!live) return { verdict: "no_face", score: null };
  // No stored descriptor yet — an enrolment that never got its photo. Not the
  // guard's fault and not a failure: flag it for the manager to complete.
  if (!reference || reference.length !== live.length) return { verdict: "review", score: null };

  let sum = 0;
  for (let i = 0; i < live.length; i++) {
    const d = live[i] - reference[i];
    sum += d * d;
  }
  const score = Math.sqrt(sum);
  return { verdict: score < PASS_BELOW ? "pass" : "review", score: +score.toFixed(4) };
}

/** Descriptors are stored and sent as plain arrays; the model wants a typed one. */
export const toArray = (d: Float32Array): number[] => Array.from(d);
export const fromArray = (a: number[] | null | undefined): Float32Array | null =>
  a && a.length ? Float32Array.from(a) : null;
