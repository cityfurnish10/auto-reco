-- 0026_gate_sites.sql
--
-- Where each gate physically is, in the database rather than in code.
--
-- WHY NOT A CONSTANT. The coordinates were hardcoded placeholders, so every
-- scan recorded geo_ok = false -- the location check said nobody was ever at
-- the gate. Fixing that in code means a deploy for a number that only somebody
-- standing at the warehouse can actually supply.
--
-- WHERE THE COORDINATES CAME FROM. Not from geocoding the postal address --
-- searching "Dera Mandi" returns the centre of the village, over a kilometre
-- from the building, and a geofence built on that looks correct while
-- rejecting every honest scan. These are decoded from the Google Maps PLUS
-- CODE for each warehouse, which names an ~14m square rather than a locality.
-- The plus code is kept beside each row so the number can be re-derived and
-- checked rather than taken on trust.
--
-- They are still a starting point. A manager standing at the gate can re-pin
-- from their own position (Gate -> Gates -> Set from here), which is the only
-- source better than this.
--
-- A site with NULL coordinates has its check SKIPPED, not failed -- geo_ok
-- records as unknown, so nothing is wrongly rejected.
--
-- Safe to re-run.

CREATE TABLE IF NOT EXISTS gate_sites (
  city          TEXT PRIMARY KEY
                CHECK (city IN ('DELHI','MUMBAI','PUNE','HYDERABAD','BANGALORE')),
  site_code     TEXT NOT NULL,
  label         TEXT NOT NULL,
  -- The postal address, for a human to recognise. Never used for matching.
  address       TEXT,
  -- The regions this one warehouse serves. NCR is a single gate covering five
  -- cities, which is why the reconciliation has one DELHI bucket.
  serves        TEXT,
  -- The Google Maps plus code these coordinates were decoded from, so the
  -- numbers below can be verified instead of believed.
  plus_code     TEXT,
  lat           DOUBLE PRECISION,
  lng           DOUBLE PRECISION,
  -- Generous by default. A phone against a metal shutter drifts badly, and a
  -- false "outside the gate" teaches the guard the check is noise -- far more
  -- damaging than a boundary that is slightly loose.
  radius_m      INT NOT NULL DEFAULT 400 CHECK (radius_m BETWEEN 50 AND 5000),
  -- Who pinned it and when, so a wrong position can be traced and re-taken.
  located_by    UUID REFERENCES app_users(id),
  located_at    TIMESTAMPTZ,
  accuracy_m    REAL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT gate_sites_coords_together CHECK (
    (lat IS NULL) = (lng IS NULL)
  )
);

INSERT INTO gate_sites (city, site_code, label, address, serves, plus_code, lat, lng) VALUES
  ('DELHI', 'GUR', 'Delhi NCR',
   'Shyam Farms, Dera Village, Dera Mandi, New Delhi, Delhi 110074',
   'Delhi, Gurgaon, Noida, Ghaziabad, Faridabad',
   'C5QH+G8 New Delhi',        28.438812, 77.178313),

  ('MUMBAI', 'MUM', 'Mumbai',
   'Building no A14, Unit no 17 to 20, Bhumi World Industrial Park, Pimplas Village, Off NH3, Mumbai-Nashik Highway, Bhiwandi 421302',
   'Mumbai, Navi Mumbai, Thane',
   '739G+2R Bhiwandi',         19.267562, 73.077062),

  ('PUNE', 'PUN', 'Pune',
   'GT No 37/3, behind Tejas Transport, Omkar Colony, Mantarwadi, Uruli Devachi, Pune, Maharashtra 411028',
   'Pune',
   'FWPQ+VH Pune',             18.487187, 73.938937),

  ('BANGALORE', 'BAN', 'Bangalore',
   'Sy No.12 Adur Munegowda Building, Bidhrahalli Hobli, Virgonagar Post, Bangalore 560049',
   'Bangalore, Hosur, Chennai',
   '3P45+982 Aduru, Bengaluru', 13.055888, 77.708266),

  ('HYDERABAD', 'HYD', 'Hyderabad',
   '172/UU & EE, IDA Bolaram, Jinnaram Mandal, Sangareddy, Hyderabad, Telangana 502325',
   'Hyderabad',
   'H84X+5C Hyderabad',        17.555437, 78.348562)

ON CONFLICT (city) DO UPDATE
  SET address   = EXCLUDED.address,
      serves    = EXCLUDED.serves,
      label     = EXCLUDED.label,
      plus_code = EXCLUDED.plus_code,
      -- Only fill coordinates that are still missing. A gate somebody has
      -- already pinned from the spot is better than a decoded plus code, and
      -- re-running this migration must not undo their work.
      lat       = COALESCE(gate_sites.lat, EXCLUDED.lat),
      lng       = COALESCE(gate_sites.lng, EXCLUDED.lng);

COMMENT ON TABLE gate_sites IS
  'One warehouse gate per city. Coordinates are captured on site, not geocoded from the address.';

ALTER TABLE gate_sites ENABLE ROW LEVEL SECURITY;

-- Everyone signed in may read: the guard app needs the geofence, and a manager
-- needs to see the address.
DROP POLICY IF EXISTS gate_sites_select ON gate_sites;
CREATE POLICY gate_sites_select ON gate_sites FOR SELECT USING (true);

-- Only a supervisor may move a gate, and a manager only their own.
DROP POLICY IF EXISTS gate_sites_update ON gate_sites;
CREATE POLICY gate_sites_update ON gate_sites
  FOR UPDATE USING (
    public.auth_is_admin()
    OR (public.auth_role() = 'manager' AND city = public.auth_city())
  );
