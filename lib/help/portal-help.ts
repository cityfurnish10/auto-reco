// Per-page help content, shared by the "?" popover and the chat assistant.
//
// It lives in lib/ rather than inside help-button.tsx for two reasons: a
// "use client" module cannot be imported by a route handler, and the assistant
// must answer "how do I …" from this text rather than from the model's own idea
// of how the portal works.
//
// VOCABULARY: this is user-facing copy, so it uses the same plain English as
// lib/ui/variance-labels.ts and the digest email — "flagged items", "losses to
// chase" — never the internal REAL/INFO/variance tokens. That is enforced by a
// test, because the chat assistant is forbidden from writing those words and
// serving them in a help answer would put them in its mouth.

export type HelpTopic =
  | "dashboard"
  | "filtering_and_search"
  | "exports"
  | "uploads"
  | "approvals"
  | "pending_list"
  | "leaderboard"
  | "analytics"
  | "stock_analyser"
  | "email_digest"
  | "users"
  | "system_health"
  | "how_reconciliation_works";

export interface HelpEntry {
  title: string;
  blurb: string;
  points: string[];
}

export const HELP_BY_ROUTE: Record<string, HelpEntry> = {
  "/uploads": {
    title: "Guard Register Upload",
    blurb:
      "Upload the day's handwritten IN/OUT gate register (PDF). It is read immediately and its rows become the gate-register source for the nightly comparison.",
    points: [
      "Choose the city and drop the scanned register PDF — reading runs within seconds and stores each barcode, ticket, SO number, and direction.",
      "A clean scan matters: write barcodes and tickets one digit per box, and keep INWARD and OUTWARD on their labelled pages.",
      "Each PDF is also mirrored to the city's Google Drive folder for record-keeping.",
      "The nightly run then matches these rows against the ops sheet, the delivery app, and Odoo.",
    ],
  },
  "/stock-analyser": {
    title: "Stock Analyser",
    blurb:
      "Two views — how one day's flagged units changed when the day was checked again, and how much stock each warehouse handled over any stretch of time.",
    points: [
      "Day re-check: pick a business day and see what the first check flagged, what has cleared since, what is still open, and what was flagged later.",
      "It says up front whether both checks read the same four books. If the second check could not read one of them it will find fewer problems for that reason alone, so no change is shown at all.",
      "A day the second check has not reached yet is shown as exactly that — never as a day with nothing left to fix.",
      "Movement volumes: choose any date range to see units in and out per day and per warehouse. Each chart states the date its records start on.",
    ],
  },
  "/leaderboard": {
    title: "City Leaderboard",
    blurb:
      "Ranks the five warehouses by how much of what they move can be traced end to end.",
    points: [
      "The score is units traced end to end divided by units moved, measured as found in each check.",
      "Switch between the latest check, last 7 days, last 30 days, and overall. A day a warehouse was shut is left out, so a closed Thursday can neither help nor hurt its score.",
      "A higher rank means cleaner agreement between the four systems — fewer gaps to chase.",
    ],
  },
  "/users": {
    title: "User Management",
    blurb:
      "Create and manage who can sign in — admins (all cities) and city managers (a single warehouse).",
    points: [
      "Add a user with a role, a city for managers, and a temporary password.",
      "A manager only ever sees and acts on their own city's data (enforced by row-level security).",
      "Deactivate a user to revoke access without losing their history.",
    ],
  },
  "/system-health": {
    title: "System Health",
    blurb:
      "The operational timeline — when registers were uploaded, when each run happened, and when digests were emailed.",
    points: [
      "Confirms the nightly pipeline fired end to end: register reading, comparison, email.",
      "Shows each system's status per run (gate register, ops sheet, delivery app, Odoo) and any warnings.",
      "Use it to spot a missed upload, a system that did not answer, or a digest that did not send.",
    ],
  },
  "/analytics": {
    title: "Analytics",
    blurb: "Trends over time — how much gets traced each day, and how the warehouses compare.",
    points: [
      "Charts of accuracy across the last 7 and 30 days.",
      "Compare cities and spot which warehouses are improving or slipping.",
      "Complements the leaderboard's point-in-time ranking with the longer trend.",
    ],
  },
  "/email-digest": {
    title: "Email Digest",
    blurb:
      "Compose, preview, and send the daily report — the same one that goes out automatically each afternoon.",
    points: [
      "Pick recipients (To / Cc / Bcc) and add an optional note — the list is saved and also drives the automatic daily send.",
      "Send Now, or schedule it 1-3 days later, optionally only once every loss is closed.",
      "Follow-up send: pick a past day, see how many of its losses are closed, add a note, and re-send that day's report rebuilt from the latest data.",
      "Sent emails are kept for 30 days — pick a date and open any one to see exactly what was delivered.",
      "The preview is the exact email that will be delivered.",
    ],
  },
};

