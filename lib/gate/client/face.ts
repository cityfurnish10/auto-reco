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
// The rule about what counts as real model output lives in one place, because
// the enrolment endpoint has to apply the same one — see lib/gate/descriptor.ts
// for the 128-zeros failure it exists to catch.
import { isRealDescriptor } from "../descriptor";

export { isRealDescriptor };

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
  const d = found?.descriptor ?? null;
  // A frame that had not arrived yet comes back as 128 zeros rather than as a
  // failure. Reported as "no face", which is what it actually is, and which
  // routes the guard to a retake instead of to a refusal.
  return d && isRealDescriptor(d) ? d : null;
}

export type Verdict = "pass" | "review" | "fail" | "no_face";

/**
 * Thresholds, and why they are set where they are.
 *
 * face-api's own guidance is that a euclidean distance below 0.6 is the same
 * person. We split that into three bands rather than two:
 *
 *   < 0.45   pass    comfortably the same face — in, no fuss
 *   < 0.62   review  probably them; allowed through, flagged for a manager
 *   >= 0.62  fail    plainly a different face — REFUSED
 *
 * WHY THE TOP BAND REFUSES. It did not, originally: everything short of a pass
 * was recorded for review and nobody was ever stopped. That is not a control.
 * A colleague could sign in as someone else, the app would note "worth a look",
 * and unless a manager actually worked the queue that day, nothing happened.
 *
 * The middle band is what keeps the refusal honest. Gate lighting at night is
 * poor, and a guard falsely refused at 9pm in the rain stops using the app for
 * good — which leaves no attendance record at all. So a near-miss is never a
 * refusal; only a face the model puts comfortably outside the same-person range
 * is turned away, and that guard is told to see their manager rather than left
 * tapping at a dead button.
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
  // guard's fault and not something we can judge, so it can never be a refusal:
  // flag it for the manager to complete. This is also the state that made every
  // check-in score null while the enrolment was still half-finished.
  if (!reference || reference.length !== live.length) return { verdict: "review", score: null };
  // A reference that is not real output — an enrolment that captured an empty
  // frame — must never be compared. It sits ~1.4 from any genuine face, which
  // would read as a confident mismatch and refuse a guard for a photograph
  // that was never taken of them. Flag it for the manager instead.
  if (!isRealDescriptor(reference)) return { verdict: "review", score: null };

  let sum = 0;
  for (let i = 0; i < live.length; i++) {
    const d = live[i] - reference[i];
    sum += d * d;
  }
  const score = Math.sqrt(sum);
  const verdict: Verdict =
    score < PASS_BELOW ? "pass" : score < LIKELY_BELOW ? "review" : "fail";
  return { verdict, score: +score.toFixed(4) };
}

/**
 * May this check-in proceed?
 *
 * The single place that decides, so the app and any future caller cannot drift
 * apart on it. Only a confident mismatch stops a guard; a missing model, an
 * unreadable frame or a borderline score all go through and get looked at.
 */
export function blocksEntry(verdict: Verdict | null): boolean {
  return verdict === "fail";
}

/** Descriptors are stored and sent as plain arrays; the model wants a typed one. */
export const toArray = (d: Float32Array): number[] => Array.from(d);
export const fromArray = (a: number[] | null | undefined): Float32Array | null =>
  a && a.length ? Float32Array.from(a) : null;
