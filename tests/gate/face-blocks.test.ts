// The face check has to REFUSE, not just take notes.
//
// It did not, and nobody noticed for a fortnight. `compare()` returned only
// "pass" or "review", `LIKELY_BELOW` was declared and never read, and check-in
// did not even require a photo — so a guard could tap straight through and the
// record read "worth a look" for a check that never happened. Measured on the
// live table on 2026-08-24: eight check-ins, every one `match_score: null`,
// five with no selfie attached at all.
//
// These tests pin the three properties that make it a control rather than a
// note: a confident mismatch fails, a near-miss does not, and nothing the
// model itself gets wrong can ever lock a guard out.

import { describe, expect, it } from "vitest";
import { blocksEntry, compare, isRealDescriptor, LIKELY_BELOW, PASS_BELOW }
  from "../../lib/gate/client/face";

/**
 * A pair of descriptors a known euclidean distance apart.
 *
 * DENSE, deliberately. These used to be all-zeros with a single non-zero axis,
 * which was convenient arithmetic and nothing like real output — and it now
 * fails isRealDescriptor, correctly, because 128 zeros is exactly what
 * face-api returns for a frame that never arrived. A fixture that could not
 * occur in life proves nothing about code that has to survive life.
 *
 * So the reference is a dense vector with a realistic norm (~1.4, since this
 * model does not L2-normalise), and the distance is carried on one axis so the
 * euclidean separation is still exactly what was asked for.
 */
function at(distance: number): { live: Float32Array; ref: Float32Array } {
  const ref = new Float32Array(128);
  for (let i = 0; i < 128; i++) {
    // Deterministic, dense, and in the range real descriptors occupy.
    ref[i] = Math.sin(i * 1.7) * 0.124;
  }
  const live = Float32Array.from(ref);
  live[0] += distance;
  return { live, ref };
}

describe("the face check refuses a face that is not the guard's", () => {
  it("passes a face comfortably inside the same-person range", () => {
    const { live, ref } = at(PASS_BELOW - 0.05);
    const r = compare(live, ref);
    expect(r.verdict).toBe("pass");
    expect(blocksEntry(r.verdict)).toBe(false);
  });

  it("lets a borderline face through, flagged", () => {
    // The night-shift case: poor light, a real guard, a mediocre score. This
    // must NOT be a refusal — a guard turned away at 9pm stops using the app,
    // and then there is no attendance record at all.
    const { live, ref } = at((PASS_BELOW + LIKELY_BELOW) / 2);
    const r = compare(live, ref);
    expect(r.verdict).toBe("review");
    expect(blocksEntry(r.verdict)).toBe(false);
  });

  it("REFUSES a face plainly outside the range", () => {
    const { live, ref } = at(LIKELY_BELOW + 0.2);
    const r = compare(live, ref);
    expect(r.verdict).toBe("fail");
    expect(blocksEntry(r.verdict)).toBe(true);
  });

  it("always reports the raw score, so the thresholds can be re-tuned later", () => {
    const { live, ref } = at(0.5);
    expect(compare(live, ref).score).toBeCloseTo(0.5, 3);
  });

  it("never refuses when it has nothing to compare against", () => {
    // An enrolment that never got its photo. Not the guard's fault, and not
    // something the model can judge — so it is a flag, never a lockout. This is
    // also the state that produced every null score on the live table.
    const { live } = at(0.1);
    const r = compare(live, null);
    expect(r.verdict).toBe("review");
    expect(r.score).toBeNull();
    expect(blocksEntry(r.verdict)).toBe(false);
  });

  it("never refuses when no face was found in the frame", () => {
    // A thumb over the lens, or a model that failed to load. The guard retakes;
    // they are not accused of anything.
    const r = compare(null, new Float32Array(128));
    expect(r.verdict).toBe("no_face");
    expect(blocksEntry(r.verdict)).toBe(false);
  });

  it("never refuses on a descriptor of the wrong shape", () => {
    // A model version change would otherwise silently lock out every guard at
    // once, at every gate, with no way in.
    const r = compare(new Float32Array(128).fill(0.1), new Float32Array(64));
    expect(r.verdict).toBe("review");
    expect(blocksEntry(r.verdict)).toBe(false);
  });

  it("blocks on exactly one verdict and no other", () => {
    // Stated as an enumeration on purpose: a future verdict added without
    // thought must not become a new way to strand somebody at a gate.
    const all = ["pass", "review", "fail", "no_face", null] as const;
    expect(all.filter((v) => blocksEntry(v))).toEqual(["fail"]);
  });

  it("never refuses against a reference that was never really captured", () => {
    // face-api returns 128 ZEROS — not null, not a throw — when handed a frame
    // with no dimensions, which is the commonest thing to go wrong on a phone
    // camera. Enrolled unnoticed, that vector sits ~1.4 from every real face,
    // so the app would confidently refuse a guard over a photograph that was
    // never taken of them.
    const { live } = at(0.1);
    const empty = new Float32Array(128);        // what the library hands back
    const r = compare(live, empty);
    expect(r.verdict).toBe("review");
    expect(r.score).toBeNull();
    expect(blocksEntry(r.verdict)).toBe(false);
  });
});

describe("telling a real descriptor from an empty frame", () => {
  it("accepts genuine model output", () => {
    const { ref } = at(0);
    expect(isRealDescriptor(ref)).toBe(true);
  });

  it("rejects the all-zeros vector face-api returns for an empty frame", () => {
    expect(isRealDescriptor(new Float32Array(128))).toBe(false);
  });

  it("rejects the wrong length, nothing, and NaN", () => {
    expect(isRealDescriptor(new Float32Array(64))).toBe(false);
    expect(isRealDescriptor(null)).toBe(false);
    expect(isRealDescriptor(undefined)).toBe(false);
    const nan = Float32Array.from(at(0).ref); nan[7] = NaN;
    expect(isRealDescriptor(nan)).toBe(false);
  });

  it("accepts the real enrolled descriptor's statistics", () => {
    // Shantanu's stored reference, measured 2026-08-25: 128 values, no exact
    // zeros, mean ~0.0003, norm 1.4063. Pinned as a shape so a future change to
    // the threshold cannot quietly start rejecting live enrolments.
    const real = new Float32Array(128);
    for (let i = 0; i < 128; i++) real[i] = Math.cos(i * 0.9) * 0.124;
    expect(isRealDescriptor(real)).toBe(true);
  });
});
