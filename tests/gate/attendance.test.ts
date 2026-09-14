import { describe, expect, it } from "vitest";
import { attendanceFor, type FaceRow, type ShiftRow } from "../../lib/gate/attendance";

const shift = (p: Partial<ShiftRow>): ShiftRow => ({ id: "s1", guardId: "g1", checkedInAt: "2026-09-14T03:30:00Z",
  checkedOutAt: null, status: "open", autoClosedReason: null, inGeoOk: true, outGeoOk: null, ...p });
const face = (p: Partial<FaceRow>): FaceRow => ({ id: "f1", shiftId: "s1", trigger: "check_in", verdict: "pass",
  matchScore: 0.3, capturedAt: "2026-09-14T03:30:00Z", hasSelfie: true, reviewState: "none", ...p });

describe("a guard's day", () => {
  it("first sign-in and last sign-out across several shifts, each with its own face", () => {
    const d = attendanceFor("2026-09-14", [
      shift({ id: "a", checkedInAt: "2026-09-14T03:30:00Z", checkedOutAt: "2026-09-14T07:00:00Z", status: "closed" }),
      shift({ id: "b", checkedInAt: "2026-09-14T08:00:00Z", checkedOutAt: "2026-09-14T12:30:00Z", status: "closed" }),
    ], [
      face({ id: "in-a", shiftId: "a", trigger: "check_in" }),
      face({ id: "in-b", shiftId: "b", trigger: "check_in", capturedAt: "2026-09-14T08:00:00Z" }),
      face({ id: "out-b", shiftId: "b", trigger: "check_out", capturedAt: "2026-09-14T12:30:00Z" }),
    ]).get("g1")!;
    expect(d.firstIn?.face?.checkId).toBe("in-a");
    expect(d.lastOut?.face?.checkId).toBe("out-b");
    expect(d.shifts).toBe(2);
    expect(d.minutes).toBe(540);
  });

  it("is still on duty while any shift of the day is open — no sign-out yet", () => {
    const d = attendanceFor("2026-09-14", [
      shift({ id: "a", checkedOutAt: "2026-09-14T07:00:00Z", status: "closed" }),
      shift({ id: "b", checkedInAt: "2026-09-14T08:00:00Z" }),
    ], []).get("g1")!;
    expect(d.onDuty).toBe(true);
    expect(d.lastOut).toBeNull();
  });

  it("a night shift belongs to the day it started, not split at midnight", () => {
    const s = [shift({ checkedInAt: "2026-09-13T14:30:00Z", checkedOutAt: "2026-09-14T00:30:00Z", status: "closed" })];
    expect(attendanceFor("2026-09-13", s, []).has("g1")).toBe(true);   // 20:00 IST on the 13th
    expect(attendanceFor("2026-09-14", s, []).has("g1")).toBe(false);
  });

  it("THE DELHI CASE: a sweep-closed shift shows no sign-out time and no hours — the time was invented", () => {
    // Mahilal, 12 Sep: in 18:41, "out" 10:41 next day = in + 16h, auto_closed.
    const d = attendanceFor("2026-09-12", [shift({ checkedInAt: "2026-09-12T13:11:00Z", checkedOutAt: "2026-09-13T05:11:00Z",
      status: "closed", autoClosed: true })], []).get("g1")!;
    expect(d.lastOut).toMatchObject({ auto: true, at: null, face: null });
    expect(d.minutes).toBeNull();
  });
});
