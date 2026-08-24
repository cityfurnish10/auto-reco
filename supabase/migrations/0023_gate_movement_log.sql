-- 0023_gate_movement_log.sql
--
-- The digital gate register. Replaces the handwritten book that the PHYSICAL
-- source has been read from until now. See the PRD for the full rationale; the
-- short version is that the gate record fails in two ways at once -- it is the
-- MISSING book for 79% of units, and of the lines that do get written OCR
-- recovered only 483 of 738 on 31 Jul 2026.
--
-- The item sticker carries a QR code holding the plain serial (verified
-- 2026-08-21 on a live sticker: "FUL5ZA24120009", decoded identically by native
-- Android and iOS cameras). A QR decode is checksummed: it returns the exact
-- string or it fails. It never returns a wrong one. A scanned row here is not
-- "better OCR" -- it is a different kind of record, and none of the ocr-noise.ts
-- repair layer applies to it.
--
-- NOTHING EXISTING CHANGES. Every table below is new. The reconcile pipeline
-- keeps reading guard_uploads until lib/connectors/guard.ts is pointed here,
-- which is one switch and is deliberately NOT part of this migration.
--
-- Safe to re-run.

-- ---------------------------------------------------------------------------
-- 0. Guards are platform users.
-- ---------------------------------------------------------------------------
-- Reuses app_users rather than a parallel identity table, so RLS, auth_city()
-- and user management all keep working. A guard is a city-scoped user with no
-- dashboard access (enforced in middleware, not here).
--
-- Dropped by LOOKUP, not by guessed name. A column-level CHECK is normally
-- auto-named app_users_role_check but that is not guaranteed, and a DROP ... IF
-- EXISTS matching nothing would leave the OLD constraint in place beside the
-- new one -- 'guard' would still be rejected and the migration would look like
-- it had worked. 0006 had to do the same lookup for the city constraints.
DO $$
DECLARE c text;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'public.app_users'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) ILIKE '%manager%'
  LOOP
    EXECUTE format('ALTER TABLE public.app_users DROP CONSTRAINT %I', c);
  END LOOP;
END $$;

ALTER TABLE public.app_users ADD CONSTRAINT app_users_role_check
  CHECK (role IN ('admin', 'manager', 'viewer', 'guard'));

-- Which role the caller holds. Same SECURITY DEFINER shape as auth_is_admin()
-- and auth_city() (0004), for the same reason: reading app_users from inside an
-- app_users policy recurses.
CREATE OR REPLACE FUNCTION public.auth_role()
  RETURNS text LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS
$$ SELECT role FROM public.app_users WHERE auth_id = auth.uid() LIMIT 1 $$;

GRANT EXECUTE ON FUNCTION public.auth_role() TO authenticated, anon;

