-- ============================================================
-- LegacyHQ — Migration v4: FUNERAL CENTER + MEMORIES + MEMORIAL PAGES
-- Run AFTER v1–v3. Additive only.
-- ============================================================

-- ---------- FUNERAL PLANNING ----------
create table public.funeral_budget (
  id uuid primary key default gen_random_uuid(),
  estate_id uuid not null references public.estates(id) on delete cascade,
  item text not null,
  category text default 'service',   -- service | disposition | cemetery | flowers | catering | transport | printing | other
  estimated numeric(12,2) default 0,
  actual numeric(12,2),
  vendor text,
  notes text,
  created_at timestamptz not null default now()
);
create table public.funeral_options (
  id uuid primary key default gen_random_uuid(),
  estate_id uuid not null references public.estates(id) on delete cascade,
  option_type text not null default 'funeral_home',  -- funeral_home | cemetery | florist | caterer | other
  name text not null,
  quote numeric(12,2),
  phone text,
  notes text,
  chosen boolean default false,
  created_at timestamptz not null default now()
);

-- ---------- MEMORIES ----------
create table public.memories (
  id uuid primary key default gen_random_uuid(),
  estate_id uuid references public.estates(id) on delete cascade,
  plan_id uuid references public.plans(id) on delete cascade,
  kind text not null default 'story',      -- story | letter | recipe | photo | tribute
  title text not null,
  body text,
  media_path text,                          -- path in PUBLIC bucket memorial-media (published photos)
  author text,
  created_by uuid references public.profiles(id),
  published boolean not null default false, -- appears on the public memorial page
  created_at timestamptz not null default now(),
  check (estate_id is not null or plan_id is not null)
);

-- ---------- MEMORIAL PAGE SETTINGS ----------
create table public.memorial_settings (
  estate_id uuid primary key references public.estates(id) on delete cascade,
  token text not null unique default replace(gen_random_uuid()::text,'-',''),
  enabled boolean not null default false,
  headline text,
  service_info text,
  donation_note text,
  updated_at timestamptz not null default now()
);

-- ---------- RLS ----------
do $$
declare t text;
begin
  foreach t in array array['funeral_budget','funeral_options']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy "members read %s" on public.%I for select using (public.is_estate_member(estate_id))', t, t);
    execute format('create policy "members insert %s" on public.%I for insert with check (public.is_estate_member(estate_id))', t, t);
    execute format('create policy "members update %s" on public.%I for update using (public.is_estate_member(estate_id))', t, t);
    execute format('create policy "members delete %s" on public.%I for delete using (public.is_estate_member(estate_id))', t, t);
  end loop;
end $$;

alter table public.memories enable row level security;
create policy "scope members read memories" on public.memories for select
  using ((estate_id is not null and public.is_estate_member(estate_id))
      or (plan_id is not null and public.is_plan_member(plan_id)));
create policy "scope members insert memories" on public.memories for insert
  with check ((estate_id is not null and public.is_estate_member(estate_id))
      or (plan_id is not null and public.is_plan_member(plan_id)));
create policy "scope members update memories" on public.memories for update
  using ((estate_id is not null and public.is_estate_member(estate_id))
      or (plan_id is not null and public.is_plan_member(plan_id)));
create policy "scope members delete memories" on public.memories for delete
  using ((estate_id is not null and public.is_estate_member(estate_id))
      or (plan_id is not null and public.is_plan_member(plan_id)));

alter table public.memorial_settings enable row level security;
create policy "members read memorial settings" on public.memorial_settings
  for select using (public.is_estate_member(estate_id));
create policy "members upsert memorial settings" on public.memorial_settings
  for insert with check (public.is_estate_member(estate_id));
create policy "members update memorial settings" on public.memorial_settings
  for update using (public.is_estate_member(estate_id));

-- ---------- PUBLIC MEMORIAL FETCH (anon-callable, token-gated) ----------
create or replace function public.get_memorial(tok text)
returns json language plpgsql security definer set search_path = public stable as $$
declare ms record; e record; mems json;
begin
  select * into ms from public.memorial_settings where token = tok and enabled = true;
  if ms is null then return json_build_object('error','not_found'); end if;
  select decedent_name, date_of_death into e from public.estates where id = ms.estate_id;
  select coalesce(json_agg(json_build_object(
           'kind',kind,'title',title,'body',body,'media_path',media_path,'author',author,'created_at',created_at)
         order by created_at), '[]'::json)
    into mems
    from public.memories
   where estate_id = ms.estate_id and published = true;
  return json_build_object('name',e.decedent_name,'date_of_death',e.date_of_death,
    'headline',ms.headline,'service_info',ms.service_info,'donation_note',ms.donation_note,'memories',mems);
end $$;

-- ---------- STORAGE ----------
-- Create a PUBLIC bucket named: memorial-media  (Dashboard → Storage → New bucket → Public)
-- Then run:
create policy "members upload memorial media" on storage.objects for insert
  with check (bucket_id = 'memorial-media'
    and public.is_estate_member(((storage.foldername(name))[1])::uuid));
create policy "members delete memorial media" on storage.objects for delete
  using (bucket_id = 'memorial-media'
    and public.is_estate_member(((storage.foldername(name))[1])::uuid));
-- (Public buckets are world-readable by design — only PUBLISHED photos go here.)
