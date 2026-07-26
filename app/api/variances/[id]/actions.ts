// The variance lifecycle, in one place. Extracted from the [id] route so the
// bulk route shares it verbatim — two copies of "what does reject write?" is
// exactly the kind of drift that leaves half the rows in a wrong state.
//
// Not a route file: Next treats every route.ts under app/ as an endpoint, so
// this sits beside it as a plain module.

export type Action = "submit" | "approve" | "reject" | "close" | "dispute" | "reopen";

export const ALL_ACTIONS: Action[] = [
  "submit",
  "approve",
  "reject",
  "close",
  "dispute",
  "reopen",
];

// Everything except "submit" changes an approval/closure decision → admin only.
// RLS cannot distinguish manager-vs-admin writes, so this gate is the only
// thing enforcing it.
export const ADMIN_ONLY: Action[] = ["approve", "reject", "close", "dispute", "reopen"];

// "approve" is absent on purpose: it reads the row's existing submit_reason to
// carry it into the closure, so it cannot be expressed as a static patch. Both
// routes handle it separately.
export function buildUpdate(
  action: Exclude<Action, "approve">,
  appUserId: string,
  now: string,
  reason?: string,
  note?: string
) {
  switch (action) {
    case "submit":
      return {
        status: "pending_approval" as const,
        submitted_by: appUserId,
        submitted_at: now,
        submit_reason: reason ?? null,
        submit_note: note ?? null,
        rejection_note: null,
        closed_by: null,
        closed_at: null,
        closure_reason: null,
        closure_note: null,
      };
    case "reject":
      return {
        status: "open" as const,
        rejection_note: note ?? reason ?? null,
        closed_by: null,
        closed_at: null,
        closure_reason: null,
        closure_note: null,
      };
    case "close":
      return {
        status: "closed" as const,
        closure_reason: reason ?? null,
        closure_note: note ?? null,
        closed_by: appUserId,
        closed_at: now,
        rejection_note: null,
      };
    case "dispute":
      return {
        status: "in_progress" as const,
        closure_reason: reason ?? null,
        closure_note: note ?? null,
        closed_by: null,
        closed_at: null,
      };
    case "reopen":
      return {
        status: "open" as const,
        closure_reason: null,
        closure_note: null,
        closed_by: null,
        closed_at: null,
        rejection_note: null,
      };
  }
}
