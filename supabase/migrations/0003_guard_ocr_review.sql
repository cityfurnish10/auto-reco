-- =============================================================================
-- 0003_guard_ocr_review.sql — Guard Register OCR pipeline.
-- See the approved plan (Guard Register OCR Pipeline) for the full design.
--
-- 1. Creates the `guard-registers` Storage bucket (missing from 0001_init.sql —
--    dropped when that file was rewritten).
-- 2. Expands guard_uploads with review/audit columns + a 5-state status enum;
--    direction becomes optional (it's now per-row, inside parsed_rows, since a
--    single PDF can contain both IN and OUT pages).
-- 3. Adds the missing guard_uploads UPDATE policy — without it nothing could
--    ever move status past its initial value (0001_init.sql only had
--    _select and _insert).
-- 4. Adds storage.objects RLS so managers can only touch their own city's
--    folder (path convention: {CITY}/{business_date}/{upload_id}.pdf).
-- =============================================================================

-- 1. Storage bucket for guard register PDFs
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('guard-registers', 'guard-registers', false, 20971520, array['application/pdf'])
on conflict (id) do nothing;

-- 2. guard_uploads: status enum, review/audit columns, direction now optional
alter table guard_uploads drop constraint if exists guard_uploads_status_check;
alter table guard_uploads add constraint guard_uploads_status_check
  check (status in ('pending','ocr_running','needs_review','processed','failed'));
alter table guard_uploads alter column direction drop not null;

alter table guard_uploads add column if not exists parsed_rows jsonb;
alter table guard_uploads add column if not exists ocr_raw_snapshot jsonb;
alter table guard_uploads add column if not exists ocr_operation_id text;
alter table guard_uploads add column if not exists reviewed_by uuid references app_users(id);
alter table guard_uploads add column if not exists reviewed_at timestamptz;

comment on column guard_uploads.parsed_rows is
  'Reviewer-confirmed grid: array of {page, rowIndex, direction, cells:{date,barcode,so_number,ticket_id,product}, confidence}. Source of truth once status=processed — guard.ts pull() reads this.';
comment on column guard_uploads.ocr_raw_snapshot is
  'Immutable OCR output before human correction — audit trail if a PHYSICAL-sourced variance is disputed.';
comment on column guard_uploads.ocr_operation_id is
  'Azure Read API async operation id/URL — polled by the status route until succeeded.';

-- 3. Missing UPDATE policy (gap in 0001_init.sql)
drop policy if exists guard_uploads_update on guard_uploads;
create policy guard_uploads_update on guard_uploads
  for update using (
    exists (select 1 from app_users u where u.auth_id = auth.uid()
      and (u.role = 'admin' or u.city = guard_uploads.city))
  )
  with check (
    exists (select 1 from app_users u where u.auth_id = auth.uid()
      and (u.role = 'admin' or u.city = guard_uploads.city))
  );

-- 4. Storage RLS — path convention: {CITY}/{business_date}/{upload_id}.pdf
drop policy if exists guard_registers_insert on storage.objects;
create policy guard_registers_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'guard-registers'
    and exists (select 1 from app_users u where u.auth_id = auth.uid()
      and (u.role = 'admin' or u.city = (storage.foldername(name))[1]))
  );

drop policy if exists guard_registers_select on storage.objects;
create policy guard_registers_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'guard-registers'
    and exists (select 1 from app_users u where u.auth_id = auth.uid()
      and (u.role = 'admin' or u.city = (storage.foldername(name))[1]))
  );
