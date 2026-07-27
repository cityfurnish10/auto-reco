// Closure reasons, in a plain module so both the client dialogs and the server
// API routes can share them. They can't live in close-variance-modal.tsx —
// that is a "use client" component, and importing it into a route handler
// would drag React into the server bundle.
//
// PENDING_LIST_REASON is load-bearing rather than decorative: the Pending List
// page selects on this exact string, so anything that writes a closure reason
// must use these constants and never free text, or an item silently fails to
// appear on the list.

export type ClosureReason =
  | "Data Entry Error"
  | "Transit Delay"
  | "Theft"
  | "System Glitch"
  | "Validation Error"
  | "Backdated issue resolved by the team"
  | "Wrong Entry Made by team"
  | "Pending List"
  | "Other";

export const PENDING_LIST_REASON: ClosureReason = "Pending List";

// Order is deliberate: Pending List first because it is the one that changes
// where the row goes rather than just labelling why it closed.
export const REASONS: ClosureReason[] = [
  "Pending List",
  "Backdated issue resolved by the team",
  "Wrong Entry Made by team",
  "Data Entry Error",
  "Validation Error",
  "Transit Delay",
  "Theft",
  "System Glitch",
  "Other",
];

// Shown under the select. "Pending List" and "Validation Error" both need a
// line — one changes the row's destination, the other says the variance itself
// was wrong, and neither is obvious from the label alone.
export const REASON_HINT: Partial<Record<ClosureReason, string>> = {
  "Pending List": "Parks this on the Pending List for follow-up instead of finishing it here.",
  "Validation Error": "The variance itself is wrong — bad data, not a real stock movement.",
  "Backdated issue resolved by the team":
    "The entry was made late, on an earlier date — the stock itself was never missing.",
  "Wrong Entry Made by team": "Someone logged this against the wrong unit, ticket or direction.",
};
