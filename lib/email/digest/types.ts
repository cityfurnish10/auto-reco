// The data shape the digest renders. Produced by build.ts from persisted rows.

/** Per-source, per-direction movement counts for one city (migration 0012). */
export interface CityMovementCounts {
  sheetIn: number;
  sheetOut: number;
  odooIn: number;
  odooOut: number;
  dtIn: number;
  dtOut: number;
  physIn: number;
  physOut: number;
  // Separate from the counts on purpose: a zero cannot tell "the connector was
  // down" from "nothing moved", and the email must not guess.
  reported: { P: boolean; S: boolean; D: boolean; O: boolean };
}

/**
 * Guard-register state for a city on the date. Read from guard_uploads rather
 * than inferred from reported_p, because these are three different asks of
 * three different people: nobody uploaded it, nobody has read it yet, or the
 * reading service failed.
 */
export type RegisterState = "received" | "missing" | "pending" | "failed" | "off";

/** One line of the "Do this today" list — a risk kind, summed across cities. */
export interface ActionItem {
  label: string; // owner-facing, e.g. "System-Only Entry"
  tier: 1 | 2;
  count: number;
  action: string; // imperative
  /**
   * Why it matters, from the label module — e.g. "Odoo booked a customer
   * movement today that nobody at the gate, on the sheet or in the app saw."
   *
   * Only the top tier-1 item renders it; three would cost a quarter of the word
   * budget. Unambiguous per group because actions are grouped by (display,
   * action) and risk travels with action on the same VarianceLabel.
   */
  risk: string;
  team: string;
  /** Largest contributing cities, biggest first, for the inline breakdown. */
  cities: { city: string; count: number }[];
}

/** A (label, city) pattern seen on several recent days. */
export interface WatchItem {
  label: string;
  city: string;
  days: number; // days present within the window
  consecutive: boolean;
  today: number;
  median: number; // median of the prior comparable days
  trend: "worsening" | "steady" | "cleared";
}

export interface CityDigestRow {
  city: string;
  /** Distinct directional movements — the denominator, not a variance count. */
  movements: number;
  /** Open counts by risk tier. Tier 3 is informational and never chased. */
  tier1: number;
  tier2: number;
  tier3: number;
  /** Every open item regardless of tier — reconciles the email to the dashboard. */
  open: number;
  register: RegisterState;
  /** The largest tier-1 kind for this city, or null when there is none. */
  topRisk: { label: string; count: number; team: string } | null;
  counts?: CityMovementCounts;
  /**
   * How this city's at-risk count compares with its own recent comparable days.
   *
   * NULL means "not comparable", never "no change": fewer than two comparable
   * prior days, or a day on which this city was short a source. A city that was
   * missing its guard register has an understated count, and ranking it against
   * days when all four books filed manufactures a "worse" verdict.
   */
  trend?: "worse" | "usual" | "better" | null;
}

export interface DigestData {
  date: string; // business date reconciled (YYYY-MM-DD)
  generatedAt: string; // ISO timestamp
  totals: {
    movements: number;
    tier1: number;
    tier2: number;
    tier3: number;
    /** All open items — what the dashboard shows for the same run. */
    open: number;
  };
  cities: CityDigestRow[]; // sorted tier1 desc
  /** Tier-1 first, then tier-2, biggest first. Rendered as "Do this today". */
  actions: ActionItem[];
  /** Tier-3 kinds with counts, biggest first — the footer line. */
  informational: { label: string; count: number }[];
  /** Absent when the query failed; the section is then simply omitted. */
  watch?: WatchItem[];
  /** True when no completed reconciliation exists for `date`. */
  runIncomplete?: boolean;
  /**
   * Today's at-risk RATE against the trailing week — the opening's lead clause.
   *
   * Only set when every live city reported all four sources today. One city
   * short a book understates the day, and a headline ranking a day we could not
   * fully see is the same error lib/stock/coverage.ts refuses for the analyser.
   */
  dayTrend?: "worst" | "usual" | "best" | null;
  /** Consecutive clean days ending today, when the day itself is clean. */
  cleanStreak?: number;
  /**
   * Natural keys of the flagged (tier 1 + 2) rows, for the follow-up snapshot.
   *
   * NOT rendered — it never reaches buildSections, so the anti-drift and
   * word-budget tests are untouched. It exists because the follow-up must match
   * on the UNIT that was flagged, not on counts: a superseded row is deleted and
   * replaced with a fresh identity, so a count-only comparison would report a
   * still-broken unit as newly flagged.
   */
  flaggedKeys?: string[];
}
