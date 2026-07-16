-- 0008_pp_consumable_counts.sql
-- PP boxes and spares/consumables are count-only movements, not per-barcode
-- variances. Stop treating them as INFO variances: track their counts per city
-- per run (run_city_stats), and delete the existing count-only variance rows so
-- the variance list is just genuine barcode reconciliation items.

alter table public.run_city_stats
  add column if not exists pp_box_count    int not null default 0,
  add column if not exists consumable_count int not null default 0;

-- Remove the old count-only INFO rows from the variance list (engine no longer
-- produces them; their counts live in run_city_stats now).
delete from public.variances
  where variance_name in ('PP Box Movement (Count Only)', 'Spare/Consumable Movement');
