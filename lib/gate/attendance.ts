// A guard's attendance for one day: first sign-in, last sign-out, and the face
// that did each.
//
// WHICH DAY A SHIFT BELONGS TO. The IST calendar date it STARTED on. Attendance
// is a calendar question ("was Mahilal in on the 14th?"), not the 15:00→15:00
// business day movements use, and a night shift that starts at 20:00 and ends at
// 06:00 is one attendance, on the day it began — splitting it at midnight would
// mark a guard as leaving on a day they arrived and arriving on one they left.
//
// Pure, so the rules are tested without a database.

export interface ShiftRow {
  id: string; guardId: string; checkedInAt: string; checkedOutAt: string | null;
  status: string; autoClosedReason: string | null; inGeoOk: boolean | null; outGeoOk: boolean | null;
  /**
   * Closed by the nightly sweep (0032), not by the guard. Its checked_out_at is
   * INVENTED — check-in plus 16 hours — so it is never shown as a sign-out time
   * or counted as hours. Mahilal and Deepak, 12 Sep: "signed out" at 10:41 and
   * 10:42 next morning, exactly 16h after arriving, having never signed out.
   */
  autoClosed?: boolean;
}
export interface FaceRow {
  id: string; shiftId: string | null; trigger: string; verdict: string;
  matchScore: number | null; capturedAt: string; hasSelfie: boolean; reviewState: string | null;
}
export interface FaceMark { checkId: string; verdict: string; score: number | null; hasSelfie: boolean; review: string | null }

export interface AttendanceDay {
  guardId: string;
  shifts: number;
  firstIn: { at: string; geoOk: boolean | null; face: FaceMark | null } | null;
  /** null while the last shift is still open. `at` is null when nobody signed
   *  out and the sweep closed it — there is no real time to show. */
  lastOut: { at: string | null; geoOk: boolean | null; face: FaceMark | null; auto: boolean } | null;
  onDuty: boolean;
  minutes: number | null;
}

const istDate = (iso: string) => new Date(Date.parse(iso) + 5.5 * 3600_000).toISOString().slice(0, 10);

/** Shifts that started on `date` (IST), grouped per guard. */
export function attendanceFor(date: string, shifts: ShiftRow[], faces: FaceRow[]): Map<string, AttendanceDay> {
  const out = new Map<string, AttendanceDay>();
  const facesByShift = new Map<string, FaceRow[]>();
  for (const f of faces) if (f.shiftId) facesByShift.set(f.shiftId, [...(facesByShift.get(f.shiftId) ?? []), f]);

  const pick = (shiftId: string, trigger: string, last: boolean): FaceMark | null => {
    const list = (facesByShift.get(shiftId) ?? []).filter((f) => f.trigger === trigger)
      .sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
    const f = last ? list[list.length - 1] : list[0];
    return f ? { checkId: f.id, verdict: f.verdict, score: f.matchScore, hasSelfie: f.hasSelfie, review: f.reviewState } : null;
  };

  const byGuard = new Map<string, ShiftRow[]>();
  for (const s of shifts) {
    if (istDate(s.checkedInAt) !== date) continue;
    byGuard.set(s.guardId, [...(byGuard.get(s.guardId) ?? []), s]);
  }
  for (const [guardId, list] of byGuard) {
    list.sort((a, b) => a.checkedInAt.localeCompare(b.checkedInAt));
    const first = list[0];
    const open = list.some((s) => s.status === "open");
    const closed = list.filter((s) => s.checkedOutAt).sort((a, b) => a.checkedOutAt!.localeCompare(b.checkedOutAt!));
    const last = closed[closed.length - 1];
    const auto = !!last && (last.status === "auto_closed" || !!last.autoClosed);
    out.set(guardId, {
      guardId,
      shifts: list.length,
      firstIn: { at: first.checkedInAt, geoOk: first.inGeoOk, face: pick(first.id, "check_in", false) },
      // While any shift of the day is still open the guard has not signed out
      // for the day, whatever an earlier shift says.
      lastOut: open || !last ? null : {
        at: auto ? null : last.checkedOutAt!, geoOk: auto ? null : last.outGeoOk,
        face: pick(last.id, "check_out", true), auto,
      },
      onDuty: open,
      minutes: !open && last && !auto ? Math.round((Date.parse(last.checkedOutAt!) - Date.parse(first.checkedInAt)) / 60000) : null,
    });
  }
  return out;
}
