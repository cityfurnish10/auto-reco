-- 0045_gate_trip_vehicle_photo.sql
--
-- A photo of how the stock is kept in the vehicle, per trip.
--
-- Asked for 14 Sep 2026: before scanning starts on every INWARD trip, and after
-- scanning is done on every OUTWARD trip, the guard photographs the vehicle to
-- register how the stock is handled — a clear photo, stored, and viewable from
-- the trip on the portal's Activity tab.
--
-- The image lives in the gate-evidence bucket beside item photos (same 90-day
-- retention). The phone uploads it through a one-time link the sync hands back,
-- exactly like an item photo; this column is the pointer to it.
--
-- Safe to re-run.

ALTER TABLE gate_trips
  ADD COLUMN IF NOT EXISTS vehicle_photo_path TEXT;

COMMENT ON COLUMN gate_trips.vehicle_photo_path IS
  'Storage path (gate-evidence) of the vehicle photo: taken before unloading an '
  'inward trip, after loading an outward one. Set when the trip closes.';
