-- HomegoingHQ — Migration v24: co-brand tenant types (funeral homes & churches)
-- Extends the existing concierge white-label engine with two CO-BRAND tenant
-- types. It deliberately does NOT rewrite provision_concierge_account or
-- public_branding: the unlimited family cap is enforced by a trigger, and the
-- co-brand attribution ("Aftercare provided by [Home], with HomegoingHQ") is
-- resolved client-side from the tenant_type that public_branding already returns.
-- Idempotent.

-- 1) Allow the two new tenant_type values (widen or create the CHECK constraint).
do $$
declare c record;
begin
  for c in
    select con.conname
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace ns on ns.oid = rel.relnamespace
    where ns.nspname = 'public' and rel.relname = 'concierge_accounts'
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) ilike '%tenant_type%'
  loop
    execute format('alter table public.concierge_accounts drop constraint %I', c.conname);
  end loop;
  alter table public.concierge_accounts
    add constraint concierge_accounts_tenant_type_chk
    check (tenant_type in ('concierge','funeral_home','church'));
end $$;

-- 2) Funeral homes & churches get an UNLIMITED family cap. A high sentinel keeps
--    every existing cap check (estates_used >= estate_limit) working untouched;
--    the admin UI labels it "Unlimited". The trigger fires on insert and on tier
--    change, so provisioning and tier edits can't accidentally cap a co-brand
--    partner — while a direct admin estate_limit edit is still respected (so an
--    abusive free account can be throttled by hand).
create or replace function public.enforce_cobrand_unlimited()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.tenant_type in ('funeral_home','church') then
    new.estate_limit := 1000000000;   -- effectively unlimited
  end if;
  return new;
end $$;

drop trigger if exists trg_cobrand_unlimited on public.concierge_accounts;
create trigger trg_cobrand_unlimited
  before insert or update of tenant_type, tier on public.concierge_accounts
  for each row execute function public.enforce_cobrand_unlimited();

-- 3) Backfill any co-brand accounts that already exist.
update public.concierge_accounts
   set estate_limit = 1000000000
 where tenant_type in ('funeral_home','church')
   and estate_limit is distinct from 1000000000;

-- Verify (optional):
-- select tenant_type, count(*), min(estate_limit), max(estate_limit)
--   from public.concierge_accounts group by tenant_type;
