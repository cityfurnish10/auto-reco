-- =============================================================================
-- 0002_seed_app_users.sql — assign roles/cities to the 6 known accounts.
--
-- app_users.id references auth.users(id), so a row can only exist once the
-- matching Supabase Auth user exists. Create these 6 users first in
-- Supabase → Authentication → Users (or invite them), using these emails.
-- The handle_new_user() trigger will insert a default MANAGER row on signup;
-- this migration then upserts the correct role/city by matching on email.
--
-- Safe to run repeatedly (idempotent). Only affects auth users that exist.
-- =============================================================================
insert into public.app_users (id, name, email, role, city, status)
select u.id, s.name, s.email, s.role, s.city, 'ACTIVE'
from (
  values
    ('Admin User',    'admin@cityfurnish.com',              'ADMIN',   null),
    ('Rajesh Kumar',  'delhi.manager@cityfurnish.com',      'MANAGER', 'DELHI'),
    ('Amit Sharma',   'mumbai.manager@cityfurnish.com',     'MANAGER', 'MUMBAI'),
    ('Rohan Khanna',  'pune.manager@cityfurnish.com',       'MANAGER', 'PUNE'),
    ('Sneha Joshi',   'hydrabad.manager@cityfurnish.com',   'MANAGER', 'HYDRABAD'),
    ('Vikram Patel',  'bangalore.manager@cityfurnish.com',  'MANAGER', 'BANGALORE')
) as s(name, email, role, city)
join auth.users u on lower(u.email) = lower(s.email)
on conflict (id) do update
  set name   = excluded.name,
      role   = excluded.role,
      city   = excluded.city,
      status = 'ACTIVE';
