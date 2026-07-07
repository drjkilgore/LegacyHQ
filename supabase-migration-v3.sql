-- ============================================================
-- LegacyHQ — Migration v3: LEDGER + EMERGENCY ACCESS
-- Run AFTER v1 schema and v2 migration. Additive only.
-- ============================================================

-- ================= ESTATE LEDGER =================
create table public.estate_assets (
  id uuid primary key default gen_random_uuid(),
  estate_id uuid not null references public.estates(id) on delete cascade,
  name text not null,
  category text default 'other',            -- bank | brokerage | retirement | realestate | vehicle | personal | business | other
  titling text,                             -- sole | joint | tod_pod | trust | unknown
  probate_asset boolean default true,
  dod_value numeric(14,2) default 0,        -- date-of-death value (court + step-up basis)
  current_value numeric(14,2),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table public.estate_liabilities (
  id uuid primary key default gen_random_uuid(),
  estate_id uuid not null references public.estates(id) on delete cascade,
  creditor text not null,
  category text default 'other',            -- mortgage | card | loan | medical | tax | funeral | other
  amount numeric(14,2) default 0,
  status text not null default 'pending',   -- pending | allowed | denied | paid
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table public.estate_expenses (
  id uuid primary key default gen_random_uuid(),
  estate_id uuid not null references public.estates(id) on delete cascade,
  payee text not null,
  category text default 'admin',            -- funeral | admin | legal | tax | property | other
  amount numeric(14,2) default 0,
  paid_on date,
  paid_by text,                             -- estate account | executor (reimbursable) | family member
  reimbursable boolean default false,
  notes text,
  created_at timestamptz not null default now()
);
create table public.estate_beneficiaries (
  id uuid primary key default gen_random_uuid(),
  estate_id uuid not null references public.estates(id) on delete cascade,
  name text not null,
  relation text,
  share text,                               -- e.g., "50%", "residuary", "specific: vehicle"
  contact text,
  notes text,
  created_at timestamptz not null default now()
);
create table public.estate_distributions (
  id uuid primary key default gen_random_uuid(),
  estate_id uuid not null references public.estates(id) on delete cascade,
  beneficiary text not null,
  description text,
  amount numeric(14,2) default 0,
  distributed_on date,
  receipt_signed boolean default false,
  notes text,
  created_at timestamptz not null default now()
);

do $$
declare t text;
begin
  foreach t in array array['estate_assets','estate_liabilities','estate_expenses','estate_beneficiaries','estate_distributions']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy "members read %s" on public.%I for select using (public.is_estate_member(estate_id))', t, t);
    execute format('create policy "members insert %s" on public.%I for insert with check (public.is_estate_member(estate_id))', t, t);
    execute format('create policy "members update %s" on public.%I for update using (public.is_estate_member(estate_id))', t, t);
    execute format('create policy "members delete %s" on public.%I for delete using (public.is_estate_member(estate_id))', t, t);
  end loop;
end $$;

-- ================= EMERGENCY ACCESS =================
-- Owner designates trusted contacts; they can request access after death.
-- Request → owner alerted → waiting period → if not vetoed, access unlocks.
create table public.emergency_contacts (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.plans(id) on delete cascade,
  email text not null,
  name text,
  waiting_hours integer not null default 72,     -- owner-configurable veto window
  grant_role text not null default 'executor',
  created_at timestamptz not null default now(),
  unique (plan_id, email)
);
alter table public.emergency_contacts enable row level security;
create policy "owner manages emergency contacts" on public.emergency_contacts
  for all using (public.is_plan_owner(plan_id)) with check (public.is_plan_owner(plan_id));

create table public.emergency_requests (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.plans(id) on delete cascade,
  contact_id uuid not null references public.emergency_contacts(id) on delete cascade,
  requester_id uuid not null references public.profiles(id),
  status text not null default 'pending',        -- pending | vetoed | granted
  attestation text,
  requested_at timestamptz not null default now(),
  unlock_at timestamptz not null,
  resolved_at timestamptz
);
alter table public.emergency_requests enable row level security;
create policy "owner or requester reads requests" on public.emergency_requests
  for select using (public.is_plan_owner(plan_id) or requester_id = auth.uid());

-- Requester (signed in, email matches a designated contact) files a request.
create or replace function public.request_emergency_access(owner_search_email text, attestation_text text)
returns json language plpgsql security definer set search_path = public as $$
declare c record; req_id uuid; my_email text; owner_id uuid; unlock timestamptz;
begin
  select email into my_email from public.profiles where id = auth.uid();
  if my_email is null then return json_build_object('error','Sign in first.'); end if;

  select ec.*, p.subject_name, p.created_by as plan_owner into c
  from public.emergency_contacts ec
  join public.plans p on p.id = ec.plan_id
  join public.profiles op on op.id = p.created_by
  where lower(ec.email) = lower(my_email)
    and lower(op.email) = lower(owner_search_email)
  limit 1;

  if c is null then
    return json_build_object('error','No emergency designation found for your email on that account.');
  end if;
  if exists (select 1 from public.emergency_requests
             where contact_id = c.id and status = 'pending') then
    return json_build_object('error','A request is already pending.');
  end if;

  unlock := now() + make_interval(hours => c.waiting_hours);
  insert into public.emergency_requests (plan_id, contact_id, requester_id, attestation, unlock_at)
  values (c.plan_id, c.id, auth.uid(), attestation_text, unlock)
  returning id into req_id;

  select email into owner_search_email from public.profiles where id = c.plan_owner;
  return json_build_object('ok',true,'request_id',req_id,'unlock_at',unlock,
    'subject',c.subject_name,'owner_email',owner_search_email,'waiting_hours',c.waiting_hours);
end $$;

-- Owner vetoes a pending request.
create or replace function public.veto_emergency_access(req uuid)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  update public.emergency_requests r set status='vetoed', resolved_at=now()
  where r.id = req and r.status='pending' and public.is_plan_owner(r.plan_id);
  return found;
end $$;

-- Requester claims access once the waiting period has passed unvetoed.
create or replace function public.claim_emergency_access(req uuid)
returns json language plpgsql security definer set search_path = public as $$
declare r record;
begin
  select er.*, ec.grant_role into r
  from public.emergency_requests er
  join public.emergency_contacts ec on ec.id = er.contact_id
  where er.id = req and er.requester_id = auth.uid();

  if r is null then return json_build_object('error','Request not found.'); end if;
  if r.status = 'vetoed' then return json_build_object('error','This request was declined by the plan owner.'); end if;
  if r.status = 'granted' then return json_build_object('ok',true,'already',true); end if;
  if now() < r.unlock_at then
    return json_build_object('error','waiting','unlock_at',r.unlock_at);
  end if;

  insert into public.plan_members (plan_id, user_id, role)
  values (r.plan_id, auth.uid(), r.grant_role) on conflict do nothing;
  update public.emergency_requests set status='granted', resolved_at=now() where id = req;
  return json_build_object('ok',true);
end $$;

-- Lets a signed-in requester see their own requests with countdown info.
create or replace function public.my_emergency_requests()
returns setof json language sql security definer set search_path = public stable as $$
  select json_build_object('id',er.id,'status',er.status,'unlock_at',er.unlock_at,
    'subject',p.subject_name,'requested_at',er.requested_at)
  from public.emergency_requests er join public.plans p on p.id = er.plan_id
  where er.requester_id = auth.uid()
  order by er.requested_at desc;
$$;
