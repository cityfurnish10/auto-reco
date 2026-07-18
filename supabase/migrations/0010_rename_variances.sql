-- 0010_rename_variances.sql
-- Rename variance_name on existing rows to the new precise, warehouse-plain names
-- (see lib/engine/variance-names.ts). Human resolution (status / closure /
-- approval columns) is untouched. Apply together with the code deploy so a
-- re-run emits the same new name and upserts the migrated row (no duplicate).
--
-- variance_name is a free-text column (no CHECK), so no constraint change. The
-- unique key includes variance_name, but the new names never existed before, so
-- no rename can collide with an existing row.

update public.variances set variance_name = 'Wrong Barcode Scanned in DT'
  where variance_name = 'Fake Scan Risk';
update public.variances set variance_name = 'Moved on Floor + DT — Not Posted in Odoo'
  where variance_name = 'Register/DT Logged — Not in Odoo';
update public.variances set variance_name = 'Gate + Ops Confirm — No DT Scan or Odoo Post'
  where variance_name = 'Register-Confirmed, No Odoo Record';
update public.variances set variance_name = 'Gate Register Only — No Ops / DT / Odoo Record'
  where variance_name = 'Gate-Only Dispatch — No Ops/Odoo Trail';
update public.variances set variance_name = 'Ops Sheet Only — No Gate / DT / Odoo Record'
  where variance_name = 'Sheet-Only Dispatch — No Trail';
update public.variances set variance_name = 'Ops + Odoo Confirm — Missing from Gate Register'
  where variance_name = 'Ops-Sheet Confirmed — Gate Log Missing';
update public.variances set variance_name = 'Ops + Odoo Confirm — No DT Scan'
  where variance_name = 'DT Missing — Ops & Odoo Agree';
update public.variances set variance_name = 'Pickup Logged (Gate + DT) — Odoo Receipt Open'
  where variance_name = 'Pickup Confirmed — Odoo Not Closed';
update public.variances set variance_name = 'DT Only — No Floor or Odoo Record'
  where variance_name = 'DT-Only — Fake Scan Risk';
update public.variances set variance_name = 'Odoo Posting Only — No Gate / Ops / DT Record'
  where variance_name = 'Odoo-Only Entry — No Floor Record';
update public.variances set variance_name = 'DT + Odoo Confirm — Missing from Ops Sheet'
  where variance_name = 'Ops Sheet Missing — DT & Odoo Agree';
update public.variances set variance_name = 'Gate + Ops + Odoo Confirm — DT Scan Pending'
  where variance_name = 'Odoo Update Pending — Movement Confirmed';
update public.variances set variance_name = 'Gate + Odoo Confirm — No Ops Sheet or DT Scan'
  where variance_name = 'Physical + Odoo Agree — No Register/DT';
update public.variances set variance_name = 'Ops + DT Confirm — Odoo Posting Pending'
  where variance_name = 'Odoo Update Pending — Cross-Check';
update public.variances set variance_name = 'All Sources Agree — Barcode Text Differs (OCR/Typo)'
  where variance_name = 'All-Source Field Mismatch';
update public.variances set variance_name = 'Duplicate Scan — Same Barcode Logged Twice'
  where variance_name = 'Duplicate Scan / Multi-Source Mismatch';
update public.variances set variance_name = 'Same Unit In + Out Today — Confirm Replacement'
  where variance_name = 'Direction Conflict';
update public.variances set variance_name = 'Failed Delivery — Return Not Logged Inward'
  where variance_name = 'Failed Delivery — Return Not Logged';
