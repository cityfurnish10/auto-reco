// Recipient-list state for the email compose panel — pure functions so the
// add / remove / slot-toggle behavior is unit-testable without a DOM harness
// (the project has no react-testing setup; the component stays a thin shell).
//
// The visible list ("candidates") is defaults (DIGEST_RECIPIENTS) + active
// roster users + manually added extras, MINUS anything the admin removed.
// Removal is list-membership: a removed address also loses its To/Cc/Bcc slot
// so it can never leak into a send; re-adding it via the input restores it.

export type Slot = "to" | "cc" | "bcc";

export interface RecipientState {
  // email → chosen slot (null = listed but not included in the send)
  slots: Record<string, Slot | null>;
  // addresses typed in manually (not in defaults/roster)
  extra: string[];
  // addresses removed from the list (hides defaults/roster; extras are
  // deleted outright but recorded here too so a stale slot can't linger)
  removed: string[];
}

export const EMPTY_RECIPIENTS: RecipientState = { slots: {}, extra: [], removed: [] };

export const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// Default recipients arrive async (from /api/email/preview) — put each into
// "to" once, without clobbering a slot the admin already changed or a removal
// they already made.
export function seedDefaults(state: RecipientState, defaults: string[]): RecipientState {
  const slots = { ...state.slots };
  for (const e of defaults) {
    if (!(e in slots) && !state.removed.includes(e)) slots[e] = "to";
  }
  return { ...state, slots };
}

// The list as rendered: defaults + roster + extras, deduped, minus removed.
export function candidatesOf(
  state: RecipientState,
  defaults: string[],
  rosterEmails: string[]
): string[] {
  const set = new Set<string>();
  defaults.forEach((e) => set.add(e));
  rosterEmails.forEach((e) => set.add(e));
  state.extra.forEach((e) => set.add(e));
  state.removed.forEach((e) => set.delete(e));
  return [...set];
}

// Add a typed address: validate, undo any earlier removal, default slot "to".
// Returns an error message instead of a new state when the address is invalid.
export function addRecipient(
  state: RecipientState,
  raw: string
): { state: RecipientState; error?: string } {
  const e = raw.trim();
  if (!e || !EMAIL_RE.test(e)) return { state, error: "Enter a valid email address." };
  return {
    state: {
      slots: { ...state.slots, [e]: state.slots[e] ?? "to" },
      extra: state.extra.includes(e) ? state.extra : [...state.extra, e],
      removed: state.removed.filter((r) => r !== e),
    },
  };
}

// Remove an address from the list entirely (defaults/roster get hidden,
// extras get deleted) and clear its slot so it cannot be sent to.
export function removeRecipient(state: RecipientState, email: string): RecipientState {
  const slots = { ...state.slots };
  delete slots[email];
  return {
    slots,
    extra: state.extra.filter((e) => e !== email),
    removed: state.removed.includes(email) ? state.removed : [...state.removed, email],
  };
}

// Toggle an address's slot: clicking its current slot clears it (listed but
// not included), clicking another moves it.
export function toggleSlot(state: RecipientState, email: string, slot: Slot): RecipientState {
  return {
    ...state,
    slots: { ...state.slots, [email]: state.slots[email] === slot ? null : slot },
  };
}

// The To / Cc / Bcc lists a send/schedule actually uses.
export function listsOf(state: RecipientState): { to: string[]; cc: string[]; bcc: string[] } {
  const pick = (s: Slot) =>
    Object.entries(state.slots)
      .filter(([, v]) => v === s)
      .map(([e]) => e);
  return { to: pick("to"), cc: pick("cc"), bcc: pick("bcc") };
}

// Coerce an untrusted payload (API body / stored JSON) into a valid
// RecipientState: only well-formed email keys, only known slot values,
// dedup, and hard caps so a bad write can never balloon the stored config.
export function sanitizeRecipientState(raw: unknown): RecipientState {
  const out: RecipientState = { slots: {}, extra: [], removed: [] };
  if (!raw || typeof raw !== "object") return out;
  const r = raw as Partial<Record<keyof RecipientState, unknown>>;

  const MAX = 200;
  if (r.slots && typeof r.slots === "object") {
    for (const [email, slot] of Object.entries(r.slots as Record<string, unknown>)) {
      const e = email.trim();
      if (!EMAIL_RE.test(e) || Object.keys(out.slots).length >= MAX) continue;
      out.slots[e] = slot === "to" || slot === "cc" || slot === "bcc" ? slot : null;
    }
  }
  const cleanList = (v: unknown): string[] =>
    Array.isArray(v)
      ? [...new Set(v.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter((x) => EMAIL_RE.test(x)))].slice(0, MAX)
      : [];
  out.extra = cleanList(r.extra);
  out.removed = cleanList(r.removed);
  return out;
}
