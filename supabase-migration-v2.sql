-- ============================================================
-- LegacyHQ — Migration v2: PLANNER MODE (run AFTER schema v1)
-- Additive only — safe to run on your existing project.
-- ============================================================

-- ---------- PLANS ----------
create table public.plans (
  id uuid primary key default gen_random_uuid(),
  created_by uuid not null references public.profiles(id),
  subject_name text not null,               -- whose life/estate this plan documents
  state_code text,
  relationship text default 'self',         -- self | spouse | parent | other
  created_at timestamptz not null default now()
);
alter table public.plans enable row level security;

create table public.plan_members (
  plan_id uuid not null references public.plans(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role text not null default 'member',      -- owner | executor | member | viewer
  created_at timestamptz not null default now(),
  primary key (plan_id, user_id)
);
alter table public.plan_members enable row level security;

create or replace function public.is_plan_member(p uuid)
returns boolean language sql security definer set search_path = public stable as $$
  select exists (select 1 from public.plan_members
                 where plan_id = p and user_id = auth.uid());
$$;
create or replace function public.is_plan_owner(p uuid)
returns boolean language sql security definer set search_path = public stable as $$
  select exists (select 1 from public.plan_members
                 where plan_id = p and user_id = auth.uid() and role = 'owner');
$$;

create policy "members read plans" on public.plans
  for select using (public.is_plan_member(id));
create policy "create own plan" on public.plans
  for insert with check (created_by = auth.uid());
create policy "owners update plans" on public.plans
  for update using (public.is_plan_owner(id));
create policy "owners delete plans" on public.plans
  for delete using (public.is_plan_owner(id));

create policy "members read plan members" on public.plan_members
  for select using (public.is_plan_member(plan_id));
create policy "self-insert as plan creator" on public.plan_members
  for insert with check (
    user_id = auth.uid()
    and exists (select 1 from public.plans p
                where p.id = plan_id and p.created_by = auth.uid())
  );
create policy "owners remove plan members" on public.plan_members
  for delete using (public.is_plan_owner(plan_id));

-- ---------- PLAN INVITES ----------
create table public.plan_invites (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.plans(id) on delete cascade,
  email text not null,
  role text not null default 'member',
  invited_by uuid references public.profiles(id),
  accepted boolean not null default false,
  created_at timestamptz not null default now()
);
alter table public.plan_invites enable row level security;

create policy "members read plan invites" on public.plan_invites
  for select using (public.is_plan_member(plan_id));
create policy "members create plan invites" on public.plan_invites
  for insert with check (public.is_plan_member(plan_id) and invited_by = auth.uid());
create policy "owners delete plan invites" on public.plan_invites
  for delete using (public.is_plan_owner(plan_id));

-- ---------- VAULT ENTRIES ----------
create table public.plan_entries (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.plans(id) on delete cascade,
  section text not null,                    -- one of the 13 vault section keys
  title text not null,
  detail text,
  number text,                              -- sensitive value (policy/account #, SSN) — masked in UI
  contact text,
  location text,                            -- where the physical original lives
  notes text,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.plan_entries enable row level security;

create policy "members read entries" on public.plan_entries
  for select using (public.is_plan_member(plan_id));
create policy "members write entries" on public.plan_entries
  for insert with check (public.is_plan_member(plan_id));
create policy "members update entries" on public.plan_entries
  for update using (public.is_plan_member(plan_id));
create policy "members delete entries" on public.plan_entries
  for delete using (public.is_plan_member(plan_id));

create index plan_entries_idx on public.plan_entries (plan_id, section, sort_order);

-- ---------- UPGRADED INVITE ACCEPTANCE (handles estates AND plans) ----------
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
    values (inv.estate_id, auth.uid(), inv.role) on conflict do nothing;
    update public.estate_invites set accepted = true where id = inv.id;
    n := n + 1;
  end loop;

  for inv in
    select i.* from public.plan_invites i
    join public.profiles p on lower(p.email) = lower(i.email)
    where p.id = auth.uid() and i.accepted = false
  loop
    insert into public.plan_members (plan_id, user_id, role)
    values (inv.plan_id, auth.uid(), inv.role) on conflict do nothing;
    update public.plan_invites set accepted = true where id = inv.id;
    n := n + 1;
  end loop;
  return n;
end; $$;
