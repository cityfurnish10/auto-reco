import { describe, expect, it } from "vitest";
import { TOOL_SCHEMAS } from "../../lib/ai/tools";
import { visibleCitiesFor } from "../../lib/ai/tools/context";
import { windowFor } from "../../lib/ai/tools/flagged-items";
import { buildSystemPrompt } from "../../lib/ai/system-prompt";
import { containsBannedWords } from "../../lib/ai/sanitize";
import { HELP_TOPICS, helpForTopic } from "../../lib/help/portal-help";
import { CITIES } from "../../lib/sample-data";
import { fmtDay } from "../../lib/ai/format";

const anchor = {
  today: "2026-07-29",
  latestReconciled: "2026-07-27",
  detailHeldFrom: "2026-07-22",
};

describe("tool schemas describe the real value domains", () => {
  it("uses the actual city list, so the model cannot invent one", () => {
    for (const s of TOOL_SCHEMAS) {
      const props = (s.function.parameters as { properties?: Record<string, { enum?: string[] }> })
        .properties;
      const city = props?.city;
      if (city?.enum) expect(city.enum.sort()).toEqual([...CITIES].sort());
    }
  });

  it("never exposes priority, which is unusable and internal", () => {
    // The engine stopped emitting 'Medium' but historical rows still carry it,
    // so a priority filter would quietly mean different things by date. Tools
    // speak in severity tiers instead.
    const json = JSON.stringify(TOOL_SCHEMAS);
    expect(json).not.toMatch(/"priority"/);
    expect(json).not.toMatch(/\bMedium\b/);
  });

  it("keeps internal vocabulary out of the descriptions the model reads", () => {
    expect(containsBannedWords(JSON.stringify(TOOL_SCHEMAS))).toEqual([]);
  });

  it("gives every parameter a description", () => {
    for (const s of TOOL_SCHEMAS) {
      expect(s.function.description.length).toBeGreaterThan(40);
      const props = (s.function.parameters as { properties: Record<string, { description?: string; enum?: unknown }> })
        .properties;
      for (const [key, spec] of Object.entries(props)) {
        // An enum is self-describing; anything else needs prose.
        if (!spec.enum) expect(spec.description, `${s.function.name}.${key}`).toBeTruthy();
      }
    }
  });

  it("exposes exactly four tools", () => {
    // Adding one is a deliberate act — see the write-method test in
    // rls-boundary.test.ts, which is what actually enforces read-only.
    expect(TOOL_SCHEMAS.map((s) => s.function.name).sort()).toEqual([
      "count_flagged_items",
      "find_barcode_journey",
      "list_flagged_items",
      "portal_help",
    ]);
  });
});

describe("windowFor anchors on the last reconciled day, not the wall clock", () => {
  const ctx = { visibleCities: [...CITIES], detailHeldFrom: "2026-07-22", latestReconciled: "2026-07-27" };

  it("treats latest_day as the last completed check", () => {
    expect(windowFor("latest_day", ctx)).toMatchObject({ from: "2026-07-27", to: "2026-07-27" });
  });

  it("counts seven days inclusive of the anchor", () => {
    expect(windowFor("last_7_days", ctx)).toMatchObject({ from: "2026-07-21", to: "2026-07-27" });
  });

  it("drops the date filter entirely for still_unresolved", () => {
    // Open items are kept regardless of age, so bounding this by date would
    // hide the oldest and most important ones.
    expect(windowFor("still_unresolved", ctx)).toMatchObject({ from: null, to: null });
  });
});

describe("the system prompt", () => {
  it("tells a manager they can only see their own city", () => {
    // RLS returns an empty set rather than an error, so without this the model
    // would answer "nothing is open in Delhi" to a Mumbai manager.
    const p = buildSystemPrompt(anchor, { role: "manager", city: "MUMBAI", visibleCities: ["MUMBAI"] });
    expect(p).toMatch(/ONLY see MUMBAI/);
    expect(p).toMatch(/do not report a zero/);
    expect(p).not.toMatch(/\bDELHI\b/);
  });

  it("gives an admin the full city list", () => {
    const p = buildSystemPrompt(anchor, { role: "admin", city: null, visibleCities: [...CITIES] });
    for (const c of CITIES) expect(p).toContain(c);
  });

  it("states the retention floor as a date, so absence can be explained", () => {
    const p = buildSystemPrompt(anchor, { role: "admin", city: null, visibleCities: [...CITIES] });
    expect(p).toContain(fmtDay("2026-07-22"));
    expect(p).toMatch(/no_detail_retained/);
  });

  it("survives having no runs and no retained detail at all", () => {
    const p = buildSystemPrompt(
      { today: "2026-07-29", latestReconciled: null, detailHeldFrom: null },
      { role: "admin", city: null, visibleCities: [...CITIES] }
    );
    expect(p).toMatch(/No daily check has completed/);
    expect(p).not.toMatch(/null|undefined/);
  });
});

describe("portal help is the only source for how-do-I answers", () => {
  it("resolves every advertised topic", () => {
    for (const t of HELP_TOPICS) {
      const entry = helpForTopic(t, "admin");
      expect(entry, t).toBeTruthy();
      expect(entry!.points.length).toBeGreaterThan(0);
    }
  });

  it("uses no banned vocabulary — this text goes straight into the model's mouth", () => {
    // The version that lived in help-button.tsx said "losses (REAL)" and
    // "switch the bucket filter to INFO"; serving that verbatim would hand the
    // assistant the exact words it is forbidden to write.
    for (const t of HELP_TOPICS) {
      for (const role of ["admin", "manager"]) {
        const entry = helpForTopic(t, role)!;
        expect(containsBannedWords(JSON.stringify(entry)), `${t}/${role}`).toEqual([]);
      }
    }
  });

  it("does not tell a manager to use controls only an admin has", () => {
    const managerText = JSON.stringify(helpForTopic("dashboard", "manager"));
    expect(managerText).not.toMatch(/Approve or reject what city managers submit/);
  });
});

describe("visibleCitiesFor", () => {
  it("gives an admin every city and a manager exactly one", () => {
    expect(visibleCitiesFor("admin", null)).toEqual([...CITIES]);
    expect(visibleCitiesFor("manager", "PUNE")).toEqual(["PUNE"]);
  });

  it("gives a manager with no city assigned nothing, rather than everything", () => {
    // Fail closed: an unassigned account must not silently become an admin.
    expect(visibleCitiesFor("manager", null)).toEqual([]);
  });
});

describe("fmtDay", () => {
  it("reads dates as UTC parts, so a timezone cannot shift the day", () => {
    expect(fmtDay("2026-07-01")).toBe("1 Jul 2026");
    expect(fmtDay("2026-12-31")).toBe("31 Dec 2026");
  });

  it("degrades rather than printing null", () => {
    expect(fmtDay(null)).toBe("an unknown date");
  });
});
