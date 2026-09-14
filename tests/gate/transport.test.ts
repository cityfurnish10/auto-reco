// "The same truck" has to survive however it was spelled at the gate.
import { describe, expect, it } from "vitest";
import { agentKey, commonestSpelling, groupVisits, transportKey } from "../../lib/gate/transport";

describe("one truck, many spellings", () => {
  it("real Delhi spellings collapse to their registration", () => {
    // All recorded at the Delhi gate, 10–14 Sep 2026.
    expect(new Set(["VIPIN-EV-DL1LAT4654", "DL1LAT 4654", "DL1LAT4654"].map(transportKey))).toEqual(new Set(["DL1LAT4654"]));
    expect(new Set(["MT - T - DL-1L-AN9769", "DL 1LAN 9769", "DL1LAN 9769"].map(transportKey))).toEqual(new Set(["DL1LAN9769"]));
    expect(new Set(["ADHOC- HR38AB2559", "HR 38AB 2559"].map(transportKey))).toEqual(new Set(["HR38AB2559"]));
    expect(transportKey("VT-IN-DL1LAR3256")).toBe("DL1LAR3256");
  });

  it("does not merge two different plates a guard mistyped", () => {
    // DL1LAN 7120 and DL1LAB 7120 were both entered for Sandip's truck on 14
    // Sep. One is a typo, but which is not the screen's call to make.
    expect(transportKey("DL1LAN 7120")).not.toBe(transportKey("DL1LAB 7120"));
  });

  it("text with no plate in it still groups with its own spelling", () => {
    expect(transportKey("hired tempo")).toBe(transportKey("HIRED-TEMPO"));
  });
});

describe("agents", () => {
  it("merges case and spacing only", () => {
    expect(agentKey("Kavi saroj")).toBe(agentKey(" Kavi  Saroj "));
    expect(agentKey("Sudhir")).not.toBe(agentKey("Sudhir Kumar"));
  });
  it("shows the spelling used most", () => {
    expect(commonestSpelling(["Kavi saroj", "Kavi Saroj", "Kavi Saroj"])).toBe("Kavi Saroj");
  });
});

describe("visits", () => {
  const t = (id: string, vehicleNo: string, openedAt: string, closedAt: string | null) =>
    ({ id, vehicleNo, openedAt, closedAt });
  const H = 3600_000;

  it("THE DELHI CASE: a second trip for forgotten items joins the first; the evening return does not", () => {
    // Sudhir, 14 Sep IST: 10:01–10:12 and 10:50–10:53 on DL1LAN9769 (under two
    // spellings), and a separate trip at 19:00.
    const v = groupVisits([
      t("a", "DL 1LAN 9769", "2026-09-14T04:31:00Z", "2026-09-14T04:42:00Z"),
      t("b", "DL1LAN 9769", "2026-09-14T05:20:00Z", "2026-09-14T05:23:00Z"),
      t("c", "MT - T - DL-1L-AN9769", "2026-09-14T13:30:00Z", "2026-09-14T13:40:00Z"),
    ], 2 * H);
    expect(v.map((x) => x.trips.map((y) => y.id))).toEqual([["c"], ["a", "b"]]);
    expect(v[1].start).toBe("2026-09-14T04:31:00Z");
    expect(v[1].end).toBe("2026-09-14T05:23:00Z");
  });

  it("the gap is measured from the previous trip ENDING, not starting", () => {
    const v = groupVisits([
      t("a", "DL1LAT4654", "2026-09-14T04:00:00Z", "2026-09-14T06:00:00Z"),
      t("b", "DL1LAT4654", "2026-09-14T06:30:00Z", "2026-09-14T06:40:00Z"),
    ], 1 * H);
    expect(v).toHaveLength(1);
  });

  it("THE DELHI CASE: a trip left open overnight does not swallow the next morning", () => {
    // DL1LAH3979: inward 20:16 IST, last item 20:20, closed 09:57 next day;
    // outward 10:14. Two visits, not one.
    const v = groupVisits([
      { id: "in", vehicleNo: "DL 1LAH 3979", openedAt: "2026-09-13T14:46:00Z", closedAt: "2026-09-14T04:27:00Z",
        lastActivityAt: "2026-09-13T14:50:00Z" },
      { id: "out", vehicleNo: "DL1LAH 3979", openedAt: "2026-09-14T04:44:00Z", closedAt: "2026-09-14T04:49:00Z",
        lastActivityAt: "2026-09-14T04:48:00Z" },
    ], 2 * H);
    expect(v.map((x) => x.trips.map((y) => y.id))).toEqual([["out"], ["in"]]);
  });

  it("an open trip counts from when it opened, and different trucks never share a visit", () => {
    const v = groupVisits([
      t("a", "DL1LAT4654", "2026-09-14T04:00:00Z", null),
      t("b", "DL1LAT4681", "2026-09-14T04:05:00Z", "2026-09-14T04:10:00Z"),
    ], 2 * H);
    expect(v).toHaveLength(2);
  });
});
