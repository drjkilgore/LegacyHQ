-- ============================================================
-- LegacyHQ — Migration v5: INSURANCE CLAIMS CENTER
-- Run AFTER v1–v4 (+ hotfix v4.1). Additive only. Run as admin.
-- ============================================================
create table public.insurance_claims (
  id uuid primary key default gen_random_uuid(),
  estate_id uuid not null references public.estates(id) on delete cascade,
  carrier text not null,
  policy_type text not null default 'life',   -- life | employer_life | ad_d | annuity | ltc | va | other
  policy_number text,
  face_amount numeric(14,2),
  beneficiary text,
  status text not null default 'locating',    -- locating | forms_requested | submitted | in_review | approved | paid | denied
  paid_amount numeric(14,2),
  paid_on date,
  docs jsonb not null default '{}'::jsonb,    -- checklist state {death_cert:true,...}
  contact text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.insurance_claims enable row level security;
create policy "members read claims" on public.insurance_claims
  for select using (public.is_estate_member(estate_id));
create policy "members insert claims" on public.insurance_claims
  for insert with check (public.is_estate_member(estate_id));
create policy "members update claims" on public.insurance_claims
  for update using (public.is_estate_member(estate_id));
create policy "members delete claims" on public.insurance_claims
  for delete using (public.is_estate_member(estate_id));
