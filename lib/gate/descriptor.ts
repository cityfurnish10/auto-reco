// Is this 128-number vector something the model actually computed from a face?
//
// PURE, AND DELIBERATELY NOT IN client/face.ts. Both the phone and the server
// need this rule, and a rule about what may be stored that lives only in the
// browser is a rule the browser can decline to follow. The enrolment endpoint
// is the last line: everything before it is a suggestion.
//
// WHY THE RULE EXISTS. face-api's computeFaceDescriptor has an early return for
// a zero-dimension input:
//
//     if (input?.shape?.some((dim) => dim <= 0)) return new Float32Array(128);
//
// — 128 ZEROS. Not null, not a throw. A video element whose first frame has not
// arrived has exactly that shape, and it is the commonest thing to go wrong on
// a phone camera in poor light or on a slow handset.
//
// Unchecked, that vector is poison in both directions:
//
//   ENROLLED   it becomes a reference no living face can ever match, and the
//              guard is refused every morning for a photograph that was never
//              taken of them.
//   COMPARED   it sits about 1.4 from any genuine descriptor — comfortably past
//              the fail threshold — so it reads as a confident mismatch rather
//              than as the equipment failure it is.
//
// A genuine descriptor is dense. This model does NOT L2-normalise: verified in
// FaceRecognitionNet.ts, where the final fully-connected output is returned
// as-is, which is why real norms sit near 1.4 rather than the 1.0 that face
// embeddings are usually assumed to have. The live enrolled reference measured
// 1.4063 with zero exact zeros on 2026-08-25.

/** How many values a face-api descriptor carries. */
export const DESCRIPTOR_LENGTH = 128;

/**
 * True when this looks like real model output.
 *
 * The thresholds are loose on purpose. Wrongly rejecting a genuine descriptor
 * locks a guard out of their own shift, while wrongly accepting an odd one
 * costs a review — so the bar only has to catch the failure that actually
 * happens, which is a vector of zeros.
 */
export function isRealDescriptor(d: ArrayLike<number> | null | undefined): boolean {
  if (!d || d.length !== DESCRIPTOR_LENGTH) return false;
  let zeros = 0;
  let sumSq = 0;
  for (let i = 0; i < DESCRIPTOR_LENGTH; i++) {
    const v = d[i];
    if (typeof v !== "number" || !Number.isFinite(v)) return false;
    if (v === 0) zeros++;
    sumSq += v * v;
  }
  return zeros < 64 && Math.sqrt(sumSq) > 0.1;
}
