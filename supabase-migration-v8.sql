-- ============================================================
-- LegacyHQ — Migration v8: GIFT FLOW + E2EE + PROFESSIONAL ROLES
-- Run AFTER v1–v7 as admin ("Run without RLS"). Additive only.
-- ============================================================

-- ---------- GIFT CODES ----------
create table public.gift_codes (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  tier text not null default 'settle',
  purchaser_email text,
  recipient_email text,
  message text,
  status text not null default 'active',    -- active | redeemed
  redeemed_by uuid references public.profiles(id),
  redeemed_at timestamptz,
  created_at timestamptz not null default now()
);
alter table public.gift_codes enable row level security;
-- No client policies: codes are created by the Stripe webhook (service role)
-- and redeemed only through the RPC below.
create policy "admin reads gifts" on public.gift_codes
  for select using (public.is_admin());

create or replace function public.redeem_gift(gcode text)
returns json language plpgsql security definer set search_path = public as $$
declare g record;
begin
  if auth.uid() is null then return json_build_object('error','Sign in first.'); end if;
  select * into g from public.gift_codes
   where upper(code)=upper(trim(gcode)) and status='active' limit 1;
  if g is null then return json_build_object('error','That code isn''t valid or was already used.'); end if;
  update public.profiles set plan_tier = g.tier where id = auth.uid();
  update public.gift_codes set status='redeemed', redeemed_by=auth.uid(), redeemed_at=now()
   where id = g.id;
  return json_build_object('ok',true,'tier',g.tier);
end $$;

-- ---------- E2EE (client-side encryption for sensitive numbers) ----------
alter table public.plans add column if not exists e2ee_enabled boolean not null default false;
alter table public.plans add column if not exists e2ee_salt text;
alter table public.plans add column if not exists e2ee_check text;  -- known value encrypted with the user's key, used to verify the passphrase

-- ---------- PROFESSIONAL ROLES ----------
-- estate_members.role and plan_members.role already accept any text;
-- the app now offers: attorney | cpa | advisor (in addition to existing roles).
-- No schema change required — this section documents the convention.
