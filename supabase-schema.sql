-- ============================================================
-- LegacyHQ — Supabase Schema v1.0 (multi-tenant SaaS)
-- Run this entire file in Supabase SQL Editor on a NEW dedicated project.
-- ============================================================

-- ---------- PROFILES ----------
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  full_name text,
  plan_tier text not null default 'free',        -- free | settle | premium
  stripe_customer_id text,
  created_at timestamptz not null default now()
);
alter table public.profiles enable row level security;

create policy "read own profile" on public.profiles
  for select using (auth.uid() = id);
create policy "update own profile" on public.profiles
  for update using (auth.uid() = id);

-- Auto-create profile on signup
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'full_name',''));
  return new;
end; $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- ESTATES ----------
create table public.estates (
  id uuid primary key default gen_random_uuid(),
  created_by uuid not null references public.profiles(id),
  decedent_name text not null,
  date_of_death date,
  state_code text default 'MI',
  relationship text,
  intake jsonb not null default '{}'::jsonb,
  ruleset_version text default 'v1',
  created_at timestamptz not null default now()
);
alter table public.estates enable row level security;

create table public.estate_members (
  estate_id uuid not null references public.estates(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role text not null default 'member',           -- owner | executor | member | viewer
  created_at timestamptz not null default now(),
  primary key (estate_id, user_id)
);
alter table public.estate_members enable row level security;

-- Membership helper (security definer avoids RLS recursion)
create or replace function public.is_estate_member(e uuid)
returns boolean language sql security definer set search_path = public stable as $$
  select exists (select 1 from public.estate_members
                 where estate_id = e and user_id = auth.uid());
$$;

create or replace function public.is_estate_owner(e uuid)
returns boolean language sql security definer set search_path = public stable as $$
  select exists (select 1 from public.estate_members
                 where estate_id = e and user_id = auth.uid() and role = 'owner');
$$;

create policy "members read estates" on public.estates
  for select using (public.is_estate_member(id));
create policy "create own estate" on public.estates
  for insert with check (created_by = auth.uid());
create policy "owners update estates" on public.estates
  for update using (public.is_estate_owner(id));
create policy "owners delete estates" on public.estates
  for delete using (public.is_estate_owner(id));

create policy "members read members" on public.estate_members
  for select using (public.is_estate_member(estate_id));
create policy "self-insert as creator" on public.estate_members
  for insert with check (
    user_id = auth.uid()
    and exists (select 1 from public.estates e
                where e.id = estate_id and e.created_by = auth.uid())
  );
create policy "owners manage members" on public.estate_members
  for delete using (public.is_estate_owner(estate_id));

-- ---------- INVITES ----------
create table public.estate_invites (
  id uuid primary key default gen_random_uuid(),
  estate_id uuid not null references public.estates(id) on delete cascade,
  email text not null,
  role text not null default 'member',
  invited_by uuid references public.profiles(id),
  accepted boolean not null default false,
  created_at timestamptz not null default now()
);
alter table public.estate_invites enable row level security;

create policy "members read invites" on public.estate_invites
  for select using (public.is_estate_member(estate_id));
create policy "members create invites" on public.estate_invites
  for insert with check (public.is_estate_member(estate_id) and invited_by = auth.uid());
create policy "owners delete invites" on public.estate_invites
  for delete using (public.is_estate_owner(estate_id));

-- Called by the app after login: converts pending invites into memberships
create or replace function public.accept_my_invites()
returns integer language plpgsql security definer set search_path = public as $$
declare n integer := 0; inv record;
begin
  for inv in
    select i.* from public.estate_invites i
    join public.profiles p on lower(p.email) = lower(i.email)
    where p.id = auth.uid() and i.accepted = false
  loop
    insert into public.estate_members (estate_id, user_id, role)
    values (inv.estate_id, auth.uid(), inv.role)
    on conflict do nothing;
    update public.estate_invites set accepted = true where id = inv.id;
    n := n + 1;
  end loop;
  return n;
end; $$;

-- ---------- TASKS ----------
create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  estate_id uuid not null references public.estates(id) on delete cascade,
  rule_id text,
  phase text not null default 'week1',           -- first24 | week1 | month1 | days90 | longterm
  category text,
  title text not null,
  why text,
  how text,
  status text not null default 'todo',           -- todo | in_progress | done | na
  assignee uuid references public.profiles(id),
  due_at date,
  sort_order integer not null default 0,
  custom boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.tasks enable row level security;

create policy "members read tasks" on public.tasks
  for select using (public.is_estate_member(estate_id));
create policy "members write tasks" on public.tasks
  for insert with check (public.is_estate_member(estate_id));
create policy "members update tasks" on public.tasks
  for update using (public.is_estate_member(estate_id));
create policy "members delete tasks" on public.tasks
  for delete using (public.is_estate_member(estate_id));

create index tasks_estate_idx on public.tasks (estate_id, phase, sort_order);

-- ---------- DOCUMENTS ----------
create table public.documents (
  id uuid primary key default gen_random_uuid(),
  estate_id uuid not null references public.estates(id) on delete cascade,
  name text not null,
  storage_path text not null,
  doc_type text default 'other',
  uploaded_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);
alter table public.documents enable row level security;

create policy "members read documents" on public.documents
  for select using (public.is_estate_member(estate_id));
create policy "members add documents" on public.documents
  for insert with check (public.is_estate_member(estate_id));
create policy "members delete documents" on public.documents
  for delete using (public.is_estate_member(estate_id));

-- ---------- NOTIFICATIONS LOG ----------
create table public.notifications_log (
  id uuid primary key default gen_random_uuid(),
  estate_id uuid not null references public.estates(id) on delete cascade,
  recipient text not null,
  category text,                                  -- bank | insurer | government | family | subscription | other
  template_id text,
  status text not null default 'pending',         -- pending | sent | confirmed
  confirmation text,
  notes text,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
alter table public.notifications_log enable row level security;

create policy "members read notifications" on public.notifications_log
  for select using (public.is_estate_member(estate_id));
create policy "members write notifications" on public.notifications_log
  for insert with check (public.is_estate_member(estate_id));
create policy "members update notifications" on public.notifications_log
  for update using (public.is_estate_member(estate_id));
create policy "members delete notifications" on public.notifications_log
  for delete using (public.is_estate_member(estate_id));

-- ---------- ACTIVITY LOG (append-only) ----------
create table public.activity_log (
  id bigint generated always as identity primary key,
  estate_id uuid not null references public.estates(id) on delete cascade,
  user_id uuid references public.profiles(id),
  action text not null,
  detail text,
  created_at timestamptz not null default now()
);
alter table public.activity_log enable row level security;

create policy "members read activity" on public.activity_log
  for select using (public.is_estate_member(estate_id));
create policy "members append activity" on public.activity_log
  for insert with check (public.is_estate_member(estate_id) and user_id = auth.uid());
-- No update/delete policies: log is append-only by design.

-- ---------- STORAGE ----------
-- Create a PRIVATE bucket named: estate-docs  (Dashboard → Storage → New bucket)
-- Then run these storage policies:
create policy "members read files" on storage.objects for select
  using (bucket_id = 'estate-docs'
         and public.is_estate_member(((storage.foldername(name))[1])::uuid));
create policy "members upload files" on storage.objects for insert
  with check (bucket_id = 'estate-docs'
         and public.is_estate_member(((storage.foldername(name))[1])::uuid));
create policy "members delete files" on storage.objects for delete
  using (bucket_id = 'estate-docs'
         and public.is_estate_member(((storage.foldername(name))[1])::uuid));

-- ============================================================
-- REMINDERS (manual dashboard steps):
-- 1. Authentication → Sessions → JWT expiry = 3600 seconds
-- 2. Authentication → URL Configuration → add your Netlify site URL
-- 3. Storage → create private bucket 'estate-docs' BEFORE running the
--    three storage policies above (re-run just that block after creating it)
-- ============================================================
