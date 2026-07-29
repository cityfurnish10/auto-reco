import { describe, expect, it } from "vitest";
import {
  FOLLOW_UP_DELAY_DAYS,
  followUpSendAt,
  shouldEnqueueFollowUp,
} from "../../lib/email/followup/queue";
import { isRerunFresh } from "../../lib/email/followup/build";
import { checkSheetCoverage, SHEET_TRUNCATION_FLOOR } from "../../lib/reconcile/sheet-guard";
import { recheckTargetDate } from "../../lib/reconcile/cron-dates";
import { addDays } from "../../lib/engine/dates";
import type { TotalsSnapshot } from "../../lib/email/followup/snapshot";

const snap = (flagged: number): TotalsSnapshot => ({
  v: 1,
  date: "2026-07-24",
  sentAt: "2026-07-25T11:15:00.000Z",
  overall: { movements: 100, tier1: flagged, tier2: 0, tier3: 5, open: flagged + 5, flagged },
  cities: [],
  keys: [],
  keysTruncated: false,
});

describe("when a digest earns a follow-up", () => {
  it("queues one for a normal send", () => {
    expect(shouldEnqueueFollowUp({ sent: true, snapshot: snap(12) }).enqueue).toBe(true);
  });

  it("does not queue one for an email that never went out", () => {
    // "Of the X items flagged on D" is meaningless if nobody received D.
    expect(shouldEnqueueFollowUp({ sent: false, snapshot: snap(12) }).enqueue).toBe(false);
  });

  it("does not queue one when the day never reconciled", () => {
    const d = shouldEnqueueFollowUp({ sent: true, runIncomplete: true, snapshot: snap(12) });
    expect(d.enqueue).toBe(false);
    expect(d.reason).toMatch(/no completed run/);
  });

  it("does not queue one without figures to quote", () => {
    // A pre-0016 send, or one whose build failed. Better silent than guessing.
    expect(shouldEnqueueFollowUp({ sent: true, snapshot: null }).enqueue).toBe(false);
  });

  it("does not queue one for a clean day", () => {
    // "Of the 0 items flagged, 0 remain" is noise; the digest already said so.
    expect(shouldEnqueueFollowUp({ sent: true, snapshot: snap(0) }).enqueue).toBe(false);
  });
});

describe("when the follow-up is due", () => {
  it("lands the day the re-check pass re-runs that date", () => {
    // These two numbers must agree or the follow-up waits forever for a re-run
    // that already happened on a different day.
    const business = "2026-07-26";
    const due = followUpSendAt(business).slice(0, 10);
    const atIst = (iso: string) => new Date(`${iso}T11:30:00.000Z`); // 17:00 IST
    expect(recheckTargetDate(atIst(due))).toBe(business);
  });

  it("is scheduled BEFORE the drain, so cron jitter cannot slip it a day", () => {
    // The digest cron fires at 11:15Z. send_at must be earlier, or a negative
    // jitter misses `send_at <= now` and the row waits another 24 hours.
    expect(followUpSendAt("2026-07-24")).toBe("2026-07-27T11:00:00.000Z");
  });

  it("is three days after the business date", () => {
    // D's digest goes out on D+1, the follow-up two days after that.
    expect(FOLLOW_UP_DELAY_DAYS).toBe(3);
    expect(followUpSendAt("2026-07-24").slice(0, 10)).toBe(addDays("2026-07-24", 3));
  });

  it("crosses a month and a year boundary", () => {
    expect(followUpSendAt("2026-01-30").slice(0, 10)).toBe("2026-02-02");
    expect(followUpSendAt("2026-12-30").slice(0, 10)).toBe("2027-01-02");
  });
});

describe("the re-run interlock", () => {
  const since = "2026-07-25T11:15:00.000Z";
  const run = (status: string, completed_at: string | null) => ({ status, completed_at });

  it("accepts a run that COMPLETED after the email went out", () => {
    expect(isRerunFresh([run("success", "2026-07-27T11:02:00Z")], since).fresh).toBe(true);
    expect(isRerunFresh([run("partial", "2026-07-27T11:02:00Z")], since).fresh).toBe(true);
  });

  it("ignores a run that never finished", () => {
    // THE reason this tests completed_at and not created_at: createRun stamps
    // created_at at the START, so a run killed by the 60s ceiling keeps a null
    // completed_at forever. One such row is already stranded in production, and
    // a created_at test would read it as a successful re-check.
    expect(isRerunFresh([run("running", null)], since).fresh).toBe(false);
    expect(isRerunFresh([run("failed", null)], since).fresh).toBe(false);
    expect(isRerunFresh([run("success", null)], since).fresh).toBe(false);
  });

  it("ignores the run that produced the email itself", () => {
    expect(isRerunFresh([run("success", "2026-07-25T11:00:00Z")], since).fresh).toBe(false);
  });

  it("reports the last completed run, for the stale banner", () => {
    const f = isRerunFresh(
      [run("success", "2026-07-24T11:00:00Z"), run("running", null)],
      since
    );
    expect(f.fresh).toBe(false);
    expect(f.lastCompletedAt).toBe("2026-07-24T11:00:00Z");
  });

  it("says so when a date has never run at all", () => {
    expect(isRerunFresh([], since)).toEqual({ fresh: false, lastCompletedAt: null });
  });
});

describe("the truncated-sheet guard", () => {
  // A partial truncation does not look like an outage: rows still come back, so
  // the sheet reads as REPORTED and resolveStaleOpenVariances then rewrites
  // genuinely-open items to "this gap had cleared". Silent data loss dressed as
  // a resolution, on a date whose follow-up is about to quote the result.
  it("flags a pull that came back materially short", () => {
    const [c] = checkSheetCoverage({ DELHI: 20 }, { DELHI: 200 });
    expect(c.truncated).toBe(true);
  });

  it("tolerates the normal churn of edited and deleted rows", () => {
    expect(checkSheetCoverage({ DELHI: 190 }, { DELHI: 200 })[0].truncated).toBe(false);
    expect(checkSheetCoverage({ DELHI: 260 }, { DELHI: 200 })[0].truncated).toBe(false);
  });

  it("puts the threshold where a false alarm is cheaper than a false resolution", () => {
    expect(SHEET_TRUNCATION_FLOOR).toBe(0.8);
    expect(checkSheetCoverage({ DELHI: 159 }, { DELHI: 200 })[0].truncated).toBe(true);
    expect(checkSheetCoverage({ DELHI: 161 }, { DELHI: 200 })[0].truncated).toBe(false);
  });

  it("says nothing about a date with no prior figures", () => {
    // The first run of a date has nothing to compare against, and inventing a
    // comparison would disable the sheet on every fresh reconcile.
    expect(checkSheetCoverage({ DELHI: 5 }, {})).toEqual([]);
    expect(checkSheetCoverage({ DELHI: 5 }, { DELHI: 0 })).toEqual([]);
  });

  it("treats a city that vanished entirely as truncated", () => {
    expect(checkSheetCoverage({}, { DELHI: 200 })[0]).toMatchObject({ pulled: 0, truncated: true });
  });
});