-- ---------------------------------------------------------------------------
-- 1. gate_devices — the phone, as a TERMINAL rather than a person.
-- ---------------------------------------------------------------------------
-- A device belongs to a GATE, not to a guard. That distinction is the whole
-- point of splitting this from guard_profiles below: three guards work one
-- gate, cover for each other, and hand a phone over when one dies mid-shift.
-- Binding identity to the hardware would file all of that work under whoever
-- the phone was issued to — which is precisely the per-guard attendance and
-- task log this system exists to produce.
--
-- The token authenticates the DEVICE: which gate is this, and is it still
-- allowed to talk to us. Who is holding it is a separate question, answered by
-- guard_profiles and settled by the check-in face match.
CREATE TABLE IF NOT EXISTS gate_devices (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  city            TEXT NOT NULL
                  CHECK (city IN ('DELHI','MUMBAI','PUNE','HYDERABAD','BANGALORE')),
  site_code       TEXT NOT NULL,
  device_id       TEXT NOT NULL UNIQUE,
  device_label    TEXT,
  -- Long-lived on purpose: a token that expires mid-shift locks a gate out at
  -- night with nobody to call. Stored HASHED — a leaked dump must not hand
  -- anyone a working gate credential. Revocation is one row.
  token_hash      TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','revoked')),
  revoked_at      TIMESTAMPTZ,
  last_seen_at    TIMESTAMPTZ,
  created_by      UUID REFERENCES app_users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT gate_devices_revoked_has_time CHECK (
    status <> 'revoked' OR revoked_at IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS idx_gdev_token ON gate_devices (token_hash) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_gdev_city  ON gate_devices (city, status);

COMMENT ON TABLE gate_devices IS
  'A phone enrolled at a gate. Authenticates the terminal, not the person — see guard_profiles.';

-- ---------------------------------------------------------------------------
-- 2. guard_profiles — the person.
-- ---------------------------------------------------------------------------
-- One per guard, holding their own PIN and their own reference photo. A guard
-- signs in by name on ANY active device in their city, so cover and handover
-- are ordinary rather than exceptional, and every scan, trip and shift is
-- attributed to the individual who was actually holding the phone.
--
-- The PIN is a LOCAL UNLOCK, not the identity control: it stops a passer-by
-- picking up an unattended phone. Signing in as a colleague is caught by the
-- check-in selfie failing to match THIS profile's reference photo — which is
-- why the photo lives here, beside the person, and not on the device.
CREATE TABLE IF NOT EXISTS guard_profiles (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guard_id        UUID NOT NULL UNIQUE REFERENCES app_users(id) ON DELETE CASCADE,
  city            TEXT NOT NULL
                  CHECK (city IN ('DELHI','MUMBAI','PUNE','HYDERABAD','BANGALORE')),
  -- Salted and iterated: short and human-chosen, unlike the device token.
  pin_hash        TEXT NOT NULL,
  -- Cached on the phone at sign-in so the match runs ON DEVICE and no face
  -- image is ever uploaded for comparison.
  reference_photo TEXT,
  -- Biometric data under India's DPDP Act, so consent is recorded rather than
  -- assumed. Withdrawing it deactivates the profile.
  consent_at      TIMESTAMPTZ,
  employee_code   TEXT,
  phone           TEXT,
  status          TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','inactive')),
  created_by      UUID REFERENCES app_users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_gp_city ON guard_profiles (city, status);

COMMENT ON TABLE guard_profiles IS
  'Per-guard sign-in and reference photo. A guard may sign in on any active device in their city.';

-- ---------------------------------------------------------------------------
-- 2. gate_trips — one truck, one direction, many items.
-- ---------------------------------------------------------------------------
-- The vehicle number is asked ONCE per truck rather than once per item. On a
-- 47-item load that is the difference between typing a registration once and 47
-- times, and it is where the turnaround saving actually comes from. It is also
-- the natural unit for a dispute weeks later: "what went out on that truck?"
CREATE TABLE IF NOT EXISTS gate_trips (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Device-generated, so a trip opened offline keeps one identity through sync.
  client_trip_id  TEXT NOT NULL UNIQUE,
  city            TEXT NOT NULL
                  CHECK (city IN ('DELHI','MUMBAI','PUNE','HYDERABAD','BANGALORE')),
  -- The physical gate. NCR runs ONE warehouse today (Gurugram) serving Gurgaon,
  -- Noida, Faridabad, Ghaziabad and Delhi -- but Odoo already carries separate
  -- codes GUR/GGN/NOI that all fold into the DELHI bucket. Recorded from day one
  -- because added later, every earlier row is ambiguous forever.
  site_code       TEXT NOT NULL,   -- no default: a wrong one would silently stamp
                                  -- every other city with the Delhi code
  direction       TEXT NOT NULL CHECK (direction IN ('IN','OUT')),

  -- EVERY MOVEMENT TRAVELS ON A VEHICLE. Confirmed with operations: customers
  -- never collect from the warehouse in person and there are no hand or
  -- two-wheeler deliveries. So the registration is NOT NULL, and that is a
  -- control rather than a formality -- a movement with no vehicle becomes
  -- impossible to record, instead of being recordable with a blank field.
  vehicle_no      TEXT NOT NULL,
  driver_name     TEXT,
  -- Transporter, driver phone, or gate-pass reference.
  carrier_ref     TEXT,

  opened_at       TIMESTAMPTZ NOT NULL,
  closed_at       TIMESTAMPTZ,
  -- DERIVED SERVER-SIDE from opened_at, never sent by the phone. The business
  -- day runs 15:00->15:00 IST, so the calendar date is wrong for a third of the
  -- day, and a personal phone's clock and timezone are not trustworthy inputs to
  -- a reconciliation key. Stored rather than generated because the IST
  -- conversion is not IMMUTABLE; because scanned_at/opened_at are kept, a change
  -- to the day boundary is a single recompute, not lost data.
  business_date   DATE NOT NULL,

  guard_id        UUID REFERENCES app_users(id),
  device_id       TEXT,

  status          TEXT NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open','closed','abandoned')),
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT gate_trips_closed_has_time CHECK (
    status <> 'closed' OR closed_at IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS idx_gt_city_date ON gate_trips (city, business_date, direction);
-- ONE OPEN TRIP PER GUARD, enforced rather than merely intended. A second open
-- trip is how an item ends up recorded against the wrong vehicle, which is
-- close to impossible to unpick afterwards -- the truck has gone and both
-- records look equally plausible. A UNIQUE partial index makes the bad state
-- unrepresentable instead of relying on the phone to prevent it.
CREATE UNIQUE INDEX IF NOT EXISTS uq_gt_one_open_per_guard
  ON gate_trips (guard_id) WHERE status = 'open';

COMMENT ON TABLE gate_trips IS
  'One vehicle movement at the gate. Groups the scans that travelled together; vehicle captured once per trip.';

-- ---------------------------------------------------------------------------
-- 3. gate_scans — one row per item.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS gate_scans (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- THE IDEMPOTENCY KEY, and the most load-bearing column here. The device
  -- generates it once per physical event and replays it on every sync attempt.
  -- Retry after a half-delivered upload is the NORMAL case, not the exotic one,
  -- and without this each retry books the same unit again -- inventing stock
  -- that left the building, which is worse than missing a movement.
  client_scan_id    TEXT NOT NULL UNIQUE,

  trip_id           UUID REFERENCES gate_trips(id) ON DELETE SET NULL,
  -- Denormalised from the trip so the reconcile connector's read never needs a
  -- join, and so a scan orphaned by a deleted trip still reconciles.
  city              TEXT NOT NULL
                    CHECK (city IN ('DELHI','MUMBAI','PUNE','HYDERABAD','BANGALORE')),
  site_code         TEXT NOT NULL,
  direction         TEXT NOT NULL CHECK (direction IN ('IN','OUT')),
  business_date     DATE NOT NULL,

  -- THE QR PAYLOAD VERBATIM. Never folded. The canonical fold (I->1 O->0 S->5
  -- Z->2 G->6) exists only to forgive handwriting, and it is why 57.1% of units
  -- display a barcode matching nothing in any system -- the sample sticker above
  -- is stored today as "FUL52A24120009", so pasting it into Odoo returns "no
  -- product move". Canonicalization still happens downstream for MATCHING; it
  -- must not happen at capture.
  barcode           TEXT,
  barcode_source    TEXT NOT NULL DEFAULT 'qr'
                    CHECK (barcode_source IN ('qr','manual','pending')),
  -- Vendor goods are serialised AFTER receipt -- the floor logs the truck, not
  -- each serial -- so at the gate there is often no sticker to scan.
  serial_no         TEXT,

  -- WHAT KIND OF THING CROSSED THE GATE. Two families, and the difference
  -- decides almost everything downstream:
  --
  --   IDENTIFIED  a specific unit, tracked by serial. Always quantity 1.
  --     unit              a tagged CityFurnish unit -- scanned, never typed
  --     vendor_goods      new supplier stock, INWARD only. Serialised AFTER
  --                       receipt, so there is usually no sticker at the gate
  --     customer_return   a CityFurnish unit back from a pickup, INWARD only.
  --                       Should have its sticker; when it does not, that is an
  --                       anomaly rather than routine -- see the alert below
  --
  --   COUNTED     no serial exists and none is expected. A quantity is the
  --               whole record. The engine already treats these as count-only
  --               and never raises variances for them.
  --     spare_part · consumable · pp_box · sample
  --
  -- 'ppe' is folded into consumable: it was never a distinct thing downstream
  -- and a category list a guard has to read at a gate should be as short as it
  -- can honestly be.
  item_kind         TEXT NOT NULL DEFAULT 'unit'
                    CHECK (item_kind IN (
                      'unit','vendor_goods','customer_return',
                      'spare_part','consumable','pp_box','sample','other')),
  quantity          INT NOT NULL DEFAULT 1 CHECK (quantity > 0),
  entry_method      TEXT NOT NULL CHECK (entry_method IN ('scan','manual')),

  -- Auto-filled from the matched Odoo picking, so the guard confirms rather than
  -- types. Kept on the row because the picking may be gone by dispute time.
  product           TEXT,
  so_number         TEXT,
  ticket_id         TEXT,
  customer          TEXT,

  -- Mandatory for every manual entry (nothing else in the row is evidence) and
  -- every override. NOT mandatory for a clean outward scan: at ~740 units/day a
  -- forced photo adds ~5 min per truck and works against the whole point, while
  -- proving little -- one chest of drawers photographs like any other, and the
  -- QR read off the item is stronger identity evidence than the picture.
  photo_path        TEXT,
  -- TRUE when this row was drawn for the random outward spot-check. The guard
  -- cannot predict which, so the deterrent survives at a fraction of the cost.
  photo_sampled     BOOLEAN NOT NULL DEFAULT FALSE,

  lat               DOUBLE PRECISION,
  lng               DOUBLE PRECISION,
  accuracy_m        REAL,
  -- Whether the fix fell inside the gate geofence, decided server-side. NULL
  -- means location was unavailable, which is NOT a failure -- a phone indoors
  -- against a metal shutter often cannot get a fix, and refusing the scan would
  -- push the guard back to paper.
  geo_ok            BOOLEAN,

  -- Device clock vs server clock, kept apart deliberately: the gap measures
  -- signal quality, and a wild gap exposes a wrong device clock before it can
  -- silently mis-date a business_date.
  scanned_at        TIMESTAMPTZ NOT NULL,
  received_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

  guard_id          UUID REFERENCES app_users(id),
  device_id         TEXT,

  -- ── Expected-list check ─────────────────────────────────────────────────
  -- Recorded on every scan even while the check runs SILENTLY during the pilot,
  -- so the false-alarm rate can be measured before any guard is shown a warning.
  -- Training people to dismiss warnings is far more expensive than a late launch.
  expected_match    TEXT CHECK (expected_match IN ('expected','not_listed','unchecked')),
  -- An override is where the risk concentrates, so it is recorded rather than
  -- dismissed: reason + photo, into the exception queue, counted per guard.
  override_reason   TEXT,

  -- ── Untagged inward and its 2-day clock ─────────────────────────────────
  barcode_pending   BOOLEAN NOT NULL DEFAULT FALSE,
  linked_barcode    TEXT,
  linked_at         TIMESTAMPTZ,
  linked_by         UUID REFERENCES app_users(id),

  exception_reason  TEXT,
  -- A mis-scan is voided, never deleted: the event happened, and the trail has
  -- to show it was corrected rather than that it never existed.
  status            TEXT NOT NULL DEFAULT 'recorded'
                    CHECK (status IN ('recorded','void')),
  void_reason       TEXT,
  voided_by         UUID REFERENCES app_users(id),
  voided_at         TIMESTAMPTZ,

  notes             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- ── The control rules, enforced here rather than trusted to the app ─────
  -- A phone app is the least trustworthy place to keep a control: it ships in
  -- versions, runs offline, and an old build lingers on a guard's phone for
  -- weeks. These are unbypassable.

  -- OUTWARD MUST BE SCANNED. The rule is "mandatory", but a destroyed sticker is
  -- a real event and a rule with no escape hatch gets worked around rather than
  -- obeyed. Manual outward needs a stated reason AND a photo: expensive enough
  -- to stay exceptional, fully visible when it happens.
  CONSTRAINT gate_scans_outward_scan_required CHECK (
    direction <> 'OUT'
    OR entry_method = 'scan'
    OR (exception_reason IS NOT NULL AND photo_path IS NOT NULL)
  ),

  -- A MANUAL ENTRY ALWAYS CARRIES A PHOTO.
  CONSTRAINT gate_scans_manual_needs_photo CHECK (
    entry_method <> 'manual' OR photo_path IS NOT NULL
  ),

  -- AN OVERRIDE ALWAYS CARRIES A REASON AND A PHOTO. Without this the override
  -- becomes a silent dismiss button, hiding the exact signal it exists to raise.
  CONSTRAINT gate_scans_override_needs_proof CHECK (
    override_reason IS NULL OR photo_path IS NOT NULL
  ),

  -- SOMETHING MUST IDENTIFY AN IDENTIFIED ITEM -- and nothing needs to identify
  -- a counted one.
  --
  -- The earlier version of this demanded a serial on every barcode-less row,
  -- which would have made a box of consumables IMPOSSIBLE TO RECORD: there is
  -- no serial, there never was one, and the quantity is the entire fact. A
  -- constraint that blocks a routine daily movement is not a control, it is an
  -- outage.
  --
  -- For the two identified-but-untagged kinds, any of serial / SO / ticket will
  -- do. A customer return whose sticker is gone is still identifiable by the
  -- pickup it came back from.
  CONSTRAINT gate_scans_identifier_present CHECK (
    barcode IS NOT NULL
    OR item_kind IN ('spare_part','consumable','pp_box','sample','other')
    OR (direction = 'IN' AND barcode_pending
        AND (serial_no IS NOT NULL OR so_number IS NOT NULL OR ticket_id IS NOT NULL))
  ),

  -- VENDOR GOODS AND CUSTOMER RETURNS ONLY ARRIVE. Neither can leave: stock
  -- going out is either a tagged unit or a counted extra.
  CONSTRAINT gate_scans_inward_only_kinds CHECK (
    item_kind NOT IN ('vendor_goods','customer_return') OR direction = 'IN'
  ),

  -- A TAGGED UNIT IS ONE THING. Quantity is only meaningful for counted kinds
  -- and for untagged vendor batches ("ten fridges, no stickers yet").
  CONSTRAINT gate_scans_unit_is_singular CHECK (
    item_kind NOT IN ('unit','customer_return') OR quantity = 1
  ),

  -- AN UNTAGGED CUSTOMER RETURN IS AN ALERT, NOT A ROUTINE ARRIVAL.
  -- Vendor goods legitimately have no sticker yet -- they are tagged after
  -- receipt. A CityFurnish unit coming BACK has been tagged already, so a
  -- missing sticker means it was removed or fell off, and until it is re-tagged
  -- the unit cannot be matched to its own history. It must therefore arrive
  -- carrying a stated reason, which is what puts it in front of a human.
  CONSTRAINT gate_scans_untagged_return_flagged CHECK (
    item_kind <> 'customer_return'
    OR barcode IS NOT NULL
    OR (barcode_pending AND exception_reason IS NOT NULL)
  ),

  -- A SCAN IS A QR READ, BY DEFINITION -- so the two columns cannot drift into
  -- disagreeing about how much the row should be trusted.
  CONSTRAINT gate_scans_scan_is_qr CHECK (
    (entry_method = 'scan') = (barcode_source = 'qr')
  ),

  CONSTRAINT gate_scans_void_has_reason CHECK (
    status <> 'void' OR void_reason IS NOT NULL
  )
);

-- The reconcile connector's read.
CREATE INDEX IF NOT EXISTS idx_gs_city_date_dir
  ON gate_scans (city, business_date, direction) WHERE status = 'recorded';
CREATE INDEX IF NOT EXISTS idx_gs_trip ON gate_scans (trip_id);
-- NO ITEM TWICE ON ONE TRUCK. The phone warns the guard in the moment, which is
-- where the mistake is cheap to fix; this is the backstop for the case the
-- phone cannot see -- two devices, or a queue replayed after a reinstall.
-- Counted rows are excluded: three separate boxes of consumables on one trip
-- are three legitimate rows, and they carry no barcode anyway.
CREATE UNIQUE INDEX IF NOT EXISTS uq_gs_no_dupe_in_trip
  ON gate_scans (trip_id, barcode)
  WHERE barcode IS NOT NULL AND status = 'recorded';
CREATE INDEX IF NOT EXISTS idx_gs_barcode ON gate_scans (barcode) WHERE barcode IS NOT NULL;
-- The untagged queue: a handful of rows against a table growing ~740/day.
CREATE INDEX IF NOT EXISTS idx_gs_pending_barcode
  ON gate_scans (city, business_date) WHERE barcode_pending AND status = 'recorded';
-- Override monitoring, per guard per week.
CREATE INDEX IF NOT EXISTS idx_gs_overrides
  ON gate_scans (city, guard_id, scanned_at) WHERE override_reason IS NOT NULL;
-- Photo retention sweep (90 days).
CREATE INDEX IF NOT EXISTS idx_gs_photo_age
  ON gate_scans (scanned_at) WHERE photo_path IS NOT NULL;

COMMENT ON TABLE gate_scans IS
  'Digital gate register — one row per physical movement. Replaces guard_uploads/OCR as the PHYSICAL source.';
COMMENT ON COLUMN gate_scans.client_scan_id IS
  'Device-generated idempotency key. Re-sending a key already stored is a no-op — this is what makes offline retry safe.';
COMMENT ON COLUMN gate_scans.barcode IS
  'QR payload EXACTLY as decoded. Never canonicalized here; the fold is applied downstream for matching only.';

-- ---------------------------------------------------------------------------
-- 4. gate_expected_items — today's planned pickings, cached.
-- ---------------------------------------------------------------------------
-- Sourced from Odoo PLANNED pickings (assigned/confirmed), which today's Odoo
-- connector does not pull -- it queries done-only. Cached rather than queried
-- live because a Metabase round trip takes seconds and three guards downloading
-- at shift start would each pay it, and because the app must be able to check a
-- scan instantly with no network.
--
-- Kept as a table, not a computed response, so that a silent-mode false alarm
-- can be explained afterwards against the list AS IT STOOD, not as it would be
-- rebuilt today.
CREATE TABLE IF NOT EXISTS gate_expected_items (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  city            TEXT NOT NULL
                  CHECK (city IN ('DELHI','MUMBAI','PUNE','HYDERABAD','BANGALORE')),
  business_date   DATE NOT NULL,
  direction       TEXT NOT NULL CHECK (direction IN ('IN','OUT')),
  -- As Odoo spells it, and the canonical fold beside it so a scanned QR can be
  -- matched even against a row whose Odoo spelling differs by a folded char.
  barcode         TEXT NOT NULL,
  barcode_canon   TEXT NOT NULL,
  product         TEXT,
  so_number       TEXT,
  ticket_id       TEXT,
  customer        TEXT,
  picking_ref     TEXT,
  job_type        TEXT,
  refreshed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (city, business_date, direction, barcode)
);

CREATE INDEX IF NOT EXISTS idx_gei_lookup
  ON gate_expected_items (city, business_date, direction, barcode_canon);

COMMENT ON TABLE gate_expected_items IS
  'Odoo planned pickings for a business day, cached for the gate app to validate scans offline.';

-- ---------------------------------------------------------------------------
-- 5. RLS — same shape as every other data table.
-- ---------------------------------------------------------------------------
ALTER TABLE gate_devices        ENABLE ROW LEVEL SECURITY;
ALTER TABLE guard_profiles      ENABLE ROW LEVEL SECURITY;
ALTER TABLE gate_trips          ENABLE ROW LEVEL SECURITY;
ALTER TABLE gate_scans          ENABLE ROW LEVEL SECURITY;
ALTER TABLE gate_expected_items ENABLE ROW LEVEL SECURITY;

-- Read: admins everywhere, everyone else their own city. Guards included, so a
-- guard can see and clear their own pending queue.
DROP POLICY IF EXISTS gate_trips_select ON gate_trips;
CREATE POLICY gate_trips_select ON gate_trips
  FOR SELECT USING (public.auth_is_admin() OR city = public.auth_city());

DROP POLICY IF EXISTS gate_scans_select ON gate_scans;
CREATE POLICY gate_scans_select ON gate_scans
  FOR SELECT USING (public.auth_is_admin() OR city = public.auth_city());

DROP POLICY IF EXISTS gate_expected_select ON gate_expected_items;
CREATE POLICY gate_expected_select ON gate_expected_items
  FOR SELECT USING (public.auth_is_admin() OR city = public.auth_city());

-- Devices and profiles are city-scoped reads for supervisors. Neither pin_hash
-- nor token_hash is ever selected by the app; both checks happen server-side.
DROP POLICY IF EXISTS gate_devices_select ON gate_devices;
CREATE POLICY gate_devices_select ON gate_devices
  FOR SELECT USING (public.auth_is_admin() OR city = public.auth_city());

DROP POLICY IF EXISTS guard_profiles_select ON guard_profiles;
CREATE POLICY guard_profiles_select ON guard_profiles
  FOR SELECT USING (public.auth_is_admin() OR city = public.auth_city());

-- Write: own city only. The sync endpoint uses the service-role client and
-- bypasses RLS entirely, so this is the backstop against a leaked anon key
-- rather than the primary gate.
DROP POLICY IF EXISTS gate_trips_insert ON gate_trips;
CREATE POLICY gate_trips_insert ON gate_trips
  FOR INSERT WITH CHECK (public.auth_is_admin() OR city = public.auth_city());

DROP POLICY IF EXISTS gate_scans_insert ON gate_scans;
CREATE POLICY gate_scans_insert ON gate_scans
  FOR INSERT WITH CHECK (public.auth_is_admin() OR city = public.auth_city());

-- Update: supervisors only. Voiding a row and attaching a late barcode are both
-- supervisory acts, never something the scanning device does.
-- Supervisors always. A GUARD may also correct their OWN scan while their own
-- trip is still OPEN -- scanning the wrong item is a normal mistake, and
-- requiring a manager to be found in the moment guarantees a workaround that
-- never shows up in the data. Once the trip closes, the record is settled and
-- correcting it becomes supervisory.
DROP POLICY IF EXISTS gate_scans_update ON gate_scans;
CREATE POLICY gate_scans_update ON gate_scans
  FOR UPDATE USING (
    public.auth_is_admin()
    OR (public.auth_role() = 'manager' AND city = public.auth_city())
    OR (
      public.auth_role() = 'guard'
      AND guard_id IN (SELECT id FROM app_users WHERE auth_id = auth.uid())
      AND trip_id IN (SELECT id FROM gate_trips WHERE status = 'open')
    )
  );

DROP POLICY IF EXISTS gate_trips_update ON gate_trips;
CREATE POLICY gate_trips_update ON gate_trips
  FOR UPDATE USING (
    public.auth_is_admin()
    OR (public.auth_role() = 'manager' AND city = public.auth_city())
    OR (public.auth_role() = 'guard' AND guard_id IN
        (SELECT id FROM app_users WHERE auth_id = auth.uid()))
  );

-- Enrolling a phone and creating a guard profile are both supervisory acts.
DROP POLICY IF EXISTS gate_devices_write ON gate_devices;
CREATE POLICY gate_devices_write ON gate_devices
  FOR ALL USING (
    public.auth_is_admin()
    OR (public.auth_role() = 'manager' AND city = public.auth_city())
  );

DROP POLICY IF EXISTS guard_profiles_write ON guard_profiles;
CREATE POLICY guard_profiles_write ON guard_profiles
  FOR ALL USING (
    public.auth_is_admin()
    OR (public.auth_role() = 'manager' AND city = public.auth_city())
  );

-- ---------------------------------------------------------------------------
-- 6. The face descriptor — added with the on-device matching.
-- ---------------------------------------------------------------------------
-- 128 numbers describing the guard's face, computed in the MANAGER'S browser
-- when the reference photo is taken. Only this leaves; the photograph itself
-- stays in storage for human review and is never sent to a phone.
--
-- WHY NOT SEND THE PHOTO. Devices are shared — the roster at a gate lists every
-- guard working there — so shipping photos would cache each guard's face on
-- every colleague's personal phone. A descriptor is a fraction of the size,
-- cannot be turned back into a picture, and keeps one person's face off another
-- person's device.
ALTER TABLE guard_profiles
  ADD COLUMN IF NOT EXISTS reference_descriptor REAL[];

COMMENT ON COLUMN guard_profiles.reference_descriptor IS
  '128-float face signature computed at enrolment. Sent to devices instead of the photo.';
