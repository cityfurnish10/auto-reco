-- 0041_outward_manual_counted_kinds.sql
--
-- The outward-scan rule was refusing items that have nothing to scan.
--
-- WHAT WAS HAPPENING. Every manual entry added to an OUTWARD trip has been
-- refused by the database since the gate app shipped. Measured 11 Sep 2026:
-- one manual entry stored in all of history (an inward one, 24 Aug); two
-- refused today at Delhi, 12:45 and 12:59 IST, both carrying a photo, one a
-- spare part and one a consumable. Neither reached gate_scans. Zero manual
-- outward rows have ever been stored.
--
-- The guard's phone showed both items in the trip and let the trip close with
-- them counted, so trip 08a58331 says one item went out against an empty
-- register, and 8104bd03 says two against one. The count and the item list
-- disagree on the manager's screen, and the guard was never told.
--
-- WHY THE RULE COULD NOT BE SATISFIED. 0023 requires an outward non-scan to
-- carry exception_reason AND photo_path. The app sends the photo and has never
-- sent a reason — nothing in it sets exceptionReason, and its free-text
-- "Comments" field travels as notes. So the escape hatch existed in the
-- database with no door in the app.
--
-- WHY THE RULE IS NARROWED RATHER THAN THE APP TAUGHT TO ASK. 0023's reason is
-- written for a barcoded unit whose sticker was destroyed: "outward MUST be
-- scanned", with a deliberately expensive way out. The four kinds the app
-- offers on an outward trip — spare_part, consumable, pp_box, sample — are the
-- COUNTED family. No serial exists or is expected; the quantity is the whole
-- record. There is no sticker, there never was one, and asking a guard why
-- they did not scan a box of screws collects the same answer every time. A
-- reason everyone gives is not a control, it is a keystroke — and 0023 itself
-- argues that training people to wave past a prompt costs more than the prompt
-- is worth.
--
-- So the rule now applies to what could have been scanned. An identified item
-- leaving by hand (a unit, a tagged vendor return) still needs a stated reason
-- and a photo, exactly as before. A counted item still needs its photo, via
-- gate_scans_manual_needs_photo, which is untouched — an outward manual entry
-- is never evidence-free either way.
--
-- Nothing is loosened for the rows the rule was written about, and nothing
-- stored under the old rule changes: no manual outward row exists to revisit.
--
-- Safe to re-run.

ALTER TABLE gate_scans
  DROP CONSTRAINT IF EXISTS gate_scans_outward_scan_required;

ALTER TABLE gate_scans
  ADD CONSTRAINT gate_scans_outward_scan_required CHECK (
    direction <> 'OUT'
    OR entry_method = 'scan'
    -- Nothing to scan: no serial exists or is expected for these kinds, so the
    -- photo (enforced separately) is the whole of the evidence.
    OR item_kind IN ('spare_part','consumable','pp_box','sample')
    -- Something that COULD have been scanned, leaving by hand: unchanged.
    OR (exception_reason IS NOT NULL AND photo_path IS NOT NULL)
  );

COMMENT ON CONSTRAINT gate_scans_outward_scan_required ON gate_scans IS
  'Outward must be scanned. An identified item leaving by hand needs a stated '
  'reason and a photo; a counted kind has no sticker to scan and needs only '
  'the photo (gate_scans_manual_needs_photo). Narrowed in 0041 — the original '
  'rule refused every manual outward entry the app could produce.';
