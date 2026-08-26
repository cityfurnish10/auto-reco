-- 0034_gate_radius_200.sql
--
-- Tighten every gate to 200m, and make it possible to tell an unconfirmed pin
-- from a confirmed one.
--
-- WHY 200 RATHER THAN 400. One physical warehouse per city serves the whole
-- region, so "at the gate" is a small place — 400m was a guess made before
-- anyone had stood at one, and a circle that wide covers a road, a neighbouring
-- yard and most of a village. At 200m the check means something.
--
-- WHAT THIS DOES NOT DO: refuse anybody. A guard outside the circle still
-- checks in and still records movements; the gate is flagged for review
-- instead. A phone's GPS inside a metal warehouse is genuinely unreliable, and
-- a guard turned away because their fix drifted stops using the app — which
-- leaves no record at all, and no record is worse than one carrying a question
-- mark. The circle is evidence, not a lock.
--
-- Safe to re-run.

-- ---------------------------------------------------------------------------
-- 1. Is this pin trustworthy?
-- ---------------------------------------------------------------------------
-- EVERY COORDINATE IN THIS TABLE WAS DECODED FROM A GOOGLE PLUS CODE. Nobody
-- has stood at a gate and captured one. That was tolerable while the radius was
-- 400m and nothing depended on it; at 200m, with a review queue reading it, an
-- unverified pin will generate a queue of false alarms about honest guards.
--
-- The column exists so the difference is visible rather than assumed. A pin
-- confirmed on site should record WHO confirmed it and how accurate the fix
-- was, and until then `located_by` stays null and the flags it produces should
-- be read as "the pin might be wrong" rather than "the guard was elsewhere".
COMMENT ON COLUMN gate_sites.located_by IS
  'NULL means the coordinate came from a Plus Code and nobody has confirmed it on site. Read its geofence flags with that in mind.';

-- ---------------------------------------------------------------------------
-- 2. The radius.
-- ---------------------------------------------------------------------------
-- Only the sites still sitting on the old default. A gate someone has since
-- tuned deliberately is left alone.
UPDATE gate_sites
   SET radius_m = 200, updated_at = now()
 WHERE radius_m = 400;

-- ---------------------------------------------------------------------------
-- 3. Reading the flags.
-- ---------------------------------------------------------------------------
-- The review queue's location section. A row here is a check-in whose fix fell
-- outside the gate — which is a question, not a verdict, and the view carries
-- the two facts needed to tell those apart: how far outside, and whether the
-- pin it was measured against has ever been confirmed.
CREATE OR REPLACE VIEW gate_location_flags AS
  SELECT
    s.id            AS shift_id,
    s.guard_id,
    u.name          AS guard_name,
    s.city,
    s.business_date,
    s.checked_in_at,
    s.in_lat, s.in_lng,
    site.lat        AS gate_lat,
    site.lng        AS gate_lng,
    site.radius_m,
    -- Haversine, in metres. Repeated here rather than shared with the
    -- TypeScript because a view that cannot answer on its own is a view
    -- somebody has to join an application to.
    round((
      6371000 * acos(
        least(1, greatest(-1,
          cos(radians(site.lat)) * cos(radians(s.in_lat)) *
          cos(radians(s.in_lng) - radians(site.lng)) +
          sin(radians(site.lat)) * sin(radians(s.in_lat))
        ))
      )
    )::numeric) AS metres_from_gate,
    -- The caveat travels WITH the row, so nobody reads a flag as damning
    -- without knowing the pin behind it was never checked.
    (site.located_by IS NULL) AS pin_unconfirmed
  FROM guard_shifts s
  JOIN app_users  u    ON u.id = s.guard_id
  JOIN gate_sites site ON site.city = s.city
  WHERE s.in_geo_ok IS FALSE
    AND s.in_lat IS NOT NULL
    AND s.in_lng IS NOT NULL;

COMMENT ON VIEW gate_location_flags IS
  'Check-ins whose GPS fell outside the gate. A question rather than a verdict — read metres_from_gate alongside pin_unconfirmed.';
