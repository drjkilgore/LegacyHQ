-- ============================================================
-- HomegoingHQ — Migration v9: LAST WISHES WITNESS (sealed video)
-- Run AFTER v1–v8 as admin ("Run without RLS"). Additive only.
-- ============================================================

create table public.witness_videos (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.plans(id) on delete cascade,
  recorded_by uuid not null references public.profiles(id),
  declared_name text not null,           -- the name the person states on camera
  title text not null default 'Last wishes',
  storage_path text not null,
  sha256 text not null,                  -- fingerprint computed in the browser at recording time
  byte_size bigint,
  mime_type text,
  witness_emails text,                   -- who received the fingerprint certificate
  recorded_at timestamptz not null default now()
);
alter table public.witness_videos enable row level security;

-- SEALED BY DESIGN: members can add and view. There is NO update policy and
-- NO delete policy — once recorded, a row cannot be modified or removed
-- through the application by anyone, including admins.
create policy "members read witness videos" on public.witness_videos
  for select using (public.is_plan_member(plan_id));
create policy "members add witness videos" on public.witness_videos
  for insert with check (public.is_plan_member(plan_id) and recorded_by = auth.uid());

-- ---------- STORAGE ----------
-- Create a PRIVATE bucket named: witness-videos   (Dashboard → Storage → New bucket)
-- Then run these two policies. Deliberately NO delete policy: files are immutable.
create policy "members upload witness video files" on storage.objects for insert
  with check (bucket_id = 'witness-videos'
    and public.is_plan_member(((storage.foldername(name))[1])::uuid));
create policy "members read witness video files" on storage.objects for select
  using (bucket_id = 'witness-videos'
    and public.is_plan_member(((storage.foldername(name))[1])::uuid));