export const DASHBOARD_ADMIN: HelpEntry = {
  title: "Reconciliation Dashboard",
  blurb:
    "Every barcode from the latest run, compared across all four systems — the gate register, the ops sheet, the delivery app, and Odoo.",
  points: [
    "The counts show losses to chase — genuine gaps where the systems disagree. Posting-lag and record-keeping entries are kept for audit but hidden from the counts; switch the category filter to see them.",
    "Cities show an OFF badge on their weekly holiday (Thursday for Mumbai, Hyderabad and Pune) — a missing register, ops sheet or app scan that day is expected, not a gap.",
    "Filter by city tab, category, source, priority, status, or date; search any barcode, ticket or SO number.",
    "Approve or reject what city managers submit — the bell shows how many are waiting for you.",
    "Export the current view to CSV.",
  ],
};

export const DASHBOARD_MANAGER: HelpEntry = {
  title: "Your Warehouse Dashboard",
  blurb:
    "Flagged items for your city from the latest run — where the gate register, ops sheet, delivery app and Odoo disagree about a barcode.",
  points: [
    "The counts show losses to investigate. Posting-lag and record-keeping entries are kept for audit but hidden from the counts; switch the category filter to see them.",
    "Resolved one? Submit it for approval with a reason; an admin reviews and closes it.",
    "A rejected item returns as open with the admin's note — fix it and resubmit.",
    "Filter, search, and export your city's items to CSV.",
  ],
};

// Topics the assistant can be asked about that are not a single page.
const EXTRA: Record<string, HelpEntry> = {
  filtering_and_search: {
    title: "Filtering and search",
    blurb: "How to narrow the dashboard down to what you are looking for.",
    points: [
      "The city tabs across the top switch warehouse; admins also have an All view.",
      "The date picker sits at the top right and is remembered while you move around the portal.",
      "Filters: category, source, priority, status, problem type, owner and ops type.",
      "The search box matches a barcode, ticket, SO number, product or customer, and while you are searching it looks across every date rather than just the selected one.",
      "The default view is the chase list: losses that are still open or flagged.",
    ],
  },
  exports: {
    title: "Exports",
    blurb: "Getting the current view out as a spreadsheet.",
    points: [
      "Export downloads every row matching your current filters, not just the page on screen.",
      "The filename records the filters used, so two exports are never confused.",
    ],
  },
  approvals: {
    title: "Approvals",
    blurb: "How a city manager's resolution reaches an admin.",
    points: [
      "A manager submits an item for approval with a reason and an optional note.",
      "It moves to waiting-for-approval and appears in the admin's bell count.",
      "An admin approves it, which closes it, or rejects it with a note, which returns it to the manager as open.",
      "Admins can also act on several at once by selecting rows.",
    ],
  },
  pending_list: {
    title: "Pending list",
    blurb: "Items parked for later rather than finished.",
    points: [
      "Closing an item with the Pending List reason moves it to its own page instead of finishing it.",
      "City managers see only their own city's parked items.",
      "Parked items still count as closed in the headline number, so the resolved tile says how many are parked.",
    ],
  },
  how_reconciliation_works: {
    title: "How the daily check works",
    blurb:
      "Four independent records of the same warehouse movements are compared every day, and only the disagreements are surfaced.",
    points: [
      "The four are the gate register (handwritten, scanned), the ops sheet, the delivery app, and Odoo.",
      "A business day runs 3pm to 3pm, so the day the floor works to is the day being compared.",
      "The run happens at 4pm and the report is emailed at 4:15pm, covering the day that closed an hour earlier.",
      "Only completed movements count. The ops sheet is the only source that says whether a delivery actually finished.",
      "Spares, consumables and packing boxes are counted in bulk rather than tracked unit by unit.",
    ],
  },
};

/** The assistant's view: topic name to content, role-aware for the dashboard. */
export function helpForTopic(topic: string, role: string): HelpEntry | null {
  if (topic === "dashboard") return role === "admin" ? DASHBOARD_ADMIN : DASHBOARD_MANAGER;
  if (EXTRA[topic]) return EXTRA[topic];
  const byRoute = HELP_BY_ROUTE[`/${topic.replace(/_/g, "-")}`];
  return byRoute ?? null;
}

export const HELP_TOPICS: HelpTopic[] = [
  "stock_analyser",
  "dashboard",
  "filtering_and_search",
  "exports",
  "uploads",
  "approvals",
  "pending_list",
  "leaderboard",
  "analytics",
  "email_digest",
  "users",
  "system_health",
  "how_reconciliation_works",
];
