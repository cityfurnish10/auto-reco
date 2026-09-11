// The phone must be able to tell which queued entry a server reply answers.
//
// It could not, for three kinds of entry. A trip close, a sign-out and a void
// are queued under their own ids so they do not overwrite what they follow,
// while the server names its reply after the trip, shift or scan touched. The
// phone removed by the reply's name, which matched nothing, so every one of
// them sat on the guard's screen as "saved here, not sent yet" indefinitely —
// found on a demo phone showing five, all of which the server already held.

import { describe, expect, it } from "vitest";
import { pairReplies } from "../../lib/gate/client/api";

const trip = "T1", shift = "S1", scan = "SC1";

const queue = [
  { clientId: trip, kind: "trip" as const, payload: { clientTripId: trip, status: "open" } },
  { clientId: scan, kind: "scan" as const, payload: { clientScanId: scan, clientTripId: trip } },
  { clientId: `${trip}-close`, kind: "trip" as const, payload: { clientTripId: trip, status: "closed" } },
  { clientId: "V9", kind: "void" as const, payload: { clientScanId: scan } },
  { clientId: `${shift}-out`, kind: "shift" as const, payload: { clientShiftId: shift, status: "closed" } },
  { clientId: "F1", kind: "face" as const, payload: { clientCheckId: "F1" } },
];

describe("pairing a sync reply with the queue", () => {
  it("clears a trip close, a sign-out and a void — the three that used to stick", () => {
    const pairs = pairReplies(queue.slice(2), {
      trips: [{ clientId: trip, status: "duplicate" }],
      voids: [{ clientId: scan, status: "stored" }],
      shifts: [{ clientId: shift, status: "duplicate" }],
    });
    expect(pairs.map((p) => p.queueId).sort()).toEqual([`${shift}-out`, `${trip}-close`, "V9"].sort());
  });

  it("gives an open and a close sent together one reply each, in the order sent", () => {
    const pairs = pairReplies(queue, {
      trips: [{ clientId: trip, status: "stored" }, { clientId: trip, status: "duplicate" }],
    });
    expect(pairs).toEqual([
      { queueId: trip, reply: { clientId: trip, status: "stored" } },
      { queueId: `${trip}-close`, reply: { clientId: trip, status: "duplicate" } },
    ]);
  });

  it("does not confuse a void with the scan it retracts — both carry the scan's id", () => {
    const pairs = pairReplies(queue, {
      scans: [{ clientId: scan, status: "stored" }],
      voids: [{ clientId: scan, status: "rejected", reason: "x" }],
    });
    expect(pairs.find((p) => p.reply.status === "stored")?.queueId).toBe(scan);
    expect(pairs.find((p) => p.reply.status === "rejected")?.queueId).toBe("V9");
  });

  it("removes nothing for a reply it cannot place — the entry is sent again, never lost", () => {
    expect(pairReplies(queue, { trips: [{ clientId: "(missing id)", status: "rejected" }] })).toEqual([]);
    // More replies than entries: the extra one is ignored, not doubled up.
    expect(pairReplies(queue.slice(5), {
      faceChecks: [{ clientId: "F1", status: "stored" }, { clientId: "F1", status: "stored" }],
    })).toHaveLength(1);
  });
});
