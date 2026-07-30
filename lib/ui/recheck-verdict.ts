// What the page says about whether two checks of a day can be compared.
//
// PURE, and every user-visible string lives here, for two reasons: the copy can
// be run through the banned-word assertions in tests/email/vocabulary.ts, and
// `showDelta` — the flag that decides whether any change figure renders at all —
// cannot be re-decided by a component.
//
// THE ONE RULE THIS FILE ENFORCES: when the two checks did not read the same four
// books, no number describing a change may render. Not greyed out, not
// asterisked — absent, replaced by the sentence explaining why. Everything else on
// the page is a convenience; this is the reason it is worth building.
//
// Class strings are LITERAL. Tailwind scans lib/**, and a computed or
// concatenated class generates no CSS at all.

export type VerdictTone = "good" | "warn" | "info" | "neutral";

export type VerdictId =
  | "comparable"
  | "recheck-saw-less"
  | "recheck-saw-more"
  | "both-short"
  | "no-recheck"
  | "recheck-unfinished"
  | "no-history";

export interface Verdict {
  id: VerdictId;
  title: string;
  body: string;
  tone: VerdictTone;
  /**
   * May the page print cleared / still open / raised later?
   *
   * False is not "render zeros" and not "render greyed". It is "do not render
   * those sections at all". A zero in Cleared is a lie.
   */
  showDelta: boolean;
}

export const VERDICT_CLASS: Record<VerdictTone, string> = {
  good: "card p-4 bg-success-soft border border-success/30",
  warn: "card p-4 bg-warning-soft border border-status-warning/30",
  info: "card p-4 bg-info-soft border border-info/30",
  neutral: "card p-4 bg-surface-elevated border border-border",
};

export const VERDICT_ICON: Record<VerdictTone, string> = {
  good: "check_circle",
  warn: "warning",
  info: "info",
  neutral: "schedule",
};

/** The four books, named as a warehouse owner names them. */
export const BOOK_LABEL: Record<"P" | "S" | "D" | "O", string> = {
  P: "guard's book",
  S: "ops sheet",
  D: "delivery app",
  O: "Odoo",
};

function list(items: string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

export interface VerdictInput {
  clearedTrustworthy: boolean;
  newlyRaisedTrustworthy: boolean;
  /** Books the later check lost relative to the earlier one. */
  lostInB: ("P" | "S" | "D" | "O")[];
  /** Books the earlier check lacked. */
  lostInA: ("P" | "S" | "D" | "O")[];
  /** The guard's own sentence, when it has one more specific than ours. */
  headline?: string | null;
}

/**
 * The verdict for a pair of checks that both exist and both completed.
 *
 * `recheck-saw-less` is the case that matters. Measured: 2026-07-26 has runs
 * reading 101 and 26. The second was partial. Without this branch the page prints
 * "75 items fixed" about a day on which nothing was fixed.
 */
export function verdictFor(v: VerdictInput): Verdict {
  const lostB = list(v.lostInB.map((s) => BOOK_LABEL[s]));
  const lostA = list(v.lostInA.map((s) => BOOK_LABEL[s]));

  if (v.clearedTrustworthy && v.newlyRaisedTrustworthy) {
    return {
      id: "comparable",
      tone: "good",
      showDelta: true,
      title: "Both checks read all four books",
      body: "The change below is a real change.",
    };
  }

  if (!v.clearedTrustworthy && !v.newlyRaisedTrustworthy) {
    return {
      id: "both-short",
      tone: "warn",
      showDelta: false,
      title: "These two checks cannot be compared",
      body:
        v.headline ??
        "Each check was working from a different set of books, so a difference between them says more about what was read than about what moved. Both checks are shown below as separate totals.",
    };
  }

  if (!v.clearedTrustworthy) {
    return {
      id: "recheck-saw-less",
      tone: "warn",
      showDelta: false,
      title: "These two checks cannot be compared",
      body: lostB
        ? `The second check could not read the ${lostB}, so it worked from fewer books than the first. A check with fewer books will always find fewer problems — that is the missing book, not stock being put right. Nothing here counts as progress until this day is checked again in full.`
        : `The second check saw far less of the day than the first did. A source answered, but not in full, so items that look cleared may only be unseen.`,
    };
  }

  return {
    id: "recheck-saw-more",
    tone: "info",
    showDelta: false,
    title: "The first check was working from less",
    body: lostA
      ? `The first check could not read the ${lostA}, so it worked from fewer books. The second check read more and found more. Those extra units were always there — nothing new went wrong.`
      : `The first check saw less of the day than the second did, so the extra items it missed were always there rather than newly wrong.`,
  };
}

/** Only one check has run for this day. */
export function singlePassVerdict(detail: string | null): Verdict {
  return {
    id: "no-recheck",
    tone: "neutral",
    showDelta: false,
    title: "This day has only been checked once",
    body: detail
      ? `The second check has not run for this day. It was skipped because the first one ran long, which happens on roughly one day in three. There is nothing to compare until it runs.`
      : "The second check has not run for this day yet. It normally runs a few days later, and it is skipped when the first check runs long. There is nothing to compare until it does.",
  };
}

/** A second run exists but never finished. */
export function unfinishedVerdict(): Verdict {
  return {
    id: "recheck-unfinished",
    tone: "warn",
    showDelta: false,
    title: "The second check never finished",
    body: "It started and stopped part-way, so its figures are not usable. This page is still showing the first check only.",
  };
}

/** Nothing was recorded about what these runs found — before migration 0017. */
export function noHistoryVerdict(): Verdict {
  return {
    id: "no-history",
    tone: "neutral",
    showDelta: false,
    title: "No history was kept for this day",
    body: "We did not record what each check found on this day, so there is nothing to compare. Days from here on will have it.",
  };
}
