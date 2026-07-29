-- What each email actually SAID, written down at the moment it went on the
-- wire -- plus the two queue changes the D+2 follow-up needs to ride the
-- existing scheduled_emails drain.
--
-- One file, not three, because a half-applied pair leaves the nightly cron
-- inserting rows a CHECK constraint rejects.
--
-- ---------------------------------------------------------------------------
-- WHY A SNAPSHOT AND NOT A RECOMPUTE
--
-- The follow-up says "of the X items flagged on 24 July, Y remain open". X is
-- defined as THE NUMBER THE RECIPIENT IS LOOKING AT IN THEIR INBOX. Nothing in
-- this database can reproduce that two days later, and every alternative looks
-- plausible right up until you check it:
--
--   * run_city_stats is upserted on (business_date, city) -- see 0005's header,
--     which wants exactly that so leaderboard windows never double-count. The
--     re-check pass of D therefore OVERWRITES the very counts D's digest was
--     built from. They are gone, not versioned.
--
--   * buildDigestFromDb filters status != 'closed' and pins to the LATEST run
--     for the date. It returns Y by construction, never X. That is correct for
--     the daily digest and useless here.
--
--   * reconciliation_runs IS insert-per-run and does survive, but finalizeRun
--     writes total / real_count / info_count / high_priority: BUCKET counts,
--     global. The email prints TIER counts per city, and tiers deliberately
--     re-cut buckets (lib/ui/variance-labels.ts). Neither number is the other.
--
--   * lib/email/email-archive.ts keeps {subject, html} only, pruned at 30 days.
--     The figures are in there as prose. Parsing prose back into integers in
--     order to email those integers again is not a thing we are going to do.
--
-- So the figures are written down at send time, by the same code path that
-- rendered them, from the same object.
--
-- Safe to re-run. Additive only; nothing existing changes.

-- ---------------------------------------------------------------------------
-- A) email_logs.totals -- the snapshot
--
-- Document shape (v1), written by digestTotalsSnapshot() and read back through
-- parseTotalsSnapshot(), which returns NULL on any shape it does not recognise
-- rather than letting a half-understood document become a number in an email:
--
--   {
--     "v": 1,
--     "date": "2026-07-24",
--     "sentAt": "2026-07-25T11:15:12Z",   -- the wire moment, not the queue moment
--     "overall": { "movements": 3825, "tier1": 78, "tier2": 305,
--                  "tier3": 612, "open": 995, "flagged": 383 },
--     "cities":  [ { "city": "DELHI", ...same six keys... }, ... ],
--     "keys":    ["DELHI|OUT|CF10231|Ops + Odoo Confirm - Missing from Gate Register", ...],
--     "keysTruncated": false
--   }
--
-- `flagged` = tier1 + tier2 is STORED, not derived, so the follow-up can never
-- define X differently from the sender that produced it.
--
-- `keys` carries the natural key of every flagged row so the comparison can
-- match on the UNIT (city|direction|barcode), not on counts.
-- resolveStaleOpenVariances DELETEs a superseded row and its replacement
-- carries a fresh identity -- a count-only or row-key comparison would report a
-- still-broken unit as a NEW one, an error in the flattering direction.
-- Capped at 3000 keys (~165 KB, comfortably TOASTed; a busy day measures ~400);
-- past that keysTruncated is set and the follow-up omits its "newly flagged"
-- line rather than printing a number it cannot stand behind.
--
-- NULL is a real value and means "this send carried no figures": a pre-0016
-- send, or one whose build failed. Consumers MUST skip such a date. They must
-- never substitute a recomputed number -- see the note at the foot.

ALTER TABLE public.email_logs
  ADD COLUMN IF NOT EXISTS totals JSONB;

COMMENT ON COLUMN public.email_logs.totals IS
  'The figures this email actually printed, captured at send time (schema v1, migration 0016). NULL = a pre-0016 send or a send with no figures; consumers must skip, never substitute a recomputed number. Contains barcodes: email_logs is admin-only under RLS and pruned at 30 days by the digest cron.';

-- ---------------------------------------------------------------------------
-- B) kind widening
--
-- 'follow_up', snake_case like every other identifier in this schema
-- (business_date, require_resolved, email_log_id). Never rendered, so the
-- banned-vocabulary rule does not reach it.

ALTER TABLE public.email_logs DROP CONSTRAINT IF EXISTS email_logs_kind_check;
ALTER TABLE public.email_logs
  ADD CONSTRAINT email_logs_kind_check
  CHECK (kind IN ('digest', 'test', 'scheduled', 'follow_up'));

ALTER TABLE public.scheduled_emails DROP CONSTRAINT IF EXISTS scheduled_emails_kind_check;
ALTER TABLE public.scheduled_emails
  ADD CONSTRAINT scheduled_emails_kind_check
  CHECK (kind IN ('digest', 'follow_up'));

-- ---------------------------------------------------------------------------
-- C) which email this one follows up on
--
-- Pinned at enqueue time, NOT looked up at drain time. An admin can re-send a
-- day (/api/email/test, or the cron's ?date=), and the follow-up must quote the
-- figures of the send it was queued against rather than whichever send happens
-- to be newest three days later.
--
-- ON DELETE SET NULL, matching email_log_id: the 30-day email_logs prune must
-- not take queue rows with it. A follow-up whose source has been pruned finds a
-- null snapshot and skips, which is the correct outcome.

ALTER TABLE public.scheduled_emails
  ADD COLUMN IF NOT EXISTS source_email_log_id UUID
    REFERENCES public.email_logs(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.scheduled_emails.source_email_log_id IS
  'For kind=follow_up: the email_logs row whose totals snapshot supplies X. NULL on kind=digest.';

-- One live follow-up per business date. Without this a manual re-send of D's
-- digest queues a SECOND follow-up and the owner receives the same email twice.
-- Partial on the live statuses so a canceled or failed row does not block a
-- deliberate re-queue.
CREATE UNIQUE INDEX IF NOT EXISTS uq_followup_per_date
  ON public.scheduled_emails (business_date)
  WHERE kind = 'follow_up' AND status IN ('pending', 'sending', 'sent');

-- ---------------------------------------------------------------------------
-- DATES WHOSE DIGEST WENT OUT BEFORE THIS MIGRATION: no fallback, deliberately.
--
-- reconciliation_runs.by_variance is the only surviving per-date breakdown, and
-- deriving tiers from it means calling labelFor(name) with no direction, no
-- job_type and no bucket. Direction alone moves GATE_ONLY, SHEET_ONLY and
-- GATE_OPS_NO_DT_ODOO between tier 1 and tier 2, and a null bucket disables the
-- CLEARED_ON_RECHECK override entirely. The result is a plausible, global,
-- WRONG number -- which is strictly worse than no number, because the recipient
-- can compare it against the email still sitting in their inbox.
--
-- Nothing enqueues a follow-up for a past date anyway: the enqueue happens at
-- digest-send time, so the feature simply starts working the day it ships.
