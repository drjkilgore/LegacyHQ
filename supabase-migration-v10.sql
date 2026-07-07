-- ============================================================
-- HomegoingHQ — Migration v10: MUSIC & SPECIAL TRIBUTES (VisionWorks)
-- Run AFTER v1–v9 as admin ("Run without RLS"). Additive only.
-- ============================================================
create table public.talent_requests (
  id uuid primary key default gen_random_uuid(),
  estate_id uuid not null references public.estates(id) on delete cascade,
  created_by uuid not null references public.profiles(id),
  need_type text not null,                 -- soloist | musicians | choir | tribute_video | appearance | repast_host | other
  service_date date,
  location text,
  budget_range text,
  artist_wishes text,
  details text,
  contact_name text,
  contact_phone text,
  contact_email text,
  status text not null default 'requested',  -- requested | contacted | booked | declined
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.talent_requests enable row level security;
create policy "members read talent" on public.talent_requests
  for select using (public.is_estate_member(estate_id));
create policy "members add talent" on public.talent_requests
  for insert with check (public.is_estate_member(estate_id) and created_by = auth.uid());
create policy "members update talent" on public.talent_requests
  for update using (public.is_estate_member(estate_id));
