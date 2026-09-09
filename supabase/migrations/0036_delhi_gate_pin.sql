-- 0036_delhi_gate_pin.sql
--
-- Delhi's gate, pinned from a coordinate captured ON SITE.
--
-- WHAT WAS WRONG. 0026 seeded every site from a SHORT Plus Code — Delhi's was
-- "C5QH+G8 New Delhi", six digits, whose cell is roughly 275m across. A pin
-- derived from it can sit anywhere in that cell, and Delhi's sat 342m from the
-- warehouse. 0034 then tightened every radius to 200m, which is the right
-- number for a gate and made a 342m error permanently unsatisfiable: no scan
-- taken at the warehouse could ever have passed.
--
-- WHERE THE NEW ONE COMES FROM. A geo-stamped photograph taken in the Delhi
-- yard on 8 Sept 2026 at 09:31 IST, carrying the ten-digit Plus Code
-- 7JWVC5QG+X2. Ten digits is a ~14m cell — twenty times finer than the code
-- 0026 used — and it decodes to 28.439937, 77.175063. The map inset on the
-- photograph reads "Dera Mandi", matching the site address already stored, so
-- this is the same place measured properly rather than a different place.
--
-- WHAT THIS DOES NOT CLAIM. The photograph was taken in the yard beside a
-- container, not standing in the gateway. At a 200m radius that distinction
-- does not matter; if the radius is ever tightened further it will, and the
-- honest next step is then a capture from the gateway itself.
--
-- located_by RECORDS AN ATTESTATION, NOT A GPS TRACE. 0034 defines a null
-- located_by as "nobody has confirmed this on site". An admin supplied this
-- photograph and stands behind it, so the column names that admin. accuracy_m
-- is the Plus Code cell size, not a device's reported accuracy — the coordinate
-- came from an image overlay, and recording 14m here would overstate a fix
-- nobody's phone actually reported through the app.
--
-- THE OTHER FOUR CITIES ARE STILL ON SHORT PLUS CODES and remain unconfirmed.
-- Mumbai, Pune, Bangalore and Hyderabad each need the same photograph.
--
-- Safe to re-run.

UPDATE gate_sites
   SET lat        = 28.439937,
       lng        = 77.175063,
       plus_code  = '7JWVC5QG+X2',
       located_by = '23e67da9-c15a-40bd-854e-80e52e2e3045',
       located_at = TIMESTAMPTZ '2026-09-08 09:31:04+05:30',
       accuracy_m = 14,
       updated_at = now()
 WHERE city = 'DELHI';

-- A pin this file did not touch is still a guess. Kept as a query rather than a
-- constraint: an unconfirmed pin must never block a guard from recording a
-- movement, it only means the geofence flag on that city cannot be read as a
-- verdict.
COMMENT ON COLUMN gate_sites.plus_code IS
  'Source of the coordinate. A SHORT code (e.g. "C5QH+G8 New Delhi") is a ~275m '
  'cell and was only ever a placeholder; a ten-digit code (e.g. "7JWVC5QG+X2") '
  'is ~14m and came from a capture on site. Read alongside located_by.';
